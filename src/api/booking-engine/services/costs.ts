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
 * Фаза 2 (s237): чеки — фото/PDF в закрытом каталоге `COST_FILES_DIR` (как сканы
 * сотрудников, utils/private-files.ts; коллекция `cost-file` без REST). Добавить чек
 * может и управляющая сразу (деньги не меняются), удалить — владелец сразу,
 * управляющая — запросом `file_delete`. «Повторить с прошлого месяца» (`recurring` +
 * `batch`, всё или ничего) и сигналы для «Сегодня» и дайджеста (`attention`).
 *
 * Верх файла — чистые функции (tests/costs.test.mjs), ниже — сервис.
 */

import {
  MAX_FILE_BYTES,
  detectFile,
  contentDisposition,
  openPrivateFile,
  privateDir,
  readHead,
  removePrivateFile,
  safeFileName,
  storePrivateFile,
} from '../../../utils/private-files';

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
export const FILE_UID = 'api::cost-file.cost-file';

/** Чеков на одну затрату — не больше. */
export const MAX_FILES_PER_COST = 5;
/** «Повторить с прошлого месяца» — затрат за один раз. */
export const MAX_BATCH = 30;
/** Постоянная — была в прошлом месяце и всего в ≥ 2 из стольких прошлых месяцев. */
export const RECURRING_MONTHS = 3;
export const RECURRING_MIN = 2;
/** «Ещё не внесена» — через столько дней после обычного дня. */
export const RECURRING_GRACE_DAYS = 3;

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

/** Чек наружу: без имени на диске. */
export const fileView = (f: any) => ({
  id: f.documentId,
  fileName: f.fileName || 'doklad',
  mime: f.mime || null,
  size: Number(f.size) || 0,
  uploadedBy: f.uploadedBy || null,
  createdAt: f.createdAt ?? null,
});

/** Строка ответа списка. `pending` — ожидающий запрос по этой затрате, `files` — её чеки. */
export const toRow = (doc: any, pending?: any, files: any[] = []) => {
  const s = snapshotOf(doc);
  const author = String(doc?.author ?? '').trim() || null;
  return {
    documentId: doc.documentId,
    ...s,
    vat: vatFromRatio(s.sum, s.noDph),
    author,
    // записи без автора внесены в панели Strapi (все до s236)
    viaPanel: !author,
    files: files.map(fileView),
    pendingRequest: pending
      ? { id: pending.documentId, action: pending.action, fileId: pending.fileId || null, requestedBy: pending.requestedBy || null }
      : null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

export const requestRow = (r: any) => ({
  id: r.documentId,
  costDocId: r.costDocId,
  action: r.action,
  fileId: r.fileId || null,
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

/** Предыдущие `n` месяцев до `month` (YYYY-MM), ближний первым. */
export const prevMonths = (month: string, n: number): string[] => {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
};

const lastDayOf = (month: string): number => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** День `day` в месяце `month`; 31-е в коротком месяце — последний день. */
export const dayInMonth = (month: string, day: number): string =>
  `${month}-${String(Math.min(Math.max(1, day), lastDayOf(month))).padStart(2, '0')}`;

/**
 * Постоянные расходы по записям прошлых месяцев: название (ключ без диакритики)
 * было в прошлом месяце И всего в ≥ RECURRING_MIN из RECURRING_MONTHS прошлых.
 * Требование «был в прошлом» отсекает брошенные названия (Noona после ухода,
 * «Google ADS» → «Google and Meta» в 09.2026). `usualDay` — медиана дней.
 */
export const recurringStats = (rows: any[], month: string) => {
  const prev = prevMonths(month, RECURRING_MONTHS);
  const byKey = new Map<string, { months: Set<string>; days: number[] }>();
  for (const r of rows) {
    const m = String(r.date ?? '').slice(0, 7);
    if (!prev.includes(m)) continue;
    const key = nameKey(r.name);
    if (!key) continue;
    const g = byKey.get(key) ?? { months: new Set(), days: [] };
    g.months.add(m);
    g.days.push(Number(String(r.date).slice(8, 10)));
    byKey.set(key, g);
  }
  const out = new Map<string, { usualDay: number; months: number }>();
  for (const [key, g] of byKey) {
    if (!g.months.has(prev[0]) || g.months.size < RECURRING_MIN) continue;
    const days = [...g.days].sort((a, b) => a - b);
    out.set(key, { usualDay: days[Math.floor((days.length - 1) / 2)], months: g.months.size });
  }
  return out;
};

/**
 * «Повторить с прошлого месяца»: записи прошлого месяца, кроме названий, уже
 * внесённых в `month`. Дата — тот же день в `month`; постоянные отмечены.
 */
export const repeatCandidates = (rows: any[], month: string) => {
  const [prev] = prevMonths(month, 1);
  const stats = recurringStats(rows, month);
  const have = new Set(rows.filter((r) => String(r.date ?? '').startsWith(month)).map((r) => nameKey(r.name)));
  return sortRows(rows.filter((r) => String(r.date ?? '').startsWith(prev)).map((r) => ({ ...r })))
    .reverse()
    .filter((r) => !have.has(nameKey(r.name)))
    .map((r) => {
      const st = stats.get(nameKey(r.name));
      return {
        sourceId: r.documentId,
        date: dayInMonth(month, Number(String(r.date).slice(8, 10))),
        name: r.name,
        category: r.category,
        sum: r.sum,
        noDph: r.noDph,
        vat: vatFromRatio(r.sum, r.noDph),
        payment: r.payment || null,
        recurring: !!st,
        usualDay: st?.usualDay ?? null,
      };
    });
};

/**
 * Постоянные, которые в месяце `today` ещё не внесены, хотя обычный день прошёл
 * на RECURRING_GRACE_DAYS (не позже последнего дня месяца).
 */
export const missingRecurring = (rows: any[], today: string) => {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const stats = recurringStats(rows, month);
  const have = new Set(rows.filter((r) => String(r.date ?? '').startsWith(month)).map((r) => nameKey(r.name)));
  const [prev] = prevMonths(month, 1);
  const last = new Map();
  for (const r of sortRows(rows.filter((x) => String(x.date ?? '').startsWith(prev)).map((x) => ({ ...x })))) {
    if (!last.has(nameKey(r.name))) last.set(nameKey(r.name), r);
  }
  const out = [];
  for (const [key, st] of stats) {
    if (have.has(key)) continue;
    if (day < Math.min(st.usualDay + RECURRING_GRACE_DAYS, lastDayOf(month))) continue;
    const r = last.get(key);
    out.push({ name: r.name, category: r.category, usualDay: st.usualDay, lastSum: r.sum, lastDate: r.date });
  }
  return out.sort((a, b) => a.usualDay - b.usualDay || a.name.localeCompare(b.name));
};

/** Пачка «повтора»: 1…MAX_BATCH записей, каждая — как новая затрата; ошибка — с номером строки. */
export const normalizeBatch = (body: any, today: string, categories: readonly string[]) => {
  const items = body && typeof body === 'object' ? body.items : null;
  if (!Array.isArray(items) || items.length === 0) throw new CostError(400, 'batch_empty', 'Выберите хотя бы одну затрату');
  if (items.length > MAX_BATCH) throw new CostError(400, 'batch_too_big', `За один раз — не больше ${MAX_BATCH} затрат`);
  return items.map((it, i) => {
    try {
      return normalizeCostInput(it, today, categories);
    } catch (e) {
      if (e instanceof CostError) throw new CostError(e.status, e.code, `Строка ${i + 1}: ${e.message}`, { index: i });
      throw e;
    }
  });
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

/** Что просили — для журнала. */
const requestWhat = (req: any): string =>
  req.action === 'delete' ? 'smazání' : req.action === 'file_delete' ? 'smazání dokladu' : diffSummary(req.before, req.changes);

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const COST_FIELDS = ['date', 'name', 'category', 'sum', 'noDph', 'comment', 'payment', 'author', 'createdAt', 'updatedAt'];

const isOwner = (session: any) => session?.role === 'owner';

const notFound = () => new CostError(404, 'not_found', 'Затрата не найдена');
const fileNotFound = () => new CostError(404, 'file_not_found', 'Чек не найден');

const FILE_FIELDS = ['costDocId', 'fileName', 'mime', 'size', 'uploadedBy', 'createdAt'];

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

  /** Удаление навсегда (все версии) + её чеки с диска + ожидающие запросы по ней — `cancelled`. */
  async _delete(session: any, documentId: string, now: Date) {
    await strapi.documents(COST_UID).delete({ documentId });
    await this._deleteFilesOf(documentId);
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
    const files = await this._filesFor(docs.map((d) => d.documentId));
    const rows = sortRows(docs.map((d) => toRow(d, byCost.get(d.documentId), files.get(d.documentId))));

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
    const otherFiles = missing.length ? await this._filesFor(missing) : new Map();
    const pending = mine.map((r) => {
      const cur = inMonth.get(r.costDocId);
      return { ...requestRow(r), cost: cur ? toRow(cur, r, files.get(r.costDocId) || otherFiles.get(r.costDocId)) : null };
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
    if (action !== 'edit' && action !== 'delete' && action !== 'file_delete') {
      throw new CostError(400, 'bad_action', 'Неизвестный тип запроса');
    }
    const doc = await this._findCost(id);
    const file = action === 'file_delete' ? await this._findFile(doc.documentId, b.fileId) : null;
    const already = await this._pendingRequests({ costDocId: { $eq: doc.documentId } });
    if (already.length) throw new CostError(409, 'request_pending', 'По этой затрате уже есть запрос — дождитесь решения');

    const before = snapshotOf(doc);
    const changes = action === 'edit' ? normalizeCostChanges(b.changes, before, this._today(now), this.categories()).changes : null;
    const req = await strapi.documents(REQUEST_UID).create({
      data: {
        costDocId: doc.documentId,
        action,
        changes,
        fileId: file ? file.documentId : null,
        before,
        baseUpdatedAt: doc.updatedAt ?? null,
        status: 'pending',
        requestedBy: session?.username || null,
        requestedById: Number(session?.id) || null,
      },
    });
    const row = toRow(doc, req);
    const diff = action === 'edit' ? diffSummary(before, changes) : action === 'file_delete' ? `doklad ${cut(file.fileName, 60)}` : '';
    const head = action === 'edit' ? 'Žádost o změnu' : action === 'file_delete' ? 'Žádost o smazání dokladu' : 'Žádost o smazání';
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
      žádost: requestWhat(req),
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
    if (req.action === 'file_delete') return this._approveFileDelete(session, req, doc, now);
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
    const what = requestWhat(req);
    this._log('cost_reject', session, req.costDocId, `${logSummary('Žádost zamítnuta', req.before || {})} — ${what}${note ? ` · ${cut(note, 80)}` : ''}`, {
      žádost: what,
      podal: req.requestedBy || '—',
      důvod: note || '—',
    });
    return { request: requestRow({ ...req, status: 'rejected', decidedBy: session?.username || null, decidedAt: now, decisionNote: note || null }) };
  },

  // ── чеки (Фаза 2) ──────────────────────────────────────────────────────

  /** Закрытый каталог чеков. Без env — чеки выключены (503). */
  async _filesDir() {
    const dir = await privateDir(process.env.COST_FILES_DIR, 'costs');
    if (!dir) throw new CostError(503, 'storage_not_configured', 'Хранилище чеков на сервере не настроено');
    return dir;
  },

  /** Чеки затрат: costDocId → [запись]. */
  async _filesFor(costDocIds: string[]) {
    const out = new Map<string, any[]>();
    const ids = [...new Set(costDocIds.filter(Boolean))];
    if (!ids.length) return out;
    const rows = await strapi.documents(FILE_UID).findMany({
      filters: { costDocId: { $in: ids } },
      fields: FILE_FIELDS,
      sort: [{ createdAt: 'asc' }],
      limit: ids.length * MAX_FILES_PER_COST + 50,
    });
    for (const f of rows) {
      if (!out.has(f.costDocId)) out.set(f.costDocId, []);
      out.get(f.costDocId).push(f);
    }
    return out;
  },

  /** Чек этой затраты (со storedName) или 404. */
  async _findFile(costDocId: string, fid: unknown) {
    const documentId = String(fid ?? '').trim();
    if (!DOC_ID.test(documentId)) throw fileNotFound();
    const rows = await strapi.documents(FILE_UID).findMany({
      filters: { documentId: { $eq: documentId }, costDocId: { $eq: costDocId } },
      fields: [...FILE_FIELDS, 'storedName'],
      limit: 1,
    });
    if (!rows[0]) throw fileNotFound();
    return rows[0];
  },

  /** Все чеки затраты — записи и файлы с диска (при удалении затраты). */
  async _deleteFilesOf(costDocId: string) {
    const rows = await strapi.documents(FILE_UID).findMany({
      filters: { costDocId: { $eq: costDocId } },
      fields: ['storedName'],
      limit: 100,
    });
    if (!rows.length) return;
    const dir = await this._filesDir().catch(() => null);
    for (const f of rows) {
      await strapi.documents(FILE_UID).delete({ documentId: f.documentId });
      await removePrivateFile(dir, f.storedName, `costs: чек ${f.documentId}`);
    }
  },

  async _removeFile(session: any, doc: any, file: any) {
    await strapi.documents(FILE_UID).delete({ documentId: file.documentId });
    await removePrivateFile(await this._filesDir().catch(() => null), file.storedName, `costs: чек ${file.documentId}`);
  },

  /**
   * Чек к затрате (multipart, поле `files`, один файл): JPG/PNG/WEBP/PDF по сигнатуре,
   * ≤ 10 МБ, ≤ MAX_FILES_PER_COST на затрату. Руководство — сразу (деньги не меняются).
   */
  async uploadFile({ session, id, files }: { session: any; id: unknown; files: any }) {
    const file = files?.files;
    if (!file || Array.isArray(file) || !file.filepath) throw new CostError(400, 'file_required', 'Выберите один файл');
    const size = Number(file.size) || 0;
    if (size <= 0) throw new CostError(400, 'file_empty', 'Файл пустой');
    if (size > MAX_FILE_BYTES) throw new CostError(413, 'file_too_big', 'Файл больше 10 МБ');
    const doc = await this._findCost(id);
    const type = detectFile(await readHead(file.filepath));
    if (!type) throw new CostError(400, 'bad_file_type', 'Поддерживаются JPG, PNG, WEBP и PDF');
    const existing = (await this._filesFor([doc.documentId])).get(doc.documentId) || [];
    if (existing.length >= MAX_FILES_PER_COST) {
      throw new CostError(409, 'too_many_files', `К затрате — не больше ${MAX_FILES_PER_COST} чеков`);
    }
    const fileName = safeFileName(file.originalFilename, type.ext, 'doklad');
    const dir = await this._filesDir();
    const { storedName } = await storePrivateFile(dir, file.filepath);
    let created;
    try {
      created = await strapi.documents(FILE_UID).create({
        data: { costDocId: doc.documentId, fileName, mime: type.mime, size, storedName, uploadedBy: session?.username || null },
      });
    } catch (e) {
      await removePrivateFile(dir, storedName, `costs: чек ${storedName}`);
      throw e;
    }
    const row = toRow(doc);
    this._log('cost_file_add', session, doc.documentId, `${logSummary('Doklad přidán', row)} — ${cut(fileName, 60)}`, {
      ...this._details(row),
      doklad: fileName,
    });
    return { file: fileView({ ...created, fileName, mime: type.mime, size, uploadedBy: session?.username || null }) };
  },

  /** Чек потоком (контроллер ставит заголовки). */
  async downloadFile({ id, fid }: { id: unknown; fid: unknown }) {
    const doc = await this._findCost(id);
    const file = await this._findFile(doc.documentId, fid);
    const opened = await openPrivateFile(await this._filesDir(), file.storedName);
    if (!opened) throw new CostError(404, 'file_missing', 'Файл чека на сервере не найден');
    const name = safeFileName(file.fileName, '', 'doklad');
    return { stream: opened.stream, size: opened.size, mime: file.mime || 'application/octet-stream', disposition: contentDisposition(name) };
  },

  /** Удалить чек — владелец сразу; управляющая — запросом `file_delete`. */
  async deleteFile({ session, id, fid }: { session: any; id: unknown; fid: unknown }) {
    if (!isOwner(session)) throw new CostError(403, 'approval_required', 'Удаление чека — через одобрение владельца');
    const doc = await this._findCost(id);
    const file = await this._findFile(doc.documentId, fid);
    await this._removeFile(session, doc, file);
    const row = toRow(doc);
    this._log('cost_file_delete', session, doc.documentId, `${logSummary('Doklad smazán', row)} — ${cut(file.fileName, 60)}`, {
      ...this._details(row),
      doklad: file.fileName || '—',
    });
    return { deleted: file.documentId };
  },

  /** Одобрение запроса на удаление чека: затрата не трогается, снимок не сверяется. */
  async _approveFileDelete(session: any, req: any, doc: any, now: Date) {
    let file;
    try {
      file = await this._findFile(doc.documentId, req.fileId);
    } catch (e) {
      await this._claim(req.documentId, { status: 'cancelled', decidedBy: session?.username || null, decidedAt: now, decisionNote: 'чек уже удалён' });
      throw e;
    }
    await this._claim(req.documentId, { status: 'approved', decidedBy: session?.username || null, decidedAt: now });
    await this._removeFile(session, doc, file);
    const row = toRow(doc);
    this._log('cost_approve', session, doc.documentId, `${logSummary('Žádost schválena', row)} — smazání dokladu ${cut(file.fileName, 60)}`, {
      ...this._details(row),
      žádost: `smazání dokladu ${file.fileName || ''}`.trim(),
      podal: req.requestedBy || '—',
    });
    return {
      request: requestRow({ ...req, status: 'approved', decidedBy: session?.username || null, decidedAt: now }),
      row,
      deleted: null,
      deletedFile: file.documentId,
      before: snapshotOf(doc),
    };
  },

  // ── «Повторить с прошлого месяца», «Сегодня», дайджест (Фаза 2) ────────

  /** Записи за RECURRING_MONTHS месяцев до `month` и сам `month` — строки toRow. */
  async _historyRows(month: string) {
    const from = `${prevMonths(month, RECURRING_MONTHS).at(-1)}-01`;
    const { to } = monthRange(month);
    const docs = await strapi.documents(COST_UID).findMany({
      status: 'published',
      filters: { date: { $gte: from, $lte: to } },
      fields: COST_FIELDS,
      limit: 5000,
    });
    return docs.map((d) => toRow(d));
  },

  /** Кандидаты на повтор в `month`: прошлый месяц без уже внесённых названий. */
  async recurring({ month }: { month: unknown }) {
    const { from } = monthRange(month);
    const key = from.slice(0, 7);
    return { month: key, items: repeatCandidates(await this._historyRows(key), key) };
  },

  /** Несколько затрат за раз: всё проверяется до записи; сбой посередине — созданные удаляются. */
  async batch({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const inputs = normalizeBatch(body, this._today(now), this.categories());
    const created = [];
    try {
      for (const input of inputs) {
        created.push(
          await strapi.documents(COST_UID).create({
            status: 'published',
            data: toDbData({ ...input, author: session?.username || null }),
            fields: COST_FIELDS,
          })
        );
      }
    } catch (e) {
      for (const d of created) {
        await strapi.documents(COST_UID).delete({ documentId: d.documentId }).catch((err) => {
          strapi.log.error(`costs: откат пачки — затрата ${d.documentId} не удалена: ${err.message}`);
        });
      }
      throw e;
    }
    const rows = created.map((d) => toRow(d));
    for (const row of rows) {
      this._log('cost_create', session, row.documentId, logSummary('Náklad (opakování)', row), this._details(row));
    }
    return { rows };
  },

  /** Ожидающих запросов (всех) — для дайджеста: только число, чат читают и администраторы. */
  async pendingCount() {
    return (await this._pendingRequests()).length;
  },

  /** «Сегодня»: запросы ждут одобрения (владельцу) и не внесённые постоянные расходы. */
  async attention({ session, now = new Date() }: { session: any; now?: Date }) {
    const today = this._today(now);
    const [rows, pending] = await Promise.all([
      this._historyRows(today.slice(0, 7)),
      isOwner(session) ? this._pendingRequests() : Promise.resolve(null),
    ]);
    return {
      today,
      pending: pending ? pending.length : null,
      missingRecurring: missingRecurring(rows, today),
    };
  },
};
