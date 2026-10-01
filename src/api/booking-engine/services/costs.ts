// @ts-nocheck
/**
 * Затраты салона из админки (s236, план EXPENSES_NEXT_SESSION_PROMPT.md, Фаза 1).
 * Раньше затраты вносились только в панели Strapi.
 *
 * Кто что может (решения владельца §0 плана):
 *   • руководство (owner + manager) — видит месяц и добавляет: запись сразу
 *     ОПУБЛИКОВАННАЯ (итоги месяца читают только published), `author` = логин сессии;
 *   • владелец правит и удаляет сразу; удаление — документ целиком, навсегда;
 *   • управляющая правку и удаление не делает (403 `approval_required`) — подаёт
 *     запрос (`cost-request`), владелец одобряет или отклоняет. Одобрение строгое
 *     и для её собственных записей. На затрату — один ожидающий запрос.
 *
 * Одобрение применяется, только если запись не менялась после запроса: снимок
 * полей `before` сравнивается с текущими (а не updatedAt — публикация Strapi
 * пересоздаёт опубликованную строку). Иначе 409 `cost_changed` + актуальная запись.
 *
 * `cost-request` без REST-роутов (паттерн staff-note). Журнал — calendar_logs,
 * entityType `cost`. Записи из панели обходят одобрение и журнал — это владелец,
 * так задумано; `author` у них пуст → в таблице «панель».
 *
 * Верх файла — чистые функции (tests/costs.test.mjs), ниже — сервис.
 */

export class CostError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const COST_UID = 'api::cost.cost';
export const REQUEST_UID = 'api::cost-request.cost-request';

/** Способ оплаты — enum `cost.payment`; значение — подпись в журнале. */
export const PAYMENTS = {
  card: 'karta salonu',
  cash: 'hotovost z kasy',
  transfer: 'převod',
  owner: 'zaplatil majitel',
} as const;

/** Потолок одной затраты — защита от лишнего нуля (максимум за 1,5 года — 17 000). */
export const MAX_SUM_KC = 300000;
export const MAX_NAME = 120;
export const MAX_TEXT = 500;
/** Дата вперёд — не дальше этого числа дней (опечатка в годе). */
export const MAX_FUTURE_DAYS = 45;
export const MAX_SUGGEST = 80;
/** Автодополнение — по записям за столько дней назад. */
export const SUGGEST_DAYS = 365;

/** Поля, которые правятся из админки (и которые сравниваются при одобрении). */
export const EDITABLE = ['date', 'name', 'category', 'sum', 'noDph', 'payment', 'comment'] as const;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;
const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const isValidYmd = (s: unknown): boolean => {
  const v = String(s ?? '');
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** YYYY-MM → первый и последний день месяца включительно. */
export const monthRange = (raw: unknown): { from: string; to: string } => {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw new CostError(400, 'bad_month', 'Месяц в формате ГГГГ-ММ');
  const last = new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate();
  return { from: `${s}-01`, to: `${s}-${String(last).padStart(2, '0')}` };
};

/** Число из формы: «1 500», «1500», 1500. NaN — не число. */
const parseKc = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
};

/** biginteger из базы приходит строкой. */
const toKc = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Проверка полной записи. `requirePayment` — при создании из админки способ оплаты
 * обязателен; у старых записей (панель, до s236) его нет, и правка других полей
 * его не требует.
 */
export const validateCost = (
  v: any,
  { today, categories, requirePayment }: { today: string; categories: readonly string[]; requirePayment: boolean }
) => {
  const name = String(v.name ?? '').trim();
  if (!name) throw new CostError(400, 'name_required', 'Напишите название');
  if (name.length > MAX_NAME) throw new CostError(400, 'name_too_long', `Название длиннее ${MAX_NAME} символов`);

  const category = String(v.category ?? '');
  if (!categories.includes(category)) throw new CostError(400, 'bad_category', 'Выберите категорию');

  const sum = parseKc(v.sum);
  if (!Number.isFinite(sum) || sum <= 0 || !Number.isInteger(sum)) {
    throw new CostError(400, 'bad_sum', 'Сумма — целое положительное число крон');
  }
  if (sum > MAX_SUM_KC) throw new CostError(400, 'sum_too_big', `Сумма больше ${MAX_SUM_KC} Kč`);

  const noDph = parseKc(v.noDph);
  if (!Number.isFinite(noDph) || !Number.isInteger(noDph) || noDph < 0 || noDph > sum) {
    throw new CostError(400, 'bad_no_dph', 'Сумма без DPH — целые кроны, не больше суммы');
  }

  const rawPayment = String(v.payment ?? '').trim();
  if (!rawPayment && requirePayment) throw new CostError(400, 'payment_required', 'Выберите способ оплаты');
  if (rawPayment && !has(PAYMENTS, rawPayment)) throw new CostError(400, 'bad_payment', 'Неизвестный способ оплаты');

  const date = String(v.date ?? '').trim();
  if (!isValidYmd(date)) throw new CostError(400, 'bad_date', 'Дата в формате ГГГГ-ММ-ДД');
  if (date > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new CostError(400, 'date_too_far', 'Дата слишком далеко в будущем');

  const comment = String(v.comment ?? '').trim();
  if (comment.length > MAX_TEXT) throw new CostError(400, 'text_too_long', `Комментарий длиннее ${MAX_TEXT} символов`);

  return { date, name, category, sum, noDph, payment: rawPayment || null, comment: comment || null };
};

/** Новая затрата из формы: белый список полей, способ оплаты обязателен. */
export const normalizeCostInput = (body: any, today: string, categories: readonly string[]) => {
  const b = body && typeof body === 'object' ? body : {};
  const picked = {};
  for (const k of EDITABLE) picked[k] = b[k];
  return validateCost(picked, { today, categories, requirePayment: true });
};

/** Снимок правимых полей записи (строка базы → числа, пустое → null). */
export const snapshotOf = (doc: any) => ({
  date: doc?.date ?? null,
  name: String(doc?.name ?? '').trim(),
  category: doc?.category ?? null,
  sum: toKc(doc?.sum),
  noDph: toKc(doc?.noDph),
  payment: doc?.payment || null,
  comment: String(doc?.comment ?? '').trim() || null,
});

export const sameSnapshot = (a: any, b: any): boolean =>
  EDITABLE.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));

/**
 * Правка: поверх текущей записи — только присланные поля из белого списка, затем
 * проверка ЦЕЛОЙ записи (сумма без DPH ≤ суммы и т. п.). Возвращает только то,
 * что действительно меняется; ничего — 400 `no_changes`.
 */
export const normalizeCostChanges = (body: any, before: any, today: string, categories: readonly string[]) => {
  const b = body && typeof body === 'object' ? body : {};
  const merged = { ...before };
  for (const k of EDITABLE) if (has(b, k)) merged[k] = b[k];
  // способ оплаты нельзя стереть: кто его уже задал или присылает — обязателен
  const requirePayment = has(b, 'payment') || before?.payment != null;
  const after = validateCost(merged, { today, categories, requirePayment });
  const changes = {};
  for (const k of EDITABLE) if ((after[k] ?? null) !== (before?.[k] ?? null)) changes[k] = after[k];
  if (Object.keys(changes).length === 0) throw new CostError(400, 'no_changes', 'Ничего не изменилось');
  return { changes, after };
};

/** Ставка DPH по паре сумм (поля ставки в схеме нет): 21 / 12 / 0 или «вручную». */
export const vatFromRatio = (sum: number, noDph: number): 21 | 12 | 0 | 'manual' => {
  const s = Number(sum);
  const n = Number(noDph);
  if (!(s > 0)) return 0;
  if (n === s) return 0;
  if (Math.abs(n - s / 1.21) <= 1) return 21;
  if (Math.abs(n - s / 1.12) <= 1) return 12;
  return 'manual';
};

/** Сумма без DPH по ставке — так же считает форма админки. */
export const noDphFor = (sum: number, vat: number): number => (vat ? Math.round(sum / (1 + vat / 100)) : sum);

/** Строка ответа списка. `pending` — ожидающий запрос по этой затрате. */
export const toRow = (doc: any, pending?: any) => {
  const s = snapshotOf(doc);
  const author = String(doc?.author ?? '').trim() || null;
  return {
    documentId: doc.documentId,
    ...s,
    vat: vatFromRatio(s.sum, s.noDph),
    author,
    // записи без автора внесены в панели Strapi (все до s236)
    viaPanel: !author,
    files: 0,
    pendingRequest: pending
      ? { id: pending.documentId, action: pending.action, requestedBy: pending.requestedBy || null }
      : null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

export const requestRow = (r: any) => ({
  id: r.documentId,
  costDocId: r.costDocId,
  action: r.action,
  changes: r.changes ?? null,
  before: r.before ?? null,
  status: r.status,
  requestedBy: r.requestedBy || null,
  decidedBy: r.decidedBy || null,
  decidedAt: r.decidedAt ?? null,
  decisionNote: r.decisionNote || null,
  createdAt: r.createdAt ?? null,
});

/** Свежие сверху: дата, затем время создания. */
export const sortRows = (rows: any[]) =>
  rows.sort(
    (a, b) =>
      String(b.date ?? '').localeCompare(String(a.date ?? '')) ||
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  );

/** Ключ названия для автодополнения: «Nájem », «najem» и «NAJEM» — одно и то же (на проде пишут по-разному). */
export const nameKey = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Автодополнение по записям: на каждое название — последняя запись (её написание,
 * категория, ставка, сумма), способ оплаты — последний заданный. Частые сверху.
 */
export const suggestFrom = (rows: any[], limit = MAX_SUGGEST) => {
  const sorted = sortRows(rows.map((r) => ({ ...r })));
  const groups = new Map<string, any>();
  for (const r of sorted) {
    const key = nameKey(r.name);
    if (!key) continue;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        name: String(r.name).trim(),
        category: r.category ?? null,
        vat: vatFromRatio(r.sum, r.noDph),
        payment: r.payment || null,
        lastSum: r.sum,
        lastDate: r.date,
        count: 1,
      });
    } else {
      g.count += 1;
      if (!g.payment && r.payment) g.payment = r.payment;
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || String(b.lastDate).localeCompare(String(a.lastDate)))
    .slice(0, limit);
};

const fmtDay = (ymd: unknown) => {
  const [y, m, d] = String(ymd ?? '').split('-');
  return d ? `${d}.${m}.${y}` : '—';
};

const fmtKc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ').replace(/\s/g, ' ')} Kč`;

const cut = (s: unknown, n = 60) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

const FIELD_CS = {
  date: 'datum',
  name: 'název',
  category: 'kategorie',
  sum: 'suma',
  noDph: 'bez DPH',
  payment: 'platba',
  comment: 'komentář',
};

const fieldText = (k: string, v: any): string => {
  if (v == null || v === '') return '—';
  if (k === 'date') return fmtDay(v);
  if (k === 'sum' || k === 'noDph') return fmtKc(v);
  if (k === 'payment') return PAYMENTS[v] || String(v);
  return cut(v);
};

/** «suma: 16 500 Kč → 17 000 Kč; datum: 19.09.2026 → 20.09.2026». */
export const diffSummary = (before: any, changes: any): string =>
  EDITABLE.filter((k) => changes && has(changes, k))
    .map((k) => `${FIELD_CS[k]}: ${fieldText(k, before?.[k])} → ${fieldText(k, changes[k])}`)
    .join('; ');

/** «Náklad: Najem 17 000 Kč · 20.09.2026 · Коммунальные · převod». */
export const logSummary = (head: string, row: any): string => {
  const pay = row.payment ? ` · ${PAYMENTS[row.payment] || row.payment}` : '';
  return `${head}: ${cut(row.name, 80)} ${fmtKc(row.sum)} · ${fmtDay(row.date)} · ${row.category || '—'}${pay}`;
};

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const COST_FIELDS = ['date', 'name', 'category', 'sum', 'noDph', 'comment', 'payment', 'author', 'createdAt', 'updatedAt'];

const isOwner = (session: any) => session?.role === 'owner';

const notFound = () => new CostError(404, 'not_found', 'Затрата не найдена');

const toDbData = (v: any) => {
  const data = { ...v };
  // biginteger — строкой, как пишет панель
  if (has(data, 'sum')) data.sum = String(data.sum);
  if (has(data, 'noDph')) data.noDph = String(data.noDph);
  return data;
};

export default {
  /** Категории — enum схемы (владелец правит его сам, справочника нет). */
  categories(): string[] {
    const ct = strapi.contentTypes?.[COST_UID] ?? strapi.contentType?.(COST_UID);
    return [...(ct?.attributes?.category?.enum || [])];
  },

  _today(now: Date) {
    return PRAGUE_DAY.format(now);
  },

  _log(action: string, session: any, costDocId: string, summary: string, details: any) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({ action, entityType: 'cost', actorName: session?.username || '', entityDocId: costDocId, summary, details })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  _details(row: any) {
    return {
      název: row.name,
      datum: fmtDay(row.date),
      kategorie: row.category || '—',
      částka: fmtKc(row.sum),
      'bez DPH': fmtKc(row.noDph),
      platba: row.payment ? PAYMENTS[row.payment] : '—',
      komentář: row.comment || '—',
    };
  },

  async _findCost(id: unknown) {
    const documentId = String(id ?? '').trim();
    if (!DOC_ID.test(documentId)) throw notFound();
    const doc = await strapi.documents(COST_UID).findOne({ documentId, status: 'published', fields: COST_FIELDS });
    if (!doc) throw notFound();
    return doc;
  },

  async _findRequest(rid: unknown) {
    const documentId = String(rid ?? '').trim();
    const miss = new CostError(404, 'request_not_found', 'Запрос не найден');
    if (!DOC_ID.test(documentId)) throw miss;
    const r = await strapi.documents(REQUEST_UID).findOne({ documentId });
    if (!r) throw miss;
    return r;
  },

  _pendingRequests(filters: any = {}) {
    return strapi.documents(REQUEST_UID).findMany({
      filters: { status: { $eq: 'pending' }, ...filters },
      sort: [{ createdAt: 'asc' }],
      limit: 500,
    });
  },

  /**
   * Перевод запроса из pending — условным UPDATE: два одновременных решения
   * (одобрить + отозвать) не применятся оба. 0 строк — запрос уже закрыт.
   */
  async _claim(rid: string, data: any) {
    const res = await strapi.db.query(REQUEST_UID).updateMany({ where: { documentId: rid, status: 'pending' }, data });
    if (!res || !res.count) throw new CostError(409, 'request_closed', 'Запрос уже решён или отозван');
  },

  /** Правка опубликованной записи: черновик → публикация (как Save + Publish в панели). */
  async _apply(documentId: string, changes: any) {
    await strapi.documents(COST_UID).update({ documentId, status: 'draft', data: toDbData(changes) });
    await strapi.documents(COST_UID).publish({ documentId });
    return strapi.documents(COST_UID).findOne({ documentId, status: 'published', fields: COST_FIELDS });
  },

  /** Удаление навсегда (все версии) + ожидающие запросы по ней — `cancelled`. */
  async _delete(session: any, documentId: string, now: Date) {
    await strapi.documents(COST_UID).delete({ documentId });
    await strapi.db.query(REQUEST_UID).updateMany({
      where: { costDocId: documentId, status: 'pending' },
      data: { status: 'cancelled', decidedBy: session?.username || null, decidedAt: now, decisionNote: 'затрата удалена' },
    });
  },

  /** Месяц: строки, категории, способы оплаты и ожидающие запросы. */
  async list({ session, month }: { session: any; month: unknown }) {
    const { from, to } = monthRange(month);
    const [docs, pendingAll] = await Promise.all([
      strapi.documents(COST_UID).findMany({
        status: 'published',
        filters: { date: { $gte: from, $lte: to } },
        fields: COST_FIELDS,
        limit: 1000,
      }),
      this._pendingRequests(),
    ]);
    const byCost = new Map(pendingAll.map((r) => [r.costDocId, r]));
    const rows = sortRows(docs.map((d) => toRow(d, byCost.get(d.documentId))));

    // владелец видит все запросы, управляющая — свои
    const mine = isOwner(session) ? pendingAll : pendingAll.filter((r) => Number(r.requestedById) === Number(session?.id));
    const inMonth = new Map(docs.map((d) => [d.documentId, d]));
    const missing = [...new Set(mine.map((r) => r.costDocId).filter((id) => id && !inMonth.has(id)))];
    if (missing.length) {
      const other = await strapi.documents(COST_UID).findMany({
        status: 'published',
        filters: { documentId: { $in: missing } },
        fields: COST_FIELDS,
        limit: missing.length,
      });
      for (const d of other) inMonth.set(d.documentId, d);
    }
    const pending = mine.map((r) => {
      const cur = inMonth.get(r.costDocId);
      return { ...requestRow(r), cost: cur ? toRow(cur, r) : null };
    });

    return { month: from.slice(0, 7), rows, categories: this.categories(), payments: Object.keys(PAYMENTS), pending };
  },

  /** Автодополнение названий по записям за год. */
  async suggest({ now = new Date() }: { now?: Date } = {}) {
    const from = addDaysYmd(this._today(now), -SUGGEST_DAYS);
    const docs = await strapi.documents(COST_UID).findMany({
      status: 'published',
      filters: { date: { $gte: from } },
      fields: COST_FIELDS,
      limit: 5000,
    });
    return { items: suggestFrom(docs.map((d) => toRow(d))) };
  },

  async create({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const input = normalizeCostInput(body, this._today(now), this.categories());
    const doc = await strapi.documents(COST_UID).create({
      status: 'published',
      data: toDbData({ ...input, author: session?.username || null }),
      fields: COST_FIELDS,
    });
    const row = toRow(doc);
    this._log('cost_create', session, row.documentId, logSummary('Náklad', row), this._details(row));
    return { row };
  },

  /** Правка — только владелец; управляющая подаёт запрос. */
  async update({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    if (!isOwner(session)) throw new CostError(403, 'approval_required', 'Изменение затраты — через одобрение владельца');
    const doc = await this._findCost(id);
    const before = snapshotOf(doc);
    const { changes } = normalizeCostChanges(body, before, this._today(now), this.categories());
    const updated = await this._apply(doc.documentId, changes);
    const row = toRow(updated || { ...doc, ...changes });
    const diff = diffSummary(before, changes);
    this._log('cost_update', session, row.documentId, `${logSummary('Náklad upraven', row)} — ${diff}`, {
      ...this._details(row),
      změny: diff,
    });
    return { row, before };
  },

  /** Удаление — только владелец; навсегда. */
  async remove({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    if (!isOwner(session)) throw new CostError(403, 'approval_required', 'Удаление затраты — через одобрение владельца');
    const doc = await this._findCost(id);
    const row = toRow(doc);
    await this._delete(session, doc.documentId, now);
    this._log('cost_delete', session, row.documentId, logSummary('Náklad smazán', row), this._details(row));
    return { deleted: row.documentId, row };
  },

  /** Запрос управляющей на правку / удаление. */
  async request({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    if (isOwner(session)) throw new CostError(400, 'owner_direct', 'Владелец правит и удаляет затраты сразу');
    const b = body && typeof body === 'object' ? body : {};
    const action = String(b.action ?? '');
    if (action !== 'edit' && action !== 'delete') throw new CostError(400, 'bad_action', 'Неизвестный тип запроса');
    const doc = await this._findCost(id);
    const already = await this._pendingRequests({ costDocId: { $eq: doc.documentId } });
    if (already.length) throw new CostError(409, 'request_pending', 'По этой затрате уже есть запрос — дождитесь решения');

    const before = snapshotOf(doc);
    const changes = action === 'edit' ? normalizeCostChanges(b.changes, before, this._today(now), this.categories()).changes : null;
    const req = await strapi.documents(REQUEST_UID).create({
      data: {
        costDocId: doc.documentId,
        action,
        changes,
        before,
        baseUpdatedAt: doc.updatedAt ?? null,
        status: 'pending',
        requestedBy: session?.username || null,
        requestedById: Number(session?.id) || null,
      },
    });
    const row = toRow(doc, req);
    const diff = action === 'edit' ? diffSummary(before, changes) : '';
    const head = action === 'edit' ? 'Žádost o změnu' : 'Žádost o smazání';
    this._log('cost_request', session, doc.documentId, `${logSummary(head, row)}${diff ? ` — ${diff}` : ''}`, {
      ...this._details(row),
      žádost: diff || 'smazání',
    });
    return { request: requestRow(req), row };
  },

  /** Отозвать свой запрос. */
  async cancelRequest({ session, rid, now = new Date() }: { session: any; rid: unknown; now?: Date }) {
    const req = await this._findRequest(rid);
    if (Number(req.requestedById) !== Number(session?.id)) {
      throw new CostError(403, 'not_your_request', 'Отозвать запрос может только тот, кто его подал');
    }
    if (req.status !== 'pending') throw new CostError(409, 'request_closed', 'Запрос уже решён или отозван');
    await this._claim(req.documentId, { status: 'cancelled', decidedBy: session?.username || null, decidedAt: now });
    this._log('cost_cancel', session, req.costDocId, logSummary('Žádost stažena', req.before || {}), {
      žádost: req.action === 'delete' ? 'smazání' : diffSummary(req.before, req.changes),
    });
    return { request: requestRow({ ...req, status: 'cancelled' }) };
  },

  /** Одобрить запрос — применяет правку или удаляет. Только владелец. */
  async approve({ session, rid, now = new Date() }: { session: any; rid: unknown; now?: Date }) {
    if (!isOwner(session)) throw new CostError(403, 'owner_only', 'Одобряет только владелец');
    const req = await this._findRequest(rid);
    if (req.status !== 'pending') throw new CostError(409, 'request_closed', 'Запрос уже решён или отозван');

    const doc = await strapi.documents(COST_UID).findOne({ documentId: req.costDocId, status: 'published', fields: COST_FIELDS });
    if (!doc) {
      await this._claim(req.documentId, { status: 'cancelled', decidedBy: session?.username || null, decidedAt: now, decisionNote: 'затрата удалена' });
      throw notFound();
    }
    const current = snapshotOf(doc);
    if (!sameSnapshot(current, req.before)) {
      throw new CostError(409, 'cost_changed', 'Затрату изменили после запроса — проверьте и решите заново', {
        cost: toRow(doc, req),
      });
    }
    // правка проверяется ещё раз: категории или «сегодня» могли смениться
    const changes = req.action === 'edit' ? normalizeCostChanges(req.changes, current, this._today(now), this.categories()).changes : null;

    await this._claim(req.documentId, { status: 'approved', decidedBy: session?.username || null, decidedAt: now });
    let row;
    try {
      if (req.action === 'edit') {
        row = toRow((await this._apply(doc.documentId, changes)) || { ...doc, ...changes });
      } else {
        row = toRow(doc);
        await this._delete(session, doc.documentId, now);
      }
    } catch (e) {
      // не применилось — запрос снова ждёт
      await strapi.db.query(REQUEST_UID).updateMany({
        where: { documentId: req.documentId, status: 'approved' },
        data: { status: 'pending', decidedBy: null, decidedAt: null },
      });
      throw e;
    }
    const what = req.action === 'edit' ? diffSummary(current, changes) : 'smazání';
    this._log('cost_approve', session, doc.documentId, `${logSummary('Žádost schválena', row)} — ${what}`, {
      ...this._details(row),
      žádost: what,
      podal: req.requestedBy || '—',
    });
    return {
      request: requestRow({ ...req, status: 'approved', decidedBy: session?.username || null, decidedAt: now }),
      row: req.action === 'edit' ? row : null,
      deleted: req.action === 'delete' ? doc.documentId : null,
      before: current,
    };
  },

  /** Отклонить запрос с причиной. Только владелец. */
  async reject({ session, rid, body, now = new Date() }: { session: any; rid: unknown; body: any; now?: Date }) {
    if (!isOwner(session)) throw new CostError(403, 'owner_only', 'Отклоняет только владелец');
    const note = String(body?.note ?? '').trim();
    if (note.length > MAX_TEXT) throw new CostError(400, 'text_too_long', `Комментарий длиннее ${MAX_TEXT} символов`);
    const req = await this._findRequest(rid);
    if (req.status !== 'pending') throw new CostError(409, 'request_closed', 'Запрос уже решён или отозван');
    await this._claim(req.documentId, {
      status: 'rejected',
      decidedBy: session?.username || null,
      decidedAt: now,
      decisionNote: note || null,
    });
    const what = req.action === 'delete' ? 'smazání' : diffSummary(req.before, req.changes);
    this._log('cost_reject', session, req.costDocId, `${logSummary('Žádost zamítnuta', req.before || {})} — ${what}${note ? ` · ${cut(note, 80)}` : ''}`, {
      žádost: what,
      podal: req.requestedBy || '—',
      důvod: note || '—',
    });
    return { request: requestRow({ ...req, status: 'rejected', decidedBy: session?.username || null, decidedAt: now, decisionNote: note || null }) };
  },
};
