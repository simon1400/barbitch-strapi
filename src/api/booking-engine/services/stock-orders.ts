// @ts-nocheck
/**
 * «Sklad — zásoby», Фаза 2 (s252, план STOCK_NEXT_SESSION_PROMPT.md §7; решения владельца §0.3, §0.5).
 *
 * Заказ расходников (`stock-order`): draft → sent → received (или cancelled).
 *   • Заказывают владелец и управляющая (§0.3): «Vytvořit objednávku» из «Co objednat» → правка
 *     строк → «Objednáno» (текст скопирован поставщику, писем система не шлёт).
 *   • «Přijato» — все три роли: остатки растут сразу (движение `in` с `orderDocId`), приход может
 *     быть частичным (`receivedPacks` по строкам; «objednávka je kompletní» закрывает заказ).
 *   • Деньги (§0.5): владелец/управляющая принимают → затрата «Материалы» сразу; администратор
 *     принимает → ЗАПРОС на затрату (`cost-request` action `create`), одобряет сначала управляющая,
 *     потом владелец (services/costs.ts). Сумму администратор вводит, но после сохранения не видит.
 *     Без суммы («částku nevím») — приход без затраты, у руководства пометка «Náklad nezapsán»
 *     и кнопка «Zapsat náklad» — ни одна покупка не теряется.
 *   • 🟥 Администратору цены строк, суммы заказа и приходов не отдаются вовсе (`showPrices`).
 *
 * Каждый приход — запись в `receipts[]` заказа: кто, когда, какие строки, затрата или запрос
 * (`cost.mode` cost | request | none, `cost.status` recorded | pending | approved | rejected | none | failed).
 * Заказ пишется условным UPDATE по `version` (двойное «Přijato» не задвоит приход: второе — 409).
 * Журнал — calendar_logs, entityType `stock`, действия `stock_order_*`.
 *
 * Верх файла — чистые функции (tests/stock-orders.test.mjs), ниже — сервис.
 */

import { pragueDateOf } from './slots-core';
import {
  ITEM_UID,
  MAX_NOTE,
  MAX_PACKS,
  MAX_PRICE,
  MAX_SUPPLIER,
  StockError,
  cleanStr,
  computeMove,
  daysBetween,
  intIn,
  n0,
  numIn,
  orderText,
  packOf,
  r2,
} from './stock';

export const ORDER_UID = 'api::stock-order.stock-order';

export const ORDER_STATUSES = { draft: 'Koncept', sent: 'Objednáno', received: 'Přijato', cancelled: 'Zrušeno' } as const;
export const OPEN_STATUSES = ['draft', 'sent'];
/** Способ оплаты — те же ключи, что у затрат (`cost.payment`). */
export const PAYMENTS = ['card', 'cash', 'transfer', 'owner'] as const;
/** Ставка DPH прихода — сумма без DPH считается из неё (как в форме затрат). */
export const VATS = [21, 12, 0] as const;
export const COST_CATEGORY = 'Материалы';

export const MAX_LINES = 60;
export const DEFAULT_EXPECTED_DAYS = 7;
export const MAX_EXPECTED_DAYS = 60;
/** Закрытые заказы в списке — за столько дней (руководство / администратор). */
export const CLOSED_DAYS_EDIT = 60;
export const CLOSED_DAYS_ADMIN = 14;
export const MAX_ORDERS = 200;

const DOC_ID = /^[a-z0-9]{10,40}$/;
const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const DAY = 86400000;

const noteOf = (v: unknown, label = 'Poznámka'): string => {
  if (v != null && typeof v !== 'string') throw new StockError(400, 'bad_note', `${label}: neplatný formát`);
  const note = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (note.length > MAX_NOTE) throw new StockError(400, 'bad_note', `${label}: nejvýše ${MAX_NOTE} znaků`);
  return note;
};

/**
 * Строки заказа: позиция (активная, из `items`), упаковок 1…MAX_PACKS, цена упаковки — по желанию.
 * В заказ кладётся снимок названия, упаковки и единицы (позицию потом могут переименовать).
 */
export const normalizeLines = (raw: unknown, items: Map<string, any>) => {
  if (!Array.isArray(raw) || !raw.length) throw new StockError(400, 'lines_required', 'Přidejte do objednávky aspoň jednu položku');
  if (raw.length > MAX_LINES) throw new StockError(400, 'too_many_lines', `Nejvýše ${MAX_LINES} položek v objednávce`);
  const seen = new Set<string>();
  return raw.map((l: any) => {
    const itemDocId = String(l?.itemDocId ?? '').trim();
    const item = items.get(itemDocId);
    if (!item) throw new StockError(400, 'unknown_item', 'Položka nenalezena nebo je archivovaná');
    if (seen.has(itemDocId)) throw new StockError(400, 'duplicate_line', `${item.name}: v objednávce dvakrát`);
    seen.add(itemDocId);
    const packs = intIn(l?.packs, 1, MAX_PACKS, 'bad_packs', `${item.name}: počet balení`);
    const price = l?.price == null || l?.price === '' ? null : numIn(l.price, 0, MAX_PRICE, 'bad_price', `${item.name}: cena balení`);
    return {
      itemDocId,
      name: String(item.name ?? ''),
      packSize: packOf(item),
      unit: ['ks', 'ml', 'g'].includes(item.unit) ? item.unit : 'ks',
      packs,
      receivedPacks: 0,
      price,
    };
  });
};

/** Поля заказа от руководства; `partial` — правка (меняется только присланное). */
export const normalizeOrderInput = (body: any, items: Map<string, any>, { partial = false }: { partial?: boolean } = {}) => {
  const out: any = {};
  const take = (k: string) => !partial || has(body, k);
  if (take('supplier')) out.supplier = cleanStr(body?.supplier, MAX_SUPPLIER, 'bad_supplier', 'Dodavatel');
  if (take('note')) out.note = noteOf(body?.note);
  if (take('expectedDays')) {
    out.expectedDays =
      body?.expectedDays == null || body?.expectedDays === ''
        ? DEFAULT_EXPECTED_DAYS
        : intIn(body.expectedDays, 1, MAX_EXPECTED_DAYS, 'bad_expected_days', 'Dodání do (dní)');
  }
  if (take('payment')) {
    const p = String(body?.payment ?? '').trim();
    if (p && !PAYMENTS.includes(p as any)) throw new StockError(400, 'bad_payment', 'Neplatný způsob platby');
    out.payment = p || null;
  }
  if (take('lines')) out.lines = normalizeLines(body?.lines, items);
  if (partial && !Object.keys(out).length) throw new StockError(400, 'nothing_to_change', 'Není co měnit');
  return out;
};

const linesOf = (doc: any): any[] => (Array.isArray(doc?.lines) ? doc.lines : []);
const receiptsOf = (doc: any): any[] => (Array.isArray(doc?.receipts) ? doc.receipts : []);
const remainingOf = (l: any): number => Math.max(0, Math.floor(n0(l?.packs)) - Math.floor(n0(l?.receivedPacks)));

/** Отправлен и не пришёл дольше `expectedDays` (по пражским дням). */
export const isOverdue = (doc: any, now: Date): boolean =>
  doc?.status === 'sent' && !!doc?.sentAt && daysBetween(doc.sentAt, now) > (Math.floor(n0(doc.expectedDays)) || DEFAULT_EXPECTED_DAYS);

/** Упаковки, которые ещё должны прийти по открытым заказам: itemDocId → сколько. */
export const openPacksOf = (orders: any[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const o of orders) {
    if (!OPEN_STATUSES.includes(o?.status)) continue;
    for (const l of linesOf(o)) {
      const rest = remainingOf(l);
      if (rest > 0) out.set(l.itemDocId, (out.get(l.itemDocId) || 0) + rest);
    }
  }
  return out;
};

/** У прихода нет затраты (не ввели сумму, отклонили запрос или запись упала) — руководству «Zapsat náklad». */
export const receiptNeedsCost = (r: any): boolean => ['none', 'rejected', 'failed'].includes(r?.cost?.status);

const receiptView = (r: any, index: number, showPrices: boolean) => {
  const cost = r?.cost && typeof r.cost === 'object' ? r.cost : { mode: 'none', status: 'none' };
  const out: any = {
    index,
    at: r?.at || null,
    by: r?.by || '',
    role: r?.role || '',
    note: r?.note || '',
    complete: !!r?.complete,
    lines: (Array.isArray(r?.lines) ? r.lines : []).map((l) => ({ itemDocId: l.itemDocId, name: l.name, packs: Math.floor(n0(l.packs)) })),
    cost: { mode: cost.mode || 'none', status: cost.status || 'none' },
    needsCost: receiptNeedsCost(r),
  };
  if (showPrices) {
    out.sum = r?.sum == null ? null : r2(n0(r.sum));
    out.cost.costDocId = cost.costDocId || null;
    out.cost.requestDocId = cost.requestDocId || null;
  }
  return out;
};

/** Заказ для ответа. 🟥 Администратору — без цен строк, сумм заказа и приходов. */
export const orderView = (doc: any, { now, showPrices }: { now: Date; showPrices: boolean }) => {
  const status = has(ORDER_STATUSES, doc?.status) ? doc.status : 'draft';
  const lines = linesOf(doc).map((l) => {
    const line: any = {
      itemDocId: l.itemDocId,
      name: String(l.name ?? ''),
      packSize: Math.max(1, Math.floor(n0(l.packSize)) || 1),
      unit: l.unit || 'ks',
      packs: Math.floor(n0(l.packs)),
      receivedPacks: Math.floor(n0(l.receivedPacks)),
      remainingPacks: remainingOf(l),
    };
    if (showPrices) {
      line.price = l.price == null ? null : r2(n0(l.price));
      line.sum = line.price == null ? null : r2(line.price * line.packs);
    }
    return line;
  });
  const receipts = receiptsOf(doc).map((r, i) => receiptView(r, i, showPrices));
  const out: any = {
    documentId: doc.documentId,
    status,
    statusLabel: ORDER_STATUSES[status],
    supplier: String(doc.supplier ?? ''),
    note: String(doc.note ?? ''),
    expectedDays: Math.floor(n0(doc.expectedDays)) || DEFAULT_EXPECTED_DAYS,
    payment: doc.payment || null,
    lines,
    text: orderText({ supplier: String(doc.supplier ?? ''), lines }),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    createdBy: doc.createdByName || '',
    sentAt: doc.sentAt ? new Date(doc.sentAt).toISOString() : null,
    sentBy: doc.sentBy || '',
    receivedAt: doc.receivedAt ? new Date(doc.receivedAt).toISOString() : null,
    closedBy: doc.closedBy || '',
    daysSinceSent: doc.sentAt ? daysBetween(doc.sentAt, now) : null,
    overdue: isOverdue({ ...doc, status }, now),
    remainingPacks: lines.reduce((s, l) => s + l.remainingPacks, 0),
    receipts,
    needsCost: receipts.some((r) => r.needsCost),
    costPending: receipts.some((r) => r.cost.status === 'pending'),
  };
  if (showPrices) {
    const known = lines.filter((l) => l.sum != null);
    out.sum = known.length ? r2(known.reduce((s, l) => s + l.sum, 0)) : null;
    out.sumPartial = known.length > 0 && known.length < lines.length;
  }
  return out;
};

/**
 * «Přijato»: сколько упаковок пришло по строкам (0 — эта строка не пришла). Хотя бы одна > 0.
 * Пришло больше заказанного — допустимо (поставщик доложил). Заказ закрывается, когда пришло всё
 * или принимающий отметил «objednávka je kompletní» (остальное не придёт).
 */
export const receivePlan = (order: any, body: any) => {
  const lines = linesOf(order);
  if (!Array.isArray(body?.lines)) throw new StockError(400, 'lines_required', 'Zadejte, co přišlo');
  const add = new Map<string, number>();
  for (const l of body.lines) {
    const id = String(l?.itemDocId ?? '');
    const line = lines.find((x) => x.itemDocId === id);
    if (!line) throw new StockError(400, 'unknown_line', 'Položka v objednávce není');
    if (add.has(id)) throw new StockError(400, 'duplicate_line', `${line.name}: dvakrát`);
    add.set(id, l?.packs == null || l?.packs === '' ? 0 : intIn(l.packs, 0, MAX_PACKS, 'bad_packs', `${line.name}: počet balení`));
  }
  const received = lines
    .filter((l) => (add.get(l.itemDocId) || 0) > 0)
    .map((l) => ({ itemDocId: l.itemDocId, name: String(l.name ?? ''), packs: add.get(l.itemDocId) }));
  if (!received.length) throw new StockError(400, 'nothing_received', 'Zadejte, co přišlo (aspoň jedno balení)');
  const nextLines = lines.map((l) => ({ ...l, receivedPacks: Math.floor(n0(l.receivedPacks)) + (add.get(l.itemDocId) || 0) }));
  const allIn = nextLines.every((l) => l.receivedPacks >= Math.floor(n0(l.packs)));
  return { received, nextLines, complete: allIn || body?.complete === true };
};

/** Сумма без DPH по ставке — как сервер затрат (`noDphFor`). */
const noDphFor = (sum: number, vat: number): number => (vat ? Math.round(sum / (1 + vat / 100)) : sum);

const parseKc = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
};

/**
 * Затрата прихода из формы → тело для services/costs (проверяет оно же: сумма, оплата, дата).
 * null / false — без затраты. Название по умолчанию — «Sklad — <поставщик>», категория «Материалы»,
 * оплата — заданная в заказе или карта салона, комментарий — что пришло.
 */
export const receiptCostDraft = (
  cost: any,
  { today, supplier, payment, received }: { today: string; supplier: string; payment?: string | null; received: { name: string; packs: number }[] }
) => {
  if (cost == null || cost === false) return null;
  if (typeof cost !== 'object' || Array.isArray(cost)) throw new StockError(400, 'bad_cost', 'Neplatná částka');
  const vat = cost.vat == null || cost.vat === '' ? 21 : Number(cost.vat);
  if (!VATS.includes(vat as any)) throw new StockError(400, 'bad_vat', 'Neplatná sazba DPH');
  const sum = parseKc(cost.sum);
  const what = received.map((l) => `${l.name} ${l.packs}×`).join(', ');
  return {
    date: String(cost.date ?? '').trim() || today,
    name: String(cost.name ?? '').replace(/\s+/g, ' ').trim() || `Sklad — ${supplier || 'nákup'}`,
    category: String(cost.category ?? '').trim() || COST_CATEGORY,
    sum,
    noDph: Number.isFinite(sum) ? noDphFor(sum, vat) : 0,
    payment: String(cost.payment ?? '').trim() || payment || 'card',
    comment: `Objednávka ze skladu: ${what}`.slice(0, 500),
  };
};

/** Порядок списка: открытые (просроченные первыми), черновики, затем закрытые — свежие сверху. */
const RANK = { sent: 0, draft: 1, received: 2, cancelled: 3 };
export const sortOrders = (views: any[]) =>
  [...views].sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      Number(b.overdue) - Number(a.overdue) ||
      String(b.receivedAt || b.sentAt || b.createdAt || '').localeCompare(String(a.receivedAt || a.sentAt || a.createdAt || ''))
  );

const ORDER_FIELDS = [
  'status', 'supplier', 'lines', 'receipts', 'note', 'expectedDays', 'payment', 'createdByName', 'createdByRole',
  'sentAt', 'sentBy', 'receivedAt', 'closedBy', 'version', 'createdAt', 'updatedAt',
];
const notFound = () => new StockError(404, 'order_not_found', 'Objednávka nenalezena');

export default {
  _stock() {
    return strapi.service('api::booking-engine.stock');
  },
  _costs() {
    return strapi.service('api::booking-engine.costs');
  },
  _who(session: any) {
    return this._stock()._who(session);
  },

  _log(action: string, session: any, order: any, summary: string, details: any = {}) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({ action, entityType: 'stock', actorName: session?.username || '', entityDocId: order?.documentId || '', summary, details })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  async _find(id: unknown) {
    const documentId = String(id ?? '').trim();
    if (!DOC_ID.test(documentId)) throw notFound();
    const doc = await strapi.documents(ORDER_UID).findOne({ documentId, fields: ORDER_FIELDS });
    if (!doc) throw notFound();
    return doc;
  },

  /** Активные позиции склада: documentId → документ. */
  async _items() {
    const rows = await this._stock()._all();
    return new Map(rows.map((r) => [r.documentId, r]));
  },

  /** Условная запись заказа по `version`; 0 строк — заказ только что изменил кто-то другой. */
  async _write(order: any, data: any, now: Date) {
    const v = Number.isInteger(order.version) ? order.version : null;
    const res = await strapi.db.query(ORDER_UID).updateMany({
      where: { documentId: order.documentId, version: v == null ? { $null: true } : v },
      data: { ...data, version: (v ?? 0) + 1, updatedAt: now },
    });
    if (!res || !res.count) throw new StockError(409, 'order_busy', 'Objednávku právě změnil někdo jiný — obnovte stránku');
  },

  /** Поменять затрату одного прихода (повтор при гонке). Сбой — в лог: остатки и затрата уже записаны. */
  async _patchReceipt(orderDocId: string, index: number, patch: any, now: Date) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const order = await strapi.documents(ORDER_UID).findOne({ documentId: orderDocId, fields: ORDER_FIELDS });
      if (!order) return false;
      const receipts = receiptsOf(order).map((r) => ({ ...r }));
      if (!receipts[index]) return false;
      receipts[index] = { ...receipts[index], ...patch, cost: { ...(receipts[index].cost || {}), ...(patch.cost || {}) } };
      try {
        await this._write(order, { receipts }, now);
        return true;
      } catch (e) {
        if (e?.code !== 'order_busy') throw e;
      }
    }
    strapi.log.error(`stock-orders: приход ${orderDocId}#${index} не обновлён (занято)`);
    return false;
  },

  _meta(who: any, now: Date) {
    return {
      today: pragueDateOf(now),
      role: who.role,
      canEdit: who.canEdit,
      showPrices: who.showPrices,
      statuses: Object.entries(ORDER_STATUSES).map(([key, label]) => ({ key, label })),
      payments: [...PAYMENTS],
      vats: [...VATS],
    };
  },

  async _view(id: string, who: any, now: Date) {
    return orderView(await this._find(id), { now, showPrices: who.showPrices });
  },

  /** Открытые заказы (для «Co objednat», карточек, напоминаний). */
  async _open() {
    return strapi.documents(ORDER_UID).findMany({ filters: { status: { $in: OPEN_STATUSES } }, fields: ORDER_FIELDS, limit: MAX_ORDERS });
  },

  /** itemDocId → упаковок ещё в пути (stock.ts вычитает из «Co objednat»). */
  async openPacks() {
    return openPacksOf(await this._open());
  },

  /**
   * GET /stock/orders — руководство: черновики, отправленные и закрытые за CLOSED_DAYS_EDIT дней;
   * администратор: отправленные (их принимать) и принятые за CLOSED_DAYS_ADMIN дней — без цен.
   */
  async list({ session, now = new Date() }: { session: any; now?: Date }) {
    const who = this._who(session);
    const since = new Date(now.getTime() - (who.canEdit ? CLOSED_DAYS_EDIT : CLOSED_DAYS_ADMIN) * DAY).toISOString();
    const rows = await strapi.documents(ORDER_UID).findMany({
      filters: {
        $or: [
          { status: { $in: who.canEdit ? OPEN_STATUSES : ['sent'] } },
          { status: { $in: who.canEdit ? ['received', 'cancelled'] : ['received'] }, updatedAt: { $gte: since } },
        ],
      },
      fields: ORDER_FIELDS,
      sort: [{ createdAt: 'desc' }],
      limit: MAX_ORDERS,
    });
    return { orders: sortOrders(rows.map((d) => orderView(d, { now, showPrices: who.showPrices }))), meta: this._meta(who, now) };
  },

  /** POST /stock/orders — новый заказ (руководство); `status: 'sent'` — сразу «objednáno». */
  async create({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const who = this._who(session);
    this._stock()._requireEdit(who);
    const input = normalizeOrderInput(body, await this._items());
    const send = body?.status === 'sent';
    const by = session?.username || '';
    const doc = await strapi.documents(ORDER_UID).create({
      data: {
        ...input,
        status: send ? 'sent' : 'draft',
        receipts: [],
        createdByName: by,
        createdByRole: who.role,
        ...(send ? { sentAt: now, sentBy: by } : {}),
        version: 1,
      },
    });
    this._log(
      'stock_order_create',
      session,
      doc,
      `Sklad: ${send ? 'objednáno' : 'nová objednávka'} — ${input.supplier || 'bez dodavatele'} · ${input.lines.length} položek`,
      { status: send ? 'sent' : 'draft', lines: input.lines.length }
    );
    return { order: await this._view(doc.documentId, who, now) };
  },

  /** PATCH /stock/orders/:id — правка открытого заказа, пока по нему ничего не пришло (руководство). */
  async update({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const who = this._who(session);
    this._stock()._requireEdit(who);
    const order = await this._find(id);
    if (!OPEN_STATUSES.includes(order.status)) throw new StockError(409, 'order_closed', 'Objednávka je uzavřená');
    if (receiptsOf(order).length) throw new StockError(409, 'order_has_receipts', 'Část objednávky už přišla — měnit ji nejde');
    const input = normalizeOrderInput(body, await this._items(), { partial: true });
    await this._write(order, input, now);
    this._log('stock_order_edit', session, order, `Sklad: objednávka upravena — ${input.supplier ?? order.supplier ?? ''}`.trim(), {
      fields: Object.keys(input),
    });
    return { order: await this._view(order.documentId, who, now) };
  },

  /** POST /stock/orders/:id/send — «Objednáno» (руководство). */
  async send({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    const who = this._who(session);
    this._stock()._requireEdit(who);
    const order = await this._find(id);
    if (order.status !== 'draft') throw new StockError(409, 'order_not_draft', 'Objednávka už byla odeslána nebo uzavřena');
    await this._write(order, { status: 'sent', sentAt: now, sentBy: session?.username || '' }, now);
    this._log('stock_order_send', session, order, `Sklad: objednáno — ${order.supplier || 'bez dodavatele'} · ${linesOf(order).length} položek`);
    return { order: await this._view(order.documentId, who, now) };
  },

  /**
   * POST /stock/orders/:id/close — руководство. Ничего не пришло — заказ отменён; часть пришла —
   * заказ закрыт как принятый («zbytek nepřijde»).
   */
  async close({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    const who = this._who(session);
    this._stock()._requireEdit(who);
    const order = await this._find(id);
    if (!OPEN_STATUSES.includes(order.status)) throw new StockError(409, 'order_closed', 'Objednávka je už uzavřená');
    const partial = receiptsOf(order).length > 0;
    const by = session?.username || '';
    await this._write(order, partial ? { status: 'received', receivedAt: now, closedBy: by } : { status: 'cancelled', closedBy: by }, now);
    this._log(
      partial ? 'stock_order_close' : 'stock_order_cancel',
      session,
      order,
      `Sklad: objednávka ${partial ? 'uzavřena (zbytek nepřijde)' : 'zrušena'} — ${order.supplier || 'bez dodavatele'}`
    );
    return { order: await this._view(order.documentId, who, now) };
  },

  /**
   * POST /stock/orders/:id/receive {lines: [{itemDocId, packs}], complete?, note?, cost?: {sum, vat?, payment?, date?, name?, category?} | null}
   * Все три роли (администратор — только отправленный заказ). Порядок: проверки (в т. ч. затраты) →
   * условная запись заказа (двойное нажатие — 409) → остатки → затрата или запрос на неё.
   */
  async receive({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const who = this._who(session);
    const order = await this._find(id);
    if (!(order.status === 'sent' || (order.status === 'draft' && who.canEdit))) {
      throw new StockError(409, 'order_not_open', 'Objednávka není otevřená');
    }
    const plan = receivePlan(order, body);
    const note = noteOf(body?.note);
    const supplier = String(order.supplier ?? '');
    const today = pragueDateOf(now);
    const draft = receiptCostDraft(body?.cost, { today, supplier, payment: order.payment, received: plan.received });
    // затрату проверяем ДО записи: иначе остатки выросли бы, а затрата упала на проверке
    if (draft) this._costs().checkInput({ body: draft, now });
    const items = await this._items();
    for (const l of plan.received) {
      if (!items.has(l.itemDocId)) throw new StockError(409, 'item_archived', `${l.name}: položka je archivovaná — přijměte bez ní`);
    }

    const by = session?.username || '';
    const receipt: any = {
      at: now.toISOString(),
      by,
      role: who.role,
      lines: plan.received,
      complete: plan.complete,
      note,
      cost: draft ? { mode: who.canEdit ? 'cost' : 'request', status: 'pending' } : { mode: 'none', status: 'none' },
      sum: draft ? draft.sum : null,
    };
    const receipts = [...receiptsOf(order), receipt];
    const index = receipts.length - 1;
    await this._write(
      order,
      {
        lines: plan.nextLines,
        receipts,
        ...(plan.complete ? { status: 'received', receivedAt: now } : order.status === 'draft' ? { status: 'sent', sentAt: now, sentBy: by } : {}),
      },
      now
    );

    // остатки: каждая строка — обычный приход с отметкой заказа
    const failed: string[] = [];
    for (const l of plan.received) {
      try {
        await this._stock()._moveWithRetry(l.itemDocId, (item) => computeMove(item, { kind: 'in', packs: l.packs }), {
          session,
          role: who.role,
          note: `Objednávka${supplier ? ` — ${supplier}` : ''}`,
          orderDocId: order.documentId,
          now,
        });
      } catch (e) {
        failed.push(l.name);
        strapi.log.error(`stock-orders: приход ${l.name} по заказу ${order.documentId} не записан: ${e?.message || e}`);
      }
    }

    // деньги: руководство — затрата сразу, администратор — запрос (одобряют управляющая → владелец)
    let costError: string | null = null;
    if (draft) {
      try {
        if (who.canEdit) {
          const { row } = await this._costs().create({ session, body: draft, now });
          await this._patchReceipt(order.documentId, index, { cost: { mode: 'cost', status: 'recorded', costDocId: row.documentId } }, now);
        } else {
          const { request } = await this._costs().requestCreate({ session, body: draft, source: { kind: 'stock-order', docId: order.documentId }, now });
          await this._patchReceipt(order.documentId, index, { cost: { mode: 'request', status: 'pending', requestDocId: request.id } }, now);
        }
      } catch (e) {
        costError = e?.message || String(e);
        strapi.log.error(`stock-orders: затрата прихода ${order.documentId}#${index} не записана: ${costError}`);
        await this._patchReceipt(order.documentId, index, { cost: { mode: 'none', status: 'failed' } }, now);
      }
    }

    const what = plan.received.map((l) => `${l.name} ${l.packs}×`).join(', ');
    const money = !draft ? 'bez nákladu' : who.canEdit ? 'náklad zapsán' : 'náklad ke schválení';
    this._log(
      'stock_order_receive',
      session,
      order,
      `Sklad: přijato — ${supplier || 'bez dodavatele'}: ${what.slice(0, 200)}${plan.complete ? '' : ' (část)'} · ${money}`,
      { lines: plan.received.length, complete: plan.complete, cost: receipt.cost.mode }
    );
    return { order: await this._view(order.documentId, who, now), receipt: index, failed, costError };
  },

  /** POST /stock/orders/:id/cost {receipt, cost} — руководство: затрата к приходу без неё. */
  async addCost({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const who = this._who(session);
    this._stock()._requireEdit(who);
    const order = await this._find(id);
    const receipts = receiptsOf(order);
    const index = body?.receipt == null || body?.receipt === '' ? receipts.length - 1 : Math.floor(Number(body.receipt));
    const r = receipts[index];
    if (!r) throw new StockError(404, 'receipt_not_found', 'Příjem nenalezen');
    if (!receiptNeedsCost(r)) throw new StockError(409, 'cost_exists', 'Náklad k tomuto příjmu už je');
    const draft = receiptCostDraft(body?.cost, { today: pragueDateOf(now), supplier: String(order.supplier ?? ''), payment: order.payment, received: r.lines || [] });
    if (!draft) throw new StockError(400, 'bad_cost', 'Zadejte částku');
    const { row } = await this._costs().create({ session, body: draft, now });
    await this._patchReceipt(order.documentId, index, { sum: draft.sum, cost: { mode: 'cost', status: 'recorded', costDocId: row.documentId } }, now);
    this._log('stock_order_cost', session, order, `Sklad: náklad k příjmu — ${order.supplier || 'bez dodavatele'}`, { receipt: index });
    return { order: await this._view(order.documentId, who, now) };
  },

  /**
   * POST /stock/orders/:id/file?receipt= — фото чека к приходу (все три роли): к затрате прихода
   * или, пока запрос ждёт одобрения, к запросу (при одобрении переедет к затрате).
   */
  async uploadFile({ session, id, receipt, files }: { session: any; id: unknown; receipt?: unknown; files: any }) {
    this._who(session);
    const order = await this._find(id);
    const receipts = receiptsOf(order);
    const index = receipt == null || receipt === '' ? receipts.length - 1 : Math.floor(Number(receipt));
    const r = receipts[index];
    if (!r) throw new StockError(404, 'receipt_not_found', 'Příjem nenalezen');
    const cost = r.cost || {};
    if (cost.costDocId) return this._costs().attachFile({ session, costDocId: cost.costDocId, files });
    if (cost.requestDocId) return this._costs().attachFile({ session, requestDocId: cost.requestDocId, files });
    throw new StockError(409, 'no_cost', 'K příjmu není náklad — doklad nahrajte po zapsání nákladu');
  },

  /** costs.ts: запрос на затрату прихода решён — отметка в приходе (сбой не мешает одобрению). */
  async onRequestDecided({ orderDocId, requestDocId, status, costDocId = null, now = new Date() }) {
    const order = await strapi.documents(ORDER_UID).findOne({ documentId: orderDocId, fields: ORDER_FIELDS });
    if (!order) return false;
    const index = receiptsOf(order).findIndex((r) => r?.cost?.requestDocId === requestDocId);
    if (index < 0) return false;
    return this._patchReceipt(orderDocId, index, { cost: { status, ...(costDocId ? { costDocId } : {}) } }, now);
  },

  /** Отправленные и не пришедшие дольше `expectedDays` — для напоминаний. */
  async overdue(now = new Date()) {
    return (await this._open())
      .filter((o) => isOverdue(o, now))
      .map((o) => ({ documentId: o.documentId, supplier: String(o.supplier ?? ''), sentAt: o.sentAt, days: daysBetween(o.sentAt, now), lines: linesOf(o).length }));
  },

  /** Карточки «Сегодня» и кабинета: ждут прихода, просрочены; руководству — черновики и приходы без затраты. */
  async attention({ now = new Date(), canEdit }: { now?: Date; canEdit: boolean }) {
    const since = new Date(now.getTime() - CLOSED_DAYS_EDIT * DAY).toISOString();
    const [open, recent] = await Promise.all([
      this._open(),
      canEdit
        ? strapi.documents(ORDER_UID).findMany({ filters: { status: { $in: ['received', 'sent'] }, updatedAt: { $gte: since } }, fields: ORDER_FIELDS, limit: MAX_ORDERS })
        : Promise.resolve([]),
    ]);
    const sent = open.filter((o) => o.status === 'sent');
    const out: any = {
      waiting: sent.length,
      overdue: sent
        .filter((o) => isOverdue(o, now))
        .map((o) => ({ documentId: o.documentId, supplier: String(o.supplier ?? ''), days: daysBetween(o.sentAt, now) })),
    };
    if (canEdit) {
      out.drafts = open.filter((o) => o.status === 'draft').length;
      out.needsCost = recent.filter((o) => receiptsOf(o).some(receiptNeedsCost)).length;
    }
    return out;
  },
};
