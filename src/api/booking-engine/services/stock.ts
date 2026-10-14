// @ts-nocheck
/**
 * «Sklad — zásoby» (s251, Фаза 1 плана STOCK_NEXT_SESSION_PROMPT.md; решения владельца §0 от 13.10).
 *
 * Учёт расходников вместо Google-таблицы администраторов:
 *   • позиция (`stock-item`): название, категория, место, единица и размер упаковки, остаток,
 *     минимум и «докупать до» (в упаковках), поставщик, ссылка, цена упаковки, ритм пересчёта;
 *   • движение (`stock-move`): пересчёт (`count`), приход (`in`), «došlo / málo» (`out`),
 *     стартовый остаток новой позиции (`create`) — кто, когда, сколько было и стало.
 *
 * Принципы (§3): статус НЕ хранится — выводится из остатка и минимума (`statusOf`); список
 * «Co objednat» строится сам (`suggestedPacks`, `orderGroups`); остаток — в базовой единице
 * (штуки / ml / g), показывается как «2 bal. + 5 ks» (`fmtQty`) — начатые упаковки поддержаны.
 *
 * Кто что может (§0.2): смотреть, считать, отмечать приход и «došlo» — owner, manager,
 * administrator; позиции, минимумы, поставщиков — с s257 тоже все три (решение владельца 13.10),
 * цены — только owner и manager (администратору поле цены не принимается и не отдаётся).
 * 🟥 Администратору цены не отдаются вовсе (`itemView(…, {showPrices: false})`).
 *
 * Коллекции без REST-роутов. Остаток пишется условным UPDATE по `version` (до трёх попыток:
 * приход двух администраторов одновременно не теряется). Журнал — calendar_logs, entityType `stock`.
 *
 * Фаза 2 (s252): заказы (`stock-order`, services/stock-orders.ts) — «Co objednat» вычитает то, что
 * уже заказано и не пришло (`onOrderPacks`); еженедельная «Rychlá inventura» по понедельникам
 * (`inventoryDueOf`); пуши и напоминания — services/stock-notify.ts (`notifiedStatus` позиции —
 * о каком статусе управляющая уже знает). Приход по заказу — тот же путь записи остатка
 * (`_moveWithRetry`), с `orderDocId` в движении.
 *
 * Верх файла — чистые функции (tests/stock.test.mjs), ниже — сервис.
 */

import { pragueDateOf } from './slots-core';

export class StockError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ITEM_UID = 'api::stock-item.stock-item';
export const MOVE_UID = 'api::stock-move.stock-move';
/** Старая коллекция «Склад» (мертва с 05.2026) — только словарь названий для автодополнения. */
export const LEGACY_UID = 'api::stock.stock';

export const STOCK_ROLES = ['owner', 'manager', 'administrator'];
export const EDIT_ROLES = ['owner', 'manager'];

/** Категории; `later` — заложены в схему, но в Фазе 1 не заводятся (§0.4). */
export const CATEGORIES = [
  { key: 'hygiena', label: 'Hygiena' },
  { key: 'uklid', label: 'Úklid' },
  { key: 'kuchyn', label: 'Kuchyň' },
  { key: 'kancelar', label: 'Kancelář' },
  { key: 'jine', label: 'Jiné' },
  { key: 'nehty', label: 'Nehty', later: true },
  { key: 'rasy', label: 'Řasy', later: true },
  { key: 'oboci', label: 'Obočí', later: true },
] as const;
export const UNITS = [
  { key: 'ks', label: 'ks' },
  { key: 'ml', label: 'ml' },
  { key: 'g', label: 'g' },
] as const;
export const STATUSES = { ok: 'Skladem', low: 'Málo', out: 'Došlo' } as const;
export const MOVE_KINDS = { create: 'Nová položka', count: 'Spočítáno', in: 'Přišlo', out: 'Došlo', adjust: 'Oprava' } as const;
/** Места из таблицы администраторов — подсказки, пока своих позиций нет. */
export const DEFAULT_LOCATIONS = ['U dezinfekce', 'Kuchyň', 'Skříň s laky', 'Recepce', 'WC', 'Pracovní místa'];

export const MAX_NAME = 120;
export const MAX_LOCATION = 80;
export const MAX_SUPPLIER = 80;
export const MAX_URL = 500;
export const MAX_NOTE = 500;
export const MAX_PACK_SIZE = 100000;
export const MAX_PACKS = 10000;
export const MAX_QTY = 1000000;
export const MAX_PRICE = 1000000;
export const DEFAULT_COUNT_EVERY = 7;
export const MAX_ITEMS = 1000;
export const MAX_MOVES_PAGE = 200;

const DOC_ID = /^[a-z0-9]{10,40}$/;
const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const CAT_KEYS = new Set(CATEGORIES.map((c) => c.key));
const UNIT_KEYS = new Set(UNITS.map((u) => u.key));

/** Округление до сотых (ml/g бывают дробными; decimal в базе). */
export const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
export const n0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const packOf = (item: any): number => {
  const p = Math.floor(n0(item?.packSize));
  return p >= 1 ? p : 1;
};
const unitOf = (item: any): string => (UNIT_KEYS.has(item?.unit) ? item.unit : 'ks');

const numText = (n: number): string => String(r2(n)).replace('.', ',');

/**
 * Количество текстом: «2 bal. + 5 ks», «3 bal.», «40 ml», «0 ks».
 * Упаковки показываются только при `packSize > 1`.
 */
export const fmtQty = (qty: unknown, packSize: unknown = 1, unit: unknown = 'ks'): string => {
  const q = Math.max(0, r2(n0(qty)));
  const p = packOf({ packSize });
  const u = UNIT_KEYS.has(unit as string) ? (unit as string) : 'ks';
  if (p <= 1) return `${numText(q)} ${u}`;
  const packs = Math.floor(q / p + 1e-9);
  const rest = r2(q - packs * p);
  const parts = [];
  if (packs > 0) parts.push(`${packs} bal.`);
  if (rest > 0) parts.push(`${numText(rest)} ${u}`);
  return parts.length ? parts.join(' + ') : `0 ${u}`;
};

/** Минимум и «doplnit do» в упаковках: у штучных целые, у ml/g дробные (s258: канистра — min 0,2). */
export const packsOf = (v: unknown, item: any): number => {
  const n = Math.max(0, n0(v));
  return unitOf(item) === 'ks' ? Math.floor(n) : r2(n);
};

/** Минимум в базовой единице. */
export const minBase = (item: any): number => r2(packsOf(item?.min, item) * packOf(item));

/** Статус из остатка: ≤ 0 — došlo, ≤ минимума — málo, иначе skladem. */
export const statusOf = (item: any): 'ok' | 'low' | 'out' => {
  const q = r2(n0(item?.qty));
  if (q <= 0) return 'out';
  if (q <= minBase(item)) return 'low';
  return 'ok';
};

/** «Докупать до» в упаковках: заданный target или, если не задан, двойной минимум (не меньше минимум + 1). */
export const effectiveTarget = (item: any): number => {
  const min = packsOf(item?.min, item);
  const t = packsOf(item?.target, item);
  return t > min ? t : Math.max(r2(min * 2), r2(min + 1));
};

/** Сколько упаковок заказать: 0 — позиция в порядке; иначе до target, минимум одна. */
export const suggestedPacks = (item: any): number => {
  if (item?.active === false || statusOf(item) === 'ok') return 0;
  const havePacks = r2(n0(item?.qty)) / packOf(item);
  return Math.max(1, Math.ceil(effectiveTarget(item) - havePacks - 1e-9));
};

/** Пражских дней между двумя моментами (b − a). */
export const daysBetween = (a: string | Date, b: string | Date): number => {
  const da = pragueDateOf(a);
  const db = pragueDateOf(b);
  return Math.round((Date.parse(`${db}T00:00:00Z`) - Date.parse(`${da}T00:00:00Z`)) / 86400000);
};

/** Пора пересчитать: ни разу не считали или прошло `countEveryDays` дней. */
export const countDueOf = (item: any, now: Date): { daysSinceCount: number | null; countDue: boolean } => {
  if (!item?.lastCountedAt) return { daysSinceCount: null, countDue: true };
  const d = daysBetween(item.lastCountedAt, now);
  const every = Math.max(1, Math.floor(n0(item.countEveryDays)) || DEFAULT_COUNT_EVERY);
  return { daysSinceCount: d, countDue: d >= every };
};

/** Понедельник пражской недели даты `ymd` (YYYY-MM-DD). */
export const mondayOf = (ymd: string): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
};

/**
 * В «Rychlá inventura» этой недели (решение владельца: понедельник): позиция ни разу не считана
 * или не считалась с понедельника и её срок (`countEveryDays`) наступает в течение этой недели.
 * Пересчитали в понедельник или позже — из списка уходит до следующего понедельника.
 */
export const inventoryDueOf = (item: any, now: Date): boolean => {
  if (item?.active === false) return false;
  if (!item?.lastCountedAt) return true;
  const monday = mondayOf(pragueDateOf(now));
  const counted = pragueDateOf(item.lastCountedAt);
  if (counted >= monday) return false;
  const every = Math.max(1, Math.floor(n0(item.countEveryDays)) || DEFAULT_COUNT_EVERY);
  return daysBetween(item.lastCountedAt, `${monday}T12:00:00Z`) + 6 >= every;
};

/** Код места для QR-ярлыка полки: без диакритики, через дефис («Skříň s laky» → `skrin-s-laky`). */
export const locationSlug = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bez-mista';

export const cleanStr = (v: unknown, max: number, code: string, label: string): string => {
  if (v != null && typeof v !== 'string' && typeof v !== 'number') throw new StockError(400, code, `${label}: neplatný formát`);
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new StockError(400, code, `${label}: nejvýše ${max} znaků`);
  return s;
};

export const intIn = (v: unknown, lo: number, hi: number, code: string, label: string): number => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) {
    throw new StockError(400, code, `${label}: celé číslo ${lo}–${hi}`);
  }
  return n;
};

export const numIn = (v: unknown, lo: number, hi: number, code: string, label: string): number => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < lo || n > hi) throw new StockError(400, code, `${label}: číslo ${lo}–${hi}`);
  return r2(n);
};

/**
 * Поля позиции от руководства. `partial` — правка: меняется только присланное.
 * Остаток здесь не меняется никогда — только движениями (кроме стартового при создании).
 */
export const normalizeItemInput = (body: any, { partial = false, current = null }: { partial?: boolean; current?: any } = {}) => {
  const out: any = {};
  const take = (k: string) => !partial || has(body, k);
  if (take('name')) {
    const name = cleanStr(body?.name, MAX_NAME, 'bad_name', 'Název');
    if (!name) throw new StockError(400, 'name_required', 'Napište název položky');
    out.name = name;
  }
  if (take('category')) {
    const c = body?.category == null || body?.category === '' ? 'jine' : String(body.category);
    if (!CAT_KEYS.has(c)) throw new StockError(400, 'bad_category', 'Neplatná kategorie');
    out.category = c;
  }
  if (take('location')) {
    const loc = cleanStr(body?.location, MAX_LOCATION, 'bad_location', 'Umístění');
    if (!loc) throw new StockError(400, 'location_required', 'Napište, kde položka leží');
    out.location = loc;
  }
  if (take('unit')) {
    const u = body?.unit == null || body?.unit === '' ? 'ks' : String(body.unit);
    if (!UNIT_KEYS.has(u)) throw new StockError(400, 'bad_unit', 'Neplatná jednotka');
    out.unit = u;
  }
  if (take('packSize')) out.packSize = body?.packSize == null || body?.packSize === '' ? 1 : intIn(body.packSize, 1, MAX_PACK_SIZE, 'bad_pack_size', 'Kusů v balení');
  // минимум и «doplnit do» — в упаковках: штучные целые, ml/g дробные (s258)
  const pieces = (has(out, 'unit') ? out.unit : unitOf(current)) === 'ks';
  const packsIn = (v: unknown, code: string, label: string) => (pieces ? intIn(v, 0, MAX_PACKS, code, label) : numIn(v, 0, MAX_PACKS, code, label));
  if (take('min')) out.min = body?.min == null || body?.min === '' ? 0 : packsIn(body.min, 'bad_min', 'Minimum');
  if (take('target')) out.target = body?.target == null || body?.target === '' ? 0 : packsIn(body.target, 'bad_target', 'Doplnit do');
  const min = has(out, 'min') ? out.min : n0(current?.min);
  const target = has(out, 'target') ? out.target : n0(current?.target);
  if ((has(out, 'min') || has(out, 'target')) && target > 0 && target <= min) {
    throw new StockError(400, 'target_below_min', '„Doplnit do“ musí být víc než minimum (nebo nechte prázdné)');
  }
  if (take('supplier')) out.supplier = cleanStr(body?.supplier, MAX_SUPPLIER, 'bad_supplier', 'Dodavatel');
  if (take('url')) {
    const url = cleanStr(body?.url, MAX_URL, 'bad_url', 'Odkaz');
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new StockError(400, 'bad_url', 'Odkaz musí začínat http:// nebo https://');
    out.url = url;
  }
  if (take('lastPrice')) out.lastPrice = body?.lastPrice == null || body?.lastPrice === '' ? null : numIn(body.lastPrice, 0, MAX_PRICE, 'bad_price', 'Cena balení');
  if (take('countEveryDays')) {
    out.countEveryDays =
      body?.countEveryDays == null || body?.countEveryDays === '' ? DEFAULT_COUNT_EVERY : intIn(body.countEveryDays, 1, 365, 'bad_count_every', 'Počítat každých');
  }
  if (take('note')) {
    if (body?.note != null && typeof body.note !== 'string') throw new StockError(400, 'bad_note', 'Poznámka: neplatný formát');
    const note = String(body?.note ?? '').replace(/\r\n?/g, '\n').trim();
    if (note.length > MAX_NOTE) throw new StockError(400, 'bad_note', `Poznámka: nejvýše ${MAX_NOTE} znaků`);
    out.note = note;
  }
  if (partial && has(body, 'active')) {
    if (typeof body.active !== 'boolean') throw new StockError(400, 'bad_active', 'Neplatná hodnota');
    out.active = body.active;
  }
  if (partial && !Object.keys(out).length) throw new StockError(400, 'nothing_to_change', 'Není co měnit');
  return out;
};

/**
 * Количество из формы → базовая единица: `packs` упаковок + `units` штук/ml/g.
 * Штуки — только целые (и упаковки штучных позиций); у ml и g дробные и упаковки
 * (s258: «0,2 канистры по 5000 ml» = 1000 ml — администратор так и пытался ввести),
 * и количество — до сотых. Коды ошибок — по полю: `bad_packs` / `bad_units` (админка
 * показывает ошибку под нужным полем).
 */
export const qtyFromInput = (body: any, item: any): number => {
  const p = packOf(item);
  const pieces = unitOf(item) === 'ks';
  const hasPacks = body?.packs != null && body?.packs !== '';
  const hasUnits = body?.units != null && body?.units !== '';
  if (!hasPacks && !hasUnits) throw new StockError(400, 'qty_required', 'Zadejte množství');
  const packs = !hasPacks ? 0 : pieces ? intIn(body.packs, 0, MAX_PACKS, 'bad_packs', 'Balení') : numIn(body.packs, 0, MAX_PACKS, 'bad_packs', 'Balení');
  let units = 0;
  if (hasUnits) {
    units = pieces ? intIn(body.units, 0, MAX_QTY, 'bad_units', 'Kusy') : numIn(body.units, 0, MAX_QTY, 'bad_units', 'Množství');
  }
  const q = r2(packs * p + units);
  if (q > MAX_QTY) throw new StockError(400, 'bad_units', 'Příliš velké množství');
  return q;
};

/**
 * Движение: что станет с остатком.
 *   count — пересчёт: остаток = введённое (0 допустим; «OK jak bylo» = то же число);
 *   in    — приход: + введённое (> 0);
 *   out   — «Došlo» (`mode: 'empty'`) → 0; «Málo» (`mode: 'low'`) → не больше минимума
 *           (статус станет «Málo»; если и так не больше — остаток не меняется, отметка остаётся).
 */
export const computeMove = (item: any, body: any) => {
  const kind = String(body?.kind ?? '');
  const before = r2(n0(item?.qty));
  if (kind === 'count') {
    const after = qtyFromInput(body, item);
    return { kind, mode: null, qtyBefore: before, qtyAfter: after, delta: r2(after - before) };
  }
  if (kind === 'in') {
    const add = qtyFromInput(body, item);
    if (add <= 0) throw new StockError(400, 'qty_positive', 'Přišlo musí být víc než nula');
    const after = r2(before + add);
    if (after > MAX_QTY) throw new StockError(400, 'bad_qty', 'Příliš velké množství');
    return { kind, mode: null, qtyBefore: before, qtyAfter: after, delta: add };
  }
  if (kind === 'out') {
    const mode = String(body?.mode ?? 'empty');
    if (mode === 'empty') return { kind, mode, qtyBefore: before, qtyAfter: 0, delta: r2(-before) };
    if (mode === 'low') {
      const m = minBase(item);
      if (m <= 0) throw new StockError(400, 'no_min', 'Položka nemá minimum — použijte „Spočítat“ nebo „Došlo“');
      const after = Math.min(before, m);
      return { kind, mode, qtyBefore: before, qtyAfter: after, delta: r2(after - before) };
    }
    throw new StockError(400, 'bad_mode', 'Neplatná akce');
  }
  throw new StockError(400, 'bad_kind', 'Neplatná akce');
};

/**
 * Позиция для ответа. Администратору — без цены (§0.2).
 * `onOrder` — упаковки по открытым заказам (draft/sent, ещё не пришли): «Co objednat» их вычитает.
 */
export const itemView = (doc: any, { now, showPrices, onOrder }: { now: Date; showPrices: boolean; onOrder?: Map<string, number> }) => {
  const item = {
    documentId: doc.documentId,
    name: String(doc.name ?? ''),
    category: CAT_KEYS.has(doc.category) ? doc.category : 'jine',
    location: String(doc.location ?? ''),
    locationSlug: locationSlug(doc.location),
    unit: unitOf(doc),
    packSize: packOf(doc),
    qty: r2(n0(doc.qty)),
    min: packsOf(doc.min, doc),
    target: packsOf(doc.target, doc),
    supplier: String(doc.supplier ?? ''),
    url: String(doc.url ?? ''),
    countEveryDays: Math.max(1, Math.floor(n0(doc.countEveryDays)) || DEFAULT_COUNT_EVERY),
    lastCountedAt: doc.lastCountedAt ? new Date(doc.lastCountedAt).toISOString() : null,
    lastCountedBy: doc.lastCountedBy || null,
    note: String(doc.note ?? ''),
    active: doc.active !== false,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    /** о каком статусе управляющая уже знает (push / сводка 10:00, stock-notify) */
    notifiedStatus: doc.notifiedStatus === 'low' || doc.notifiedStatus === 'out' ? doc.notifiedStatus : null,
  };
  const status = statusOf(item);
  const suggested = suggestedPacks(item);
  const onOrderPacks = Math.max(0, Math.floor(n0(onOrder?.get(item.documentId))));
  const out: any = {
    ...item,
    status,
    qtyText: fmtQty(item.qty, item.packSize, item.unit),
    minText: item.packSize > 1 ? `${numText(item.min)} bal.` : `${numText(item.min)} ${item.unit}`,
    effectiveTarget: effectiveTarget(item),
    suggestedPacks: suggested,
    onOrderPacks,
    /** сколько ещё заказать с учётом уже заказанного */
    toOrderPacks: Math.max(0, suggested - onOrderPacks),
    ...countDueOf(item, now),
    inventoryDue: inventoryDueOf(item, now),
  };
  if (showPrices) out.lastPrice = doc.lastPrice == null || doc.lastPrice === '' ? null : r2(n0(doc.lastPrice));
  return out;
};

export const moveView = (m: any) => {
  const packSize = packOf(m);
  const unit = unitOf(m);
  const delta = r2(n0(m.delta));
  return {
    documentId: m.documentId,
    itemDocId: m.itemDocId || '',
    itemName: m.itemName || '',
    kind: has(MOVE_KINDS, m.kind) ? m.kind : 'adjust',
    mode: m.mode || null,
    qtyBefore: r2(n0(m.qtyBefore)),
    qtyAfter: r2(n0(m.qtyAfter)),
    delta,
    beforeText: fmtQty(m.qtyBefore, packSize, unit),
    afterText: fmtQty(m.qtyAfter, packSize, unit),
    deltaText: delta === 0 ? '±0' : `${delta > 0 ? '+' : '−'}${fmtQty(Math.abs(delta), packSize, unit)}`,
    by: m.by || '',
    role: m.role || '',
    note: m.note || '',
    orderDocId: m.orderDocId || null,
    at: m.createdAt ? new Date(m.createdAt).toISOString() : null,
  };
};

/** Порядок списка: сначала došlo, потом málo, потом по месту и названию. */
const STATUS_RANK = { out: 0, low: 1, ok: 2 };
export const sortItems = (items: any[]) =>
  [...items].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.location.localeCompare(b.location, 'cs') ||
      a.name.localeCompare(b.name, 'cs')
  );

/**
 * «Co objednat»: активные позиции ниже минимума, группами по поставщику (без поставщика — в конце).
 * `text` — для копирования поставщику / в корзину: без цен. Сумма — только руководству.
 * Уже заказанное и не пришедшее вычитается (`toOrderPacks`); полностью покрытые — не в группах.
 */
export const orderGroups = (items: any[], { showPrices }: { showPrices: boolean }) => {
  const groups = new Map<string, any>();
  for (const it of items) {
    const packs = it.toOrderPacks ?? it.suggestedPacks;
    if (!it.active || !packs) continue;
    const key = it.supplier.trim();
    if (!groups.has(key)) groups.set(key, { supplier: key, lines: [] });
    const line: any = {
      documentId: it.documentId,
      name: it.name,
      location: it.location,
      status: it.status,
      qtyText: it.qtyText,
      packSize: it.packSize,
      unit: it.unit,
      packs,
      onOrderPacks: it.onOrderPacks || 0,
      url: it.url,
    };
    if (showPrices) {
      line.price = it.lastPrice ?? null;
      line.sum = it.lastPrice != null ? r2(it.lastPrice * packs) : null;
    }
    groups.get(key).lines.push(line);
  }
  const out = [...groups.values()].sort((a, b) => (!a.supplier ? 1 : !b.supplier ? -1 : a.supplier.localeCompare(b.supplier, 'cs')));
  for (const g of out) {
    g.lines.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, 'cs') : a.status === 'out' ? -1 : 1));
    g.text = orderText(g);
    if (showPrices) {
      const known = g.lines.filter((l) => l.sum != null);
      g.sum = known.length ? r2(known.reduce((s, l) => s + l.sum, 0)) : null;
      g.sumPartial = known.length > 0 && known.length < g.lines.length;
    }
  }
  return out;
};

const lineQty = (l: any): string => (l.packSize > 1 ? `${l.packs} bal. (à ${l.packSize} ${l.unit})` : `${l.packs} ${l.unit}`);

/** Текст заказа: шапка + строка на позицию. */
export const orderText = (g: any): string =>
  [`Objednávka${g.supplier ? ` — ${g.supplier}` : ''}`, ...g.lines.map((l) => `• ${l.name} — ${lineQty(l)}`)].join('\n');

/** Ниже минимума, но всё нужное уже заказано и ждёт прихода. */
export const coveredOf = (items: any[]) =>
  items
    .filter((i) => i.active && i.suggestedPacks > 0 && i.toOrderPacks === 0)
    .map((i) => ({ documentId: i.documentId, name: i.name, location: i.location, status: i.status, qtyText: i.qtyText, onOrderPacks: i.onOrderPacks, packSize: i.packSize, unit: i.unit }));

/**
 * Сводка для «Сегодня», кабинета администратора и дайджеста.
 * `onOrder` у строки — уже заказано (заказывать не нужно, ждём прихода).
 * Фаза 2: `inventory` — «Rychlá inventura» этой недели (сколько осталось пересчитать).
 */
export const attentionOf = (items: any[], now: Date = new Date()) => {
  const act = items.filter((i) => i.active);
  const brief = (i) => ({
    documentId: i.documentId,
    name: i.name,
    location: i.location,
    qtyText: i.qtyText,
    minText: i.minText,
    onOrder: (i.onOrderPacks || 0) > 0 && i.toOrderPacks === 0,
  });
  const today = pragueDateOf(now);
  return {
    total: act.length,
    out: act.filter((i) => i.status === 'out').map(brief),
    low: act.filter((i) => i.status === 'low').map(brief),
    countDue: act.filter((i) => i.countDue).length,
    inventory: { monday: mondayOf(today), isMonday: mondayOf(today) === today, remaining: act.filter((i) => i.inventoryDue).length },
  };
};

/** Что поменялось в настройках — для журнала. */
export const changedItemFields = (current: any, next: any): string[] =>
  Object.keys(next).filter((k) => String(current?.[k] ?? '') !== String(next[k] ?? ''));

const FIELD_LABELS = {
  name: 'název',
  category: 'kategorie',
  location: 'umístění',
  unit: 'jednotka',
  packSize: 'balení',
  min: 'minimum',
  target: 'doplnit do',
  supplier: 'dodavatel',
  url: 'odkaz',
  lastPrice: 'cena',
  countEveryDays: 'počítání',
  note: 'poznámka',
  active: 'aktivní',
};

const ITEM_FIELDS = [
  'name', 'category', 'location', 'unit', 'packSize', 'qty', 'min', 'target', 'supplier', 'url', 'lastPrice',
  'countEveryDays', 'lastCountedAt', 'lastCountedBy', 'note', 'active', 'version', 'notifiedStatus', 'createdAt', 'updatedAt',
];
const MOVE_FIELDS = ['itemDocId', 'itemName', 'kind', 'mode', 'qtyBefore', 'qtyAfter', 'delta', 'packSize', 'unit', 'by', 'role', 'note', 'orderDocId', 'createdAt'];
const ACTIVE_FILTER = { $or: [{ active: true }, { active: { $null: true } }] };
const notFound = () => new StockError(404, 'item_not_found', 'Položka nenalezena');
const labelList = (o: Record<string, string>) => Object.entries(o).map(([key, label]) => ({ key, label }));

export default {
  _log(action: string, session: any, item: any, summary: string, details: any = {}) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'stock',
        actorName: session?.username || '',
        entityDocId: item?.documentId || '',
        summary,
        details,
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /**
   * Кто спрашивает: owner/manager/administrator. `canEdit` — руководство (заказы, цены, затраты);
   * `canEditItems` — позиции (s257: и администраторы, без цены).
   */
  _who(session: any) {
    if (!session || !STOCK_ROLES.includes(session.role)) throw new StockError(403, 'not_allowed', 'Sklad není pro tuto roli');
    const canEdit = EDIT_ROLES.includes(session.role);
    return { role: session.role, canEdit, canEditItems: true, showPrices: canEdit };
  },

  /** Поля позиции от сессии: цену задаёт только руководство — у администратора она отбрасывается. */
  _itemBody(who: any, body: any) {
    if (who.showPrices || !body || typeof body !== 'object' || !has(body, 'lastPrice')) return body;
    const { lastPrice, ...rest } = body;
    return rest;
  },

  _requireEdit(who: any) {
    if (!who.canEdit) throw new StockError(403, 'edit_not_allowed', 'Tohle může jen vedení salonu');
  },

  async _all({ archived = false } = {}) {
    return strapi.documents(ITEM_UID).findMany({
      // не `$ne: false`: в SQL `<>` отсекает и NULL
      filters: archived ? {} : ACTIVE_FILTER,
      fields: ITEM_FIELDS,
      sort: [{ name: 'asc' }],
      limit: MAX_ITEMS,
    });
  },

  async _find(id: unknown) {
    const documentId = String(id ?? '').trim();
    if (!DOC_ID.test(documentId)) throw notFound();
    const doc = await strapi.documents(ITEM_UID).findOne({ documentId, fields: ITEM_FIELDS });
    if (!doc) throw notFound();
    return doc;
  },

  /** Упаковки по открытым заказам: itemDocId → сколько ещё должно прийти. Сбой — пусто (список важнее). */
  async _onOrder(): Promise<Map<string, number>> {
    try {
      return await strapi.service('api::booking-engine.stock-orders').openPacks();
    } catch (e) {
      strapi.log.warn(`stock: open orders failed: ${e?.message || e}`);
      return new Map();
    }
  },

  /** Активные позиции в виде ответа (с учётом заказанного). */
  async _views(now: Date, showPrices: boolean, { archived = false } = {}) {
    const [rows, onOrder] = await Promise.all([this._all({ archived }), this._onOrder()]);
    return rows.map((d) => itemView(d, { now, showPrices, onOrder }));
  },

  _meta(who: any, now: Date) {
    return {
      today: pragueDateOf(now),
      role: who.role,
      canEdit: who.canEdit,
      canEditItems: who.canEditItems,
      showPrices: who.showPrices,
      categories: CATEGORIES.map((c) => ({ ...c })),
      units: UNITS.map((u) => ({ ...u })),
      statuses: labelList(STATUSES),
      moveKinds: labelList(MOVE_KINDS),
    };
  },

  /** GET /stock?archived=1 — список позиций (по умолчанию только активные). */
  async list({ session, archived, now = new Date() }: { session: any; archived?: unknown; now?: Date }) {
    const who = this._who(session);
    const withArchived = archived === '1' || archived === 'true' || archived === true;
    const items = sortItems(await this._views(now, who.showPrices, { archived: withArchived && who.canEditItems }));
    return { items, meta: this._meta(who, now) };
  },

  /** GET /stock/items/:id — позиция и последние движения (экран QR-ярлыка). */
  async item({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    const who = this._who(session);
    const doc = await this._find(id);
    if (doc.active === false && !who.canEditItems) throw notFound();
    const [moves, onOrder] = await Promise.all([
      strapi.documents(MOVE_UID).findMany({
        filters: { itemDocId: doc.documentId },
        fields: MOVE_FIELDS,
        sort: [{ createdAt: 'desc' }],
        limit: 10,
      }),
      this._onOrder(),
    ]);
    return { item: itemView(doc, { now, showPrices: who.showPrices, onOrder }), moves: moves.map(moveView), meta: this._meta(who, now) };
  },

  /** GET /stock/order — «Co objednat»: группы по поставщику, текст для копирования; `covered` — уже заказано. */
  async order({ session, now = new Date() }: { session: any; now?: Date }) {
    const who = this._who(session);
    const items = sortItems(await this._views(now, who.showPrices));
    return { groups: orderGroups(items, { showPrices: who.showPrices }), covered: coveredOf(items), meta: this._meta(who, now) };
  },

  /** Сводка без проверки роли — для дайджеста (там только названия, без цен). */
  async summary(now = new Date()) {
    return attentionOf(await this._views(now, false), now);
  },

  /**
   * GET /stock/attention — карточка «Сегодня» и блок кабинета администратора.
   * Фаза 2: + заказы (ждут прихода / просрочены, у руководства — приходы без затраты).
   */
  async attention({ session, now = new Date() }: { session: any; now?: Date }) {
    const who = this._who(session);
    const [summary, orders] = await Promise.all([
      this.summary(now),
      strapi
        .service('api::booking-engine.stock-orders')
        .attention({ now, canEdit: who.canEdit })
        .catch((e) => {
          strapi.log.warn(`stock: orders attention failed: ${e?.message || e}`);
          return null;
        }),
    ]);
    return { ...summary, orders };
  },

  /** GET /stock/moves?item=&before=&limit= — журнал движений, свежие сверху. */
  async moves({ session, item, before, limit }: { session: any; item?: unknown; before?: unknown; limit?: unknown }) {
    this._who(session);
    const filters: any = {};
    const itemDocId = String(item ?? '').trim();
    if (itemDocId) {
      if (!DOC_ID.test(itemDocId)) throw notFound();
      filters.itemDocId = itemDocId;
    }
    const b = String(before ?? '').trim();
    if (b) {
      if (Number.isNaN(Date.parse(b))) throw new StockError(400, 'bad_before', 'Neplatné datum');
      filters.createdAt = { $lt: new Date(b).toISOString() };
    }
    const n = Math.min(MAX_MOVES_PAGE, Math.max(1, Math.floor(n0(limit)) || 50));
    const rows = await strapi.documents(MOVE_UID).findMany({ filters, fields: MOVE_FIELDS, sort: [{ createdAt: 'desc' }], limit: n + 1 });
    return { moves: rows.slice(0, n).map(moveView), hasMore: rows.length > n };
  },

  /** GET /stock/suggest — автодополнение: названия (свои + старая «Склад»), места, поставщики. */
  async suggest({ session }: { session: any }) {
    this._who(session);
    const items = await this._all({ archived: true });
    const uniq = (list: string[]) => {
      const seen = new Map<string, string>();
      for (const raw of list) {
        const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
        if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b, 'cs'));
    };
    let legacy: string[] = [];
    try {
      if (strapi.contentTypes?.[LEGACY_UID]) {
        const rows = await strapi.documents(LEGACY_UID).findMany({ status: 'published', fields: ['name'], limit: 2000 });
        legacy = rows.map((r) => r.name);
      }
    } catch (e) {
      strapi.log.warn(`stock: legacy names failed: ${e?.message || e}`);
    }
    return {
      names: uniq([...items.map((i) => i.name), ...legacy]),
      locations: uniq([...items.map((i) => i.location), ...DEFAULT_LOCATIONS]),
      suppliers: uniq(items.map((i) => i.supplier)),
    };
  },

  async _dupCheck(name: string, exceptDocId: string | null) {
    const rows = await strapi.documents(ITEM_UID).findMany({
      filters: { name: { $eqi: name }, ...ACTIVE_FILTER },
      fields: ['name'],
      limit: 5,
    });
    if (rows.some((r) => r.documentId !== exceptDocId)) throw new StockError(409, 'duplicate_name', 'Položka s tímto názvem už existuje');
  },

  /** POST /stock/items — новая позиция (все три роли, цена — только руководство); стартовый остаток — движение `create`. */
  async create({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const who = this._who(session);
    const input = normalizeItemInput(this._itemBody(who, body));
    await this._dupCheck(input.name, null);
    const hasStart = body?.packs != null && body?.packs !== '' || body?.units != null && body?.units !== '';
    const qty = hasStart ? qtyFromInput(body, input) : 0;
    const by = session?.username || '';
    const doc = await strapi.documents(ITEM_UID).create({
      data: {
        ...input,
        qty,
        active: true,
        createdByName: by,
        ...(hasStart ? { lastCountedAt: now, lastCountedBy: by } : {}),
        version: 1,
      },
    });
    await strapi.documents(MOVE_UID).create({
      data: { itemDocId: doc.documentId, itemName: input.name, kind: 'create', qtyBefore: 0, qtyAfter: qty, delta: qty, packSize: input.packSize, unit: input.unit, by, role: who.role, note: '' },
    });
    this._log('stock_item_create', session, doc, `Sklad: nová položka ${input.name} (${input.location}) — stav ${fmtQty(qty, input.packSize, input.unit)}`);
    return { item: itemView(await this._find(doc.documentId), { now, showPrices: who.showPrices }) };
  },

  /** PATCH /stock/items/:id — настройки позиции (все три роли, цена — только руководство). Остаток не трогает. */
  async update({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const who = this._who(session);
    const current = await this._find(id);
    const input = normalizeItemInput(this._itemBody(who, body), { partial: true, current });
    if (input.name) await this._dupCheck(input.name, current.documentId);
    else if (input.active === true && current.active === false) await this._dupCheck(current.name, current.documentId);
    const changed = changedItemFields(current, input);
    if (!changed.length) return { item: itemView(current, { now, showPrices: who.showPrices }) };
    const data = Object.fromEntries(changed.map((k) => [k, input[k]]));
    await strapi.documents(ITEM_UID).update({ documentId: current.documentId, data });
    const saved = await this._find(current.documentId);
    const head = has(data, 'active') ? (data.active ? 'Sklad: položka obnovena' : 'Sklad: položka archivována') : 'Sklad: položka upravena';
    this._log('stock_item_edit', session, saved, `${head} — ${saved.name} (${changed.map((k) => FIELD_LABELS[k] || k).join(', ')})`, { fields: changed });
    return { item: itemView(saved, { now, showPrices: who.showPrices }) };
  },

  /**
   * Запись движения с условной записью остатка по `version` (до трёх попыток: при гонке
   * пересчитываем от свежего остатка). `calcFor(item)` — что станет с остатком (computeMove).
   * Общий путь для трёх действий и прихода по заказу (stock-orders, `orderDocId`).
   */
  async _moveWithRetry(
    id: unknown,
    calcFor: (item: any) => any,
    { session, role, note = '', orderDocId = null, logNote = '', now = new Date() }: { session: any; role: string; note?: string; orderDocId?: string | null; logNote?: string; now?: Date }
  ) {
    const by = session?.username || '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = await this._find(id);
      if (item.active === false) throw new StockError(409, 'item_archived', `Položka ${item.name} je archivovaná`);
      const calc = calcFor(item);
      const v = Number.isInteger(item.version) ? item.version : null;
      const before = statusOf(item);
      const after = statusOf({ ...item, qty: calc.qtyAfter });
      const res = await strapi.db.query(ITEM_UID).updateMany({
        where: { documentId: item.documentId, version: v == null ? { $null: true } : v },
        data: {
          qty: calc.qtyAfter,
          version: (v ?? 0) + 1,
          updatedAt: now,
          ...(calc.kind === 'count' ? { lastCountedAt: now, lastCountedBy: by } : {}),
          // снова в порядке — следующий «málo/došlo» снова попадёт в напоминание управляющей
          ...(after === 'ok' && item.notifiedStatus ? { notifiedStatus: null } : {}),
        },
      });
      if (!res || !res.count) continue;
      const packSize = packOf(item);
      const unit = unitOf(item);
      const move = await strapi.documents(MOVE_UID).create({
        data: {
          itemDocId: item.documentId,
          itemName: item.name,
          kind: calc.kind,
          mode: calc.mode,
          qtyBefore: calc.qtyBefore,
          qtyAfter: calc.qtyAfter,
          delta: calc.delta,
          packSize,
          unit,
          by,
          role,
          note,
          ...(orderDocId ? { orderDocId } : {}),
        },
      });
      const verb = calc.kind === 'count' ? 'spočítáno' : calc.kind === 'in' ? `přišlo ${fmtQty(calc.delta, packSize, unit)}` : calc.mode === 'low' ? 'málo' : 'došlo';
      const tail = logNote || note;
      this._log(
        `stock_${calc.kind}`,
        session,
        item,
        `Sklad: ${item.name} — ${verb}, stav ${fmtQty(calc.qtyBefore, packSize, unit)} → ${fmtQty(calc.qtyAfter, packSize, unit)}${tail ? ` · ${tail.slice(0, 120)}` : ''}`,
        { kind: calc.kind, mode: calc.mode, qtyBefore: calc.qtyBefore, qtyAfter: calc.qtyAfter, ...(orderDocId ? { orderDocId } : {}) }
      );
      const saved = await this._find(item.documentId);
      // перешла в «došlo» — управляющей сразу (stock-notify решает, слать ли); сбой пуша не мешает записи
      if (after === 'out' && before !== 'out') {
        Promise.resolve()
          .then(() => strapi.service('api::booking-engine.stock-notify').itemOut(saved, { role }))
          .catch((e) => strapi.log.error(`stock-notify itemOut failed: ${e?.message || e}`));
      }
      return { saved, move };
    }
    throw new StockError(409, 'stock_busy', 'Položku právě mění někdo jiný — zkuste to znovu');
  },

  /** POST /stock/items/:id/moves {kind: count|in|out, packs?, units?, mode?, note?} — все три роли. */
  async move({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const who = this._who(session);
    const note = body?.note == null ? '' : String(body.note).replace(/\s+/g, ' ').trim();
    if (note.length > MAX_NOTE) throw new StockError(400, 'bad_note', `Poznámka: nejvýše ${MAX_NOTE} znaků`);
    const { saved, move } = await this._moveWithRetry(id, (item) => computeMove(item, body), { session, role: who.role, note, now });
    return { item: itemView(saved, { now, showPrices: who.showPrices, onOrder: await this._onOrder() }), move: moveView(move) };
  },
};
