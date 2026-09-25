// @ts-nocheck
/**
 * Плановый график мастеров (s218, Фаза F плана «Управляющая»).
 *
 * Раньше графика как сущности не было: выходные мастера — блоки календаря трёх
 * происхождений (замороженное при cutover зеркало Noona, серии руками, разовые).
 * Серии кончались в разные даты, а часы салона продлеваются из Noona на +90 дней —
 * и сайт начинал продавать мастеру его выходные.
 *
 * МОДЕЛЬ. Документ `master-schedule` на мастера:
 *   templates — [{ from, days: {'0'..'6': Day} }] — шаблон недели с даты начала
 *               (ключи дней как getUTCDay: 0 = Ne), действует последний с from ≤ дата;
 *   overrides — { 'YYYY-MM-DD': Day + note/by/at } — исключения руководства;
 *   requests  — { 'YYYY-MM-DD': Day + note/by/at } — предложения администраторов,
 *               на блоки не влияют, пока руководство их не согласует.
 *   Day = { state: 'on' | 'off' | 'hours', from?, to? } (минуты от полуночи).
 *
 * МАТЕРИАЛИЗАЦИЯ. План превращается в обычные блоки календаря с ключом
 * `own|plan|<personal.documentId>` («Volno» — выходной, «Mimo směnu» — часы вне
 * смены) на каждую дату от сегодняшнего (пражского) дня до последней даты
 * `salon_hours` (дальше салон и так закрыт для записи). `reconcile` идемпотентен:
 * сравнивает желаемые блоки с имеющимися и доводит разницу; прошлые даты не
 * трогаются никогда. Запуск — после каждого сохранения и cron-ом каждый час
 * (новые даты окна, изменённые часы салона, самолечение). Движок записи и все
 * потребители блоков (сайт, дайджест, «Загрузка», «Сегодня») план видят ТОЛЬКО
 * через блоки — их менять не пришлось.
 *
 * Блоки плана из календаря не правятся и не удаляются (409 `plan_block` в
 * booking-engine) — иначе cron молча вернул бы удалённый блок.
 *
 * РОЛИ (решение владельца s218): шаблон и исключения — руководство (owner +
 * manager), сразу; администратор может только ПРЕДЛОЖИТЬ изменение дня —
 * оно действует после согласования; мастер сам себе ничего не меняет (ручки
 * ему закрыты в контроллере).
 *
 * Журнал — calendar_logs, entityType `schedule`.
 *
 * Верх файла — чистые функции (tests/master-schedule.test.mjs), ниже — сервис.
 */

import { minToHHMM, pragueDateOf, pragueMinOf, pragueMinToUtcIso, utcToPragueMinClamped } from './slots-core';

const SCHEDULE_UID = 'api::master-schedule.master-schedule';
const TIME_BLOCK_UID = 'api::time-block.time-block';
const SALON_HOUR_UID = 'api::salon-hour.salon-hour';
const BOOKING_UID = 'api::booking.booking';
const PERSONAL_UID = 'api::personal.personal';
const TIME_OFF_UID = 'api::time-off.time-off';

export class ScheduleError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Префикс ключа блоков плана; полный ключ — `own|plan|<personal.documentId>`. */
export const PLAN_KEY_PREFIX = 'own|plan|';
export const planKeyOf = (personalDocId: string) => `${PLAN_KEY_PREFIX}${personalDocId}`;
export const isPlanKey = (key: unknown) => String(key ?? '').startsWith(PLAN_KEY_PREFIX);

export const PLAN_OFF_TITLE = 'Volno';
export const PLAN_PARTIAL_TITLE = 'Mimo směnu';
export const PLAN_AUTHOR = 'Plán směn';

/** Окно оценки старых блоков за горизонтом часов салона (как ставили руками). */
export const DEFAULT_OPEN_MIN = 600;
export const DEFAULT_CLOSE_MIN = 1140;

export const MAX_FUTURE_DAYS = 366;
/** Горизонт материализации — не дальше этого, даже если часы салона заведены дальше. */
export const MAX_HORIZON_DAYS = 400;
export const MAX_CHANGES = 62;
export const MAX_NOTE = 200;
export const STEP = 15;
/** Старая повторяющаяся серия — от стольких будущих дат. */
export const LEGACY_MIN_DATES = 3;

export const DAY_STATES = ['on', 'off', 'hours'] as const;
/** Дни недели по-чешски, индекс = getUTCDay. */
export const DOW_CS = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
/** Порядок показа Po..Ne. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

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

export const datesBetween = (from: string, to: string): string[] => {
  const out = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
};

export const dowOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

const fmtDay = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** Месяц YYYY-MM → [первый, последний день]. */
export const monthRange = (month: unknown): [string, string] => {
  const m = String(month ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new ScheduleError(400, 'bad_month', 'Месяц — ГГГГ-ММ');
  const [y, mo] = m.split('-').map(Number);
  if (mo < 1 || mo > 12 || y < 2025 || y > 2100) throw new ScheduleError(400, 'bad_month', 'Месяц — ГГГГ-ММ');
  const first = `${m}-01`;
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return [first, last];
};

/**
 * Проверка дня. `allowTemplate` — в изменениях дня допустимо «как в шаблоне»
 * (убрать исключение). Часы — кратно 15 минутам, начало раньше конца.
 */
export const normalizeDay = (raw: any, { allowTemplate = false } = {}) => {
  const state = String(raw?.state ?? '');
  if (allowTemplate && state === 'template') return { state: 'template' };
  if (!(DAY_STATES as readonly string[]).includes(state)) {
    throw new ScheduleError(400, 'bad_state', 'День: выходной, весь день или часы');
  }
  if (state !== 'hours') return { state };
  const from = Number(raw?.from);
  const to = Number(raw?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from % STEP || to % STEP || from < 0 || to > 1440) {
    throw new ScheduleError(400, 'bad_hours', 'Часы — с шагом 15 минут');
  }
  if (to <= from) throw new ScheduleError(400, 'bad_hours', 'Конец смены раньше начала');
  return { state, from, to };
};

/** Чистый день из хранимой записи (лишние поля — note/by/at — отбрасываются). */
export const pickDay = (raw: any) => {
  const s = raw?.state;
  if (s === 'off') return { state: 'off' };
  if (s === 'hours' && Number.isFinite(Number(raw.from)) && Number.isFinite(Number(raw.to))) {
    return { state: 'hours', from: Number(raw.from), to: Number(raw.to) };
  }
  return { state: 'on' };
};

export const sameDay = (a: any, b: any) => {
  const x = pickDay(a);
  const y = pickDay(b);
  return x.state === y.state && (x.state !== 'hours' || (x.from === y.from && x.to === y.to));
};

/** Шаблон недели: все 7 дней обязательны. */
export const normalizeTemplateDays = (raw: any) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduleError(400, 'bad_template', 'Нет дней недели');
  }
  const out = {};
  for (let i = 0; i <= 6; i++) {
    const key = String(i);
    if (!hasOwn(raw, key)) throw new ScheduleError(400, 'bad_template', `Заполните день: ${DOW_CS[i]}`);
    out[key] = normalizeDay(raw[key]);
  }
  return out;
};

export const normalizeNote = (raw: unknown) => {
  const note = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (note.length > MAX_NOTE) throw new ScheduleError(400, 'note_too_long', `Заметка длиннее ${MAX_NOTE} символов`);
  return note;
};

/** Шаблоны по возрастанию даты начала (битые записи отброшены). */
export const sortedTemplates = (templates: any) =>
  (Array.isArray(templates) ? templates : [])
    .filter((t) => t && isValidYmd(t.from) && t.days && typeof t.days === 'object')
    .sort((a, b) => a.from.localeCompare(b.from));

export const templateFor = (templates: any, date: string) => {
  let found = null;
  for (const t of sortedTemplates(templates)) if (t.from <= date) found = t;
  return found;
};

/** Эффективный день: исключение → шаблон на дату → «работает всё окно» (как без плана). */
export const effectiveDay = (schedule: any, date: string) => {
  const o = schedule?.overrides?.[date];
  if (o && typeof o === 'object') return { day: pickDay(o), source: 'override' };
  const t = templateFor(schedule?.templates, date);
  if (t) return { day: pickDay(t.days[String(dowOf(date))]), source: 'template' };
  return { day: { state: 'on' }, source: 'none' };
};

/** Окно салона даты или null (строки нет / закрыто). */
export const salonWindow = (hour: any) => {
  const o = Number(hour?.openMin);
  const c = Number(hour?.closeMin);
  if (!hour || hour.openMin == null || hour.closeMin == null || !Number.isFinite(o) || !Number.isFinite(c) || c <= o) {
    return null;
  }
  return { openMin: o, closeMin: c };
};

/** Блоки, которыми день плана закрывает окно салона. */
export const desiredBlocks = (day: any, win: { openMin: number; closeMin: number } | null) => {
  if (!win) return [];
  const d = pickDay(day);
  if (d.state === 'on') return [];
  if (d.state === 'off') return [{ startMin: win.openMin, endMin: win.closeMin, title: PLAN_OFF_TITLE }];
  const out = [];
  const a = Math.min(Math.max(d.from, win.openMin), win.closeMin);
  const b = Math.max(Math.min(d.to, win.closeMin), win.openMin);
  if (a > win.openMin) out.push({ startMin: win.openMin, endMin: a, title: PLAN_PARTIAL_TITLE });
  if (b < win.closeMin && b > a) out.push({ startMin: b, endMin: win.closeMin, title: PLAN_PARTIAL_TITLE });
  if (b <= a && !out.length) out.push({ startMin: win.openMin, endMin: win.closeMin, title: PLAN_PARTIAL_TITLE });
  return out;
};

const blockSig = (b: { startMin: number; endMin: number; title: string }) => `${b.startMin}-${b.endMin}-${b.title}`;

/**
 * Разница блоков плана: `existing` — [{documentId, date, startMin, endMin, title}]
 * в пределах `dates`, `desiredByDate` — Map даты → желаемые блоки.
 * Совпадающие блоки не трогаются, дубли и лишние — удаляются.
 */
export const diffPlanBlocks = (existing: any[], desiredByDate: Map<string, any[]>, dates: string[]) => {
  const inRange = new Set(dates);
  const byDate = new Map();
  for (const b of existing) {
    const d = String(b.date);
    if (!inRange.has(d)) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(b);
  }
  const toCreate = [];
  const toDelete = [];
  for (const d of dates) {
    const want = desiredByDate.get(d) || [];
    const have = byDate.get(d) || [];
    const left = new Map();
    for (const w of want) left.set(blockSig(w), (left.get(blockSig(w)) || 0) + 1);
    for (const h of have) {
      const sig = blockSig(h);
      if (left.get(sig) > 0) left.set(sig, left.get(sig) - 1);
      else toDelete.push(h);
    }
    for (const w of want) {
      const sig = blockSig(w);
      if (left.get(sig) > 0) {
        left.set(sig, left.get(sig) - 1);
        toCreate.push({ date: d, ...w });
      }
    }
  }
  return { toCreate, toDelete };
};

/** Покрыт ли интервал [s, e) объединением интервалов. */
export const covers = (intervals: Array<{ startMin: number; endMin: number }>, s: number, e: number) => {
  if (e <= s) return true;
  const list = [...intervals].sort((a, b) => a.startMin - b.startMin);
  let at = s;
  for (const i of list) {
    if (i.startMin > at) break;
    if (i.endMin > at) at = i.endMin;
    if (at >= e) return true;
  }
  return at >= e;
};

/** Подпись дня для журнала и Telegram. */
export const dayLabel = (day: any) => {
  if (day?.state === 'template') return 'podle šablony';
  const d = pickDay(day);
  if (d.state === 'off') return 'volno';
  if (d.state === 'hours') return `${minToHHMM(d.from)}–${minToHHMM(d.to)}`;
  return 'celý den';
};

export const templateLabel = (days: any) =>
  WEEK_ORDER.map((i) => `${DOW_CS[i]} ${dayLabel(days?.[String(i)])}`).join(' · ');

const sameInstant = (a: unknown, b: unknown): boolean => {
  if (a == null || a === '' || b == null || b === '') return (a == null || a === '') && (b == null || b === '');
  const ta = new Date(String(a)).getTime();
  const tb = new Date(String(b)).getTime();
  return Number.isFinite(ta) && ta === tb;
};

/**
 * Защита от одновременной правки: `base` — updatedAt документа, который видел
 * клиент (null — плана не было). `undefined` — не проверять.
 */
export const assertBase = (base: unknown, current: any) => {
  if (base === undefined) return;
  if (!sameInstant(base, current?.updatedAt ?? null)) {
    throw new ScheduleError(409, 'schedule_changed', 'План этого мастера только что изменили в другом окне — обновите страницу');
  }
};

/**
 * Изменения дней: [{date, state, from?, to?}] + общая заметка. Даты — от сегодня
 * до года вперёд, без повторов.
 */
export const normalizeChanges = (body: any, today: string) => {
  const list = Array.isArray(body?.changes) ? body.changes : null;
  if (!list || !list.length) throw new ScheduleError(400, 'no_changes', 'Не выбрано ни одного дня');
  if (list.length > MAX_CHANGES) throw new ScheduleError(400, 'too_many_changes', `Не больше ${MAX_CHANGES} дней за раз`);
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const date = String(c?.date ?? '').trim();
    if (!isValidYmd(date)) throw new ScheduleError(400, 'bad_date', 'Дата — ГГГГ-ММ-ДД');
    if (date < today) throw new ScheduleError(400, 'date_in_past', 'Прошедшие дни не меняются');
    if (date > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new ScheduleError(400, 'date_too_far', 'Дата слишком далеко в будущем');
    if (seen.has(date)) throw new ScheduleError(400, 'duplicate_date', 'Дата повторяется');
    seen.add(date);
    out.push({ date, day: normalizeDay(c, { allowTemplate: true }) });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { changes: out, note: normalizeNote(body?.note) };
};

/** Строка журнала: «Заголовок: мастер · кусок · кусок» (parseSummary берёт текст после «: »). */
export const logSummary = (kind: string, name: string, pieces: string[]) => {
  const head = {
    template: 'Plán směn — šablona',
    day: 'Plán směn — změna dne',
    request: 'Plán směn — návrh ke schválení',
    approve: 'Plán směn — návrh schválen',
    reject: 'Plán směn — návrh zamítnut',
    legacy: 'Plán směn — nahrazeny staré bloky',
  }[kind];
  return `${head}: ${[name || '—', ...pieces].join(' · ')}`;
};

const changePieces = (changes: any[]) => changes.map((c) => `${fmtDay(c.date)} ${dayLabel(c.day)}`);

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PERSON_FIELDS = ['name', 'position', 'isActive', 'noonaEmployeeId', 'calendarOrder'];

/** Мастер с колонкой в календаре — только ему нужен план. */
export const isPlannedMaster = (p: any) =>
  Boolean(p) &&
  p.position === 'master' &&
  p.isActive !== false &&
  Boolean(String(p.noonaEmployeeId ?? '').trim()) &&
  !String(p.name ?? '').trim().startsWith('❌');

const isManagement = (session: any) => session?.role === 'owner' || session?.role === 'manager';

const toSchedule = (doc: any) =>
  doc
    ? {
        documentId: doc.documentId,
        updatedAt: doc.updatedAt ?? null,
        templates: sortedTemplates(doc.templates),
        overrides: doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {},
        requests: doc.requests && typeof doc.requests === 'object' ? doc.requests : {},
      }
    : null;

/** Ключ блока-интервала по пражским минутам его даты. */
const blockMinutes = (b: any) => {
  const d = String(b.date);
  return { startMin: utcToPragueMinClamped(b.startsAt, d), endMin: utcToPragueMinClamped(b.endsAt, d) };
};

const belongsTo = (person: any, item: any) =>
  item?.employee?.documentId === person.documentId ||
  item?.engineEmployeeId === person.documentId ||
  (person.noonaEmployeeId && item?.noonaEmployeeId === person.noonaEmployeeId);

export default {
  async _masters() {
    const list = await strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { position: { $eq: 'master' }, isActive: { $eq: true } },
      fields: PERSON_FIELDS,
      limit: 200,
    });
    return list
      .filter(isPlannedMaster)
      .sort((a, b) => (a.calendarOrder ?? 999) - (b.calendarOrder ?? 999) || String(a.name).localeCompare(String(b.name)));
  },

  async _master(documentId: unknown) {
    const id = String(documentId ?? '').trim();
    if (!DOC_ID.test(id)) throw new ScheduleError(404, 'master_not_found', 'Мастер не найден');
    const p = await strapi.documents(PERSONAL_UID).findOne({ documentId: id, status: 'published', fields: PERSON_FIELDS });
    if (!isPlannedMaster(p)) throw new ScheduleError(404, 'master_not_found', 'Мастер не найден или не работает в календаре');
    return p;
  },

  async _scheduleOf(personalDocId: string) {
    const found = await strapi.documents(SCHEDULE_UID).findMany({
      filters: { personal: { documentId: { $eq: personalDocId } } },
      fields: ['templates', 'overrides', 'requests', 'updatedAt'],
      sort: ['createdAt:asc'],
      limit: 5,
    });
    return found[0] || null;
  },

  async _write(person: any, cur: any, data: any) {
    if (cur) {
      await strapi.documents(SCHEDULE_UID).update({ documentId: cur.documentId, data });
      return this._scheduleOf(person.documentId);
    }
    await strapi.documents(SCHEDULE_UID).create({
      data: { templates: [], overrides: {}, requests: {}, ...data, personal: { documentId: person.documentId } },
    });
    return this._scheduleOf(person.documentId);
  },

  /** Последняя дата, на которую заведены часы салона (граница записи). */
  async _horizon(today: string) {
    const rows = await strapi.documents(SALON_HOUR_UID).findMany({
      filters: { date: { $gte: today } },
      fields: ['date'],
      sort: ['date:desc'],
      limit: 1,
    });
    const last = rows[0] ? String(rows[0].date) : null;
    const cap = addDaysYmd(today, MAX_HORIZON_DAYS);
    return last && last > cap ? cap : last;
  },

  async _hours(from: string, to: string) {
    const rows = await strapi.documents(SALON_HOUR_UID).findMany({
      filters: { date: { $gte: from, $lte: to } },
      fields: ['date', 'openMin', 'closeMin'],
      limit: 1000,
    });
    return new Map(rows.map((h) => [String(h.date), h]));
  },

  async _planBlocks(person: any, from: string, to: string) {
    const rows = await strapi.documents(TIME_BLOCK_UID).findMany({
      filters: { noonaKey: { $eq: planKeyOf(person.documentId) }, date: { $gte: from, $lte: to } },
      fields: ['date', 'startsAt', 'endsAt', 'title'],
      limit: 5000,
    });
    return rows.map((b) => ({ documentId: b.documentId, date: String(b.date), title: b.title || '', ...blockMinutes(b) }));
  },

  /**
   * Довести блоки плана мастера на [from, to] (from не раньше сегодня, to не
   * дальше горизонта часов салона). Возвращает число созданных и удалённых.
   */
  async reconcile({ person, schedule, from = null, to = null, now = new Date() }) {
    const today = PRAGUE_DAY.format(now);
    const horizon = await this._horizon(today);
    const start = from && from > today ? from : today;
    const end = horizon && (!to || to > horizon) ? horizon : to;
    if (!end || end < start) return { created: 0, deleted: 0 };
    const dates = datesBetween(start, end);
    const [hours, existing] = await Promise.all([this._hours(start, end), this._planBlocks(person, start, end)]);
    const desired = new Map();
    const planned = isPlannedMaster(person);
    for (const d of dates) {
      desired.set(d, planned ? desiredBlocks(effectiveDay(schedule, d).day, salonWindow(hours.get(d))) : []);
    }
    const { toCreate, toDelete } = diffPlanBlocks(existing, desired, dates);
    for (const b of toDelete) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
    const approvedAt = new Date().toISOString();
    for (const b of toCreate) {
      await strapi.documents(TIME_BLOCK_UID).create({
        data: {
          noonaKey: planKeyOf(person.documentId),
          noonaBlockedId: '',
          noonaEmployeeId: person.noonaEmployeeId || '',
          // связь объектом — documentId с ведущей цифрой Strapi принял бы за id
          employee: { documentId: person.documentId },
          employeeNameRaw: person.name,
          date: b.date,
          startsAt: pragueMinToUtcIso(b.date, b.startMin),
          endsAt: pragueMinToUtcIso(b.date, b.endMin),
          title: b.title,
          theme: '',
          createdByName: PLAN_AUTHOR,
          approvalStatus: 'approved',
          approvedByName: PLAN_AUTHOR,
          approvedAt,
        },
      });
    }
    if (toCreate.length || toDelete.length) {
      strapi.log.info(
        `master-schedule: ${person.name} ${start}..${end} +${toCreate.length} −${toDelete.length} plan block(s)`
      );
    }
    return { created: toCreate.length, deleted: toDelete.length };
  },

  /** Cron: все планы. План мастера, который перестал быть мастером, снимает свои будущие блоки. */
  async reconcileAll({ now = new Date() } = {}) {
    const docs = await strapi.documents(SCHEDULE_UID).findMany({
      fields: ['templates', 'overrides', 'requests', 'updatedAt'],
      populate: { personal: { fields: PERSON_FIELDS } },
      limit: 500,
    });
    let created = 0;
    let deleted = 0;
    for (const doc of docs) {
      if (!doc.personal?.documentId) continue;
      // связь из non-D&P документа может вести на черновик карточки — поля берём из опубликованной
      const person =
        (await strapi.documents(PERSONAL_UID).findOne({
          documentId: doc.personal.documentId,
          status: 'published',
          fields: PERSON_FIELDS,
        })) || { ...doc.personal, isActive: false };
      try {
        const r = await this.reconcile({ person, schedule: toSchedule(doc), now });
        created += r.created;
        deleted += r.deleted;
      } catch (e) {
        strapi.log.error(`master-schedule reconcile ${person.name} failed: ${e.message}`);
      }
    }
    return { schedules: docs.length, created, deleted };
  },

  /** Активные ещё не начавшиеся брони мастера, попадающие в желаемые нерабочие интервалы. */
  async _conflicts(person: any, schedule: any, from: string, to: string, now: Date) {
    const today = PRAGUE_DAY.format(now);
    const start = from > today ? from : today;
    if (to < start) return [];
    const [hours, found] = await Promise.all([
      this._hours(start, to),
      strapi.documents(BOOKING_UID).findMany({
        filters: {
          status: 'active',
          date: { $gte: start, $lte: to },
          $or: [
            { employee: { documentId: { $eq: person.documentId } } },
            { engineEmployeeId: { $eq: person.documentId } },
            { noonaEmployeeId: { $eq: person.noonaEmployeeId } },
          ],
        },
        fields: ['date', 'startsAt', 'endsAt', 'clientNameRaw', 'internal'],
        sort: ['startsAt:asc'],
        limit: 1000,
      }),
    ]);
    const nowMs = now.getTime();
    const rows = [];
    for (const b of found) {
      if (!b.startsAt || new Date(b.startsAt).getTime() <= nowMs) continue;
      const d = String(b.date);
      const win = salonWindow(hours.get(d)) || { openMin: DEFAULT_OPEN_MIN, closeMin: DEFAULT_CLOSE_MIN };
      const blocks = desiredBlocks(effectiveDay(schedule, d).day, win);
      const s = utcToPragueMinClamped(b.startsAt, d);
      const e = b.endsAt ? utcToPragueMinClamped(b.endsAt, d) : s + 15;
      if (!blocks.some((x) => x.startMin < e && x.endMin > s)) continue;
      rows.push({
        documentId: b.documentId,
        date: d,
        time: pragueDateOf(b.startsAt) === d ? minToHHMM(pragueMinOf(b.startsAt)) : null,
        client: String(b.clientNameRaw ?? '').trim() || null,
        internal: b.internal === true,
      });
    }
    return rows;
  },

  _log(action: string, session: any, person: any, entityDocId: string, summary: string, details: Record<string, unknown>) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'schedule',
        actorName: session?.username || '',
        entityDocId,
        employeeName: person?.name || '',
        summary,
        details,
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  _notifyRequest(person: any, session: any, changes: any[], note: string) {
    const lines = [
      '🗓 <b>Změna plánu směn čeká na schválení</b>',
      `💇 ${person.name}`,
      ...changes.map((c) => `• ${fmtDay(c.date)} — ${dayLabel(c.day)}`),
      note ? `📝 ${note}` : '',
      `👤 navrhl/a: ${session?.username || '—'}`,
      '',
      'Schvalte v admin → Plán směn nebo v kalendáři «Ke schválení».',
    ].filter(Boolean);
    strapi
      .service('api::booking-engine.booking-notify')
      .sendTelegram(lines.join('\n'))
      .catch((e) => strapi.log.error(`schedule request telegram failed: ${e.message}`));
  },

  /** Сетка месяца: мастера × дни. */
  async grid({ month, session, now = new Date() }) {
    const [first, last] = monthRange(month);
    const today = PRAGUE_DAY.format(now);
    const masters = await this._masters();
    const ids = masters.map((m) => m.documentId);
    const noonaIds = masters.map((m) => m.noonaEmployeeId).filter(Boolean);
    const [docs, hours, horizon, timeOffs, blocks, bookings] = await Promise.all([
      ids.length
        ? strapi.documents(SCHEDULE_UID).findMany({
            filters: { personal: { documentId: { $in: ids } } },
            fields: ['templates', 'overrides', 'requests', 'updatedAt'],
            populate: { personal: { fields: ['name'] } },
            sort: ['createdAt:asc'],
            limit: 500,
          })
        : [],
      this._hours(first, last),
      this._horizon(today),
      ids.length
        ? strapi.documents(TIME_OFF_UID).findMany({
            filters: {
              personal: { documentId: { $in: ids } },
              startDate: { $lte: last },
              endDate: { $gte: first },
            },
            fields: ['type', 'startDate', 'endDate'],
            populate: { personal: { fields: ['name'] } },
            limit: 500,
          })
        : [],
      noonaIds.length
        ? strapi.documents(TIME_BLOCK_UID).findMany({
            filters: {
              date: { $gte: first, $lte: last },
              noonaEmployeeId: { $in: noonaIds },
              $or: [{ approvalStatus: { $null: true } }, { approvalStatus: 'approved' }],
            },
            fields: ['date', 'startsAt', 'endsAt', 'title', 'noonaEmployeeId', 'noonaKey'],
            limit: 10000,
          })
        : [],
      ids.length
        ? strapi.documents(BOOKING_UID).findMany({
            filters: { status: 'active', date: { $gte: first, $lte: last } },
            fields: ['date', 'noonaEmployeeId', 'engineEmployeeId'],
            populate: { employee: { fields: ['name'] } },
            limit: 10000,
          })
        : [],
    ]);

    const scheduleByPerson = new Map();
    for (const d of docs) {
      const pid = d.personal?.documentId;
      if (pid && !scheduleByPerson.has(pid)) scheduleByPerson.set(pid, d);
    }
    const dates = datesBetween(first, last);

    const rows = masters.map((m) => {
      const schedule = toSchedule(scheduleByPerson.get(m.documentId));
      const days = {};
      for (const d of dates) {
        const eff = effectiveDay(schedule, d);
        const req = schedule?.requests?.[d];
        const off = timeOffs.find(
          (t) => t.personal?.documentId === m.documentId && t.startDate <= d && t.endDate >= d
        );
        const other = blocks
          .filter((b) => b.noonaEmployeeId === m.noonaEmployeeId && String(b.date) === d && !isPlanKey(b.noonaKey))
          .map((b) => ({ title: b.title || 'Blokace', ...blockMinutes(b) }))
          .sort((a, b) => a.startMin - b.startMin);
        days[d] = {
          ...eff.day,
          source: eff.source,
          override: eff.source === 'override' ? { note: schedule.overrides[d].note || null, by: schedule.overrides[d].by || null } : null,
          request: req
            ? { ...pickDay(req), state: req.state === 'template' ? 'template' : pickDay(req).state, note: req.note || null, by: req.by || null, at: req.at || null }
            : null,
          timeOff: off ? off.type : null,
          blocks: other,
          bookings: bookings.filter((b) => String(b.date) === d && belongsTo(m, b)).length,
        };
      }
      return {
        documentId: m.documentId,
        name: m.name,
        schedule: schedule
          ? { updatedAt: schedule.updatedAt, templates: schedule.templates }
          : { updatedAt: null, templates: [] },
        days,
      };
    });

    return {
      month: first.slice(0, 7),
      today,
      horizon,
      canManage: isManagement(session),
      dates: dates.map((d) => {
        const w = salonWindow(hours.get(d));
        return { date: d, openMin: w?.openMin ?? null, closeMin: w?.closeMin ?? null };
      }),
      masters: rows,
    };
  },

  /** Предпросмотр: брони, которые окажутся в нерабочем времени после изменения. */
  async preview({ personal, body, now = new Date() }) {
    const person = await this._master(personal);
    const today = PRAGUE_DAY.format(now);
    const cur = toSchedule(await this._scheduleOf(person.documentId)) || { templates: [], overrides: {}, requests: {} };
    let next;
    let from;
    let to;
    if (body?.template) {
      const tFrom = String(body.template.from ?? '').trim();
      if (!isValidYmd(tFrom)) throw new ScheduleError(400, 'bad_date', 'Дата начала — ГГГГ-ММ-ДД');
      const days = normalizeTemplateDays(body.template.days);
      next = { ...cur, templates: [...cur.templates.filter((t) => t.from < tFrom), { from: tFrom, days }] };
      from = tFrom;
      to = addDaysYmd(today, MAX_FUTURE_DAYS);
    } else {
      const { changes } = normalizeChanges(body, today);
      const overrides = { ...cur.overrides };
      for (const c of changes) {
        if (c.day.state === 'template') delete overrides[c.date];
        else overrides[c.date] = c.day;
      }
      next = { ...cur, overrides };
      from = changes[0].date;
      to = changes[changes.length - 1].date;
      const all = await this._conflicts(person, next, from, to, now);
      const want = new Set(changes.map((c) => c.date));
      return { conflicts: all.filter((r) => want.has(r.date)) };
    }
    return { conflicts: await this._conflicts(person, next, from, to, now) };
  },

  /** Шаблон недели с даты `from` (руководство). Более поздние шаблоны он перекрывает. */
  async saveTemplate({ session, personal, body, now = new Date() }) {
    if (!isManagement(session)) throw new ScheduleError(403, 'management_only', 'Шаблон меняет только руководство');
    const person = await this._master(personal);
    const today = PRAGUE_DAY.format(now);
    const from = String(body?.from ?? '').trim();
    if (!isValidYmd(from)) throw new ScheduleError(400, 'bad_date', 'Дата начала — ГГГГ-ММ-ДД');
    if (from < today) throw new ScheduleError(400, 'date_in_past', 'Шаблон действует с сегодняшнего дня или позже');
    if (from > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new ScheduleError(400, 'date_too_far', 'Дата слишком далеко в будущем');
    const days = normalizeTemplateDays(body?.days);

    const doc = await this._scheduleOf(person.documentId);
    assertBase(body?.base, doc);
    const cur = toSchedule(doc);
    const kept = (cur?.templates || []).filter((t) => t.from < from);
    const replaced = (cur?.templates || []).filter((t) => t.from >= from).map((t) => t.from);
    const templates = [...kept, { from, days, by: session?.username || '', at: now.toISOString() }];
    const saved = await this._write(person, doc, { templates });
    const sched = toSchedule(saved);
    const r = await this.reconcile({ person, schedule: sched, from, now });
    const conflicts = await this._conflicts(person, sched, from, addDaysYmd(today, MAX_FUTURE_DAYS), now);
    this._log(
      'schedule_template',
      session,
      person,
      saved.documentId,
      logSummary('template', person.name, [`od ${fmtDay(from)}`, templateLabel(days)]),
      {
        mistr: person.name,
        od: fmtDay(from),
        šablona: templateLabel(days),
        nahrazeno: replaced.length ? replaced.map(fmtDay).join(', ') : null,
        bloky: `+${r.created} −${r.deleted}`,
      }
    );
    return { updatedAt: saved.updatedAt, reconcile: r, conflicts, replacedTemplates: replaced };
  },

  /**
   * Изменение дней. Руководство — сразу в исключения (и снимает предложения на
   * эти даты), администратор — только предложение на согласование.
   */
  async saveDays({ session, personal, body, now = new Date() }) {
    const person = await this._master(personal);
    const today = PRAGUE_DAY.format(now);
    const { changes, note } = normalizeChanges(body, today);
    const doc = await this._scheduleOf(person.documentId);
    assertBase(body?.base, doc);
    const cur = toSchedule(doc) || { templates: [], overrides: {}, requests: {} };
    const by = session?.username || '';
    const at = now.toISOString();

    if (!isManagement(session)) {
      const requests = { ...cur.requests };
      for (const c of changes) requests[c.date] = { ...c.day, note: note || null, by, at };
      const saved = await this._write(person, doc, { requests });
      this._log(
        'schedule_request',
        session,
        person,
        saved.documentId,
        logSummary('request', person.name, [...changePieces(changes), ...(note ? [note] : [])]),
        { mistr: person.name, dny: changePieces(changes).join(', '), poznámka: note || null, stav: 'čeká na schválení' }
      );
      this._notifyRequest(person, session, changes, note);
      return { updatedAt: saved.updatedAt, pending: true, reconcile: { created: 0, deleted: 0 }, conflicts: [] };
    }

    const overrides = { ...cur.overrides };
    const requests = { ...cur.requests };
    for (const c of changes) {
      if (c.day.state === 'template') delete overrides[c.date];
      else overrides[c.date] = { ...c.day, note: note || null, by, at };
      delete requests[c.date];
    }
    const saved = await this._write(person, doc, { overrides, requests });
    const sched = toSchedule(saved);
    const from = changes[0].date;
    const to = changes[changes.length - 1].date;
    const r = await this.reconcile({ person, schedule: sched, from, to, now });
    const want = new Set(changes.map((c) => c.date));
    const conflicts = (await this._conflicts(person, sched, from, to, now)).filter((x) => want.has(x.date));
    this._log(
      'schedule_day',
      session,
      person,
      saved.documentId,
      logSummary('day', person.name, [...changePieces(changes), ...(note ? [note] : [])]),
      { mistr: person.name, dny: changePieces(changes).join(', '), poznámka: note || null, bloky: `+${r.created} −${r.deleted}` }
    );
    return { updatedAt: saved.updatedAt, pending: false, reconcile: r, conflicts };
  },

  /** Решение руководства по предложению администратора. */
  async decide({ session, personal, date, body, now = new Date() }) {
    if (!isManagement(session)) throw new ScheduleError(403, 'management_only', 'Согласует только руководство');
    const status = body?.status;
    if (status !== 'approved' && status !== 'rejected') {
      throw new ScheduleError(400, 'bad_status', 'Решение — approved или rejected');
    }
    const person = await this._master(personal);
    const d = String(date ?? '').trim();
    if (!isValidYmd(d)) throw new ScheduleError(400, 'bad_date', 'Дата — ГГГГ-ММ-ДД');
    const doc = await this._scheduleOf(person.documentId);
    const cur = toSchedule(doc);
    const req = cur?.requests?.[d];
    if (!req) throw new ScheduleError(404, 'request_not_found', 'Предложения на этот день уже нет');
    const today = PRAGUE_DAY.format(now);
    if (status === 'approved' && d < today) {
      throw new ScheduleError(409, 'request_expired', 'День уже прошёл — предложение можно только отклонить');
    }
    const requests = { ...cur.requests };
    delete requests[d];
    const data: any = { requests };
    const day = req.state === 'template' ? { state: 'template' } : pickDay(req);
    if (status === 'approved') {
      const overrides = { ...cur.overrides };
      if (day.state === 'template') delete overrides[d];
      else overrides[d] = { ...day, note: req.note || null, by: req.by || '', at: req.at || null, approvedBy: session?.username || '' };
      data.overrides = overrides;
    }
    const saved = await this._write(person, doc, data);
    let r = { created: 0, deleted: 0 };
    let conflicts = [];
    if (status === 'approved') {
      const sched = toSchedule(saved);
      r = await this.reconcile({ person, schedule: sched, from: d, to: d, now });
      conflicts = await this._conflicts(person, sched, d, d, now);
    }
    const piece = `${fmtDay(d)} ${dayLabel(day)}`;
    this._log(
      status === 'approved' ? 'schedule_approve' : 'schedule_reject',
      session,
      person,
      saved.documentId,
      logSummary(status === 'approved' ? 'approve' : 'reject', person.name, [piece, `navrhl/a ${req.by || '—'}`]),
      { mistr: person.name, den: piece, navrhl: req.by || null, poznámka: req.note || null }
    );
    return { updatedAt: saved.updatedAt, status, reconcile: r, conflicts };
  },

  /** Все предложения администраторов с сегодняшнего дня — для «Ke schválení» и «Сегодня». */
  async pendingRequests({ now = new Date() } = {}) {
    const today = PRAGUE_DAY.format(now);
    const docs = await strapi.documents(SCHEDULE_UID).findMany({
      fields: ['requests', 'updatedAt'],
      populate: { personal: { fields: ['name'] } },
      limit: 500,
    });
    const items = [];
    for (const doc of docs) {
      const req = doc.requests && typeof doc.requests === 'object' ? doc.requests : {};
      for (const [date, r] of Object.entries(req)) {
        if (!isValidYmd(date) || date < today) continue;
        items.push({
          personal: doc.personal?.documentId || null,
          employeeName: doc.personal?.name || '',
          date,
          state: r.state === 'template' ? 'template' : pickDay(r).state,
          from: r.state === 'hours' ? Number(r.from) : null,
          to: r.state === 'hours' ? Number(r.to) : null,
          label: dayLabel(r),
          note: r.note || null,
          by: r.by || null,
          at: r.at || null,
        });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
    return { items };
  },

  /**
   * Старые повторяющиеся серии мастера, которые план теперь покрывает целиком:
   * зеркальные (по noonaBlockedId) и own-серии (по noonaKey), от 3 будущих дат.
   * Не предлагаются: блоки плана, серии отпусков (time-off.blockSeriesKey),
   * pending/rejected, разовые.
   */
  async legacyCandidates({ personal, now = new Date() }) {
    const person = await this._master(personal);
    const today = PRAGUE_DAY.format(now);
    const schedule = toSchedule(await this._scheduleOf(person.documentId));
    const [blocks, timeOffs] = await Promise.all([
      strapi.documents(TIME_BLOCK_UID).findMany({
        filters: {
          date: { $gte: today },
          noonaEmployeeId: { $eq: person.noonaEmployeeId },
          $or: [{ approvalStatus: { $null: true } }, { approvalStatus: 'approved' }],
        },
        fields: ['date', 'startsAt', 'endsAt', 'title', 'noonaKey', 'noonaBlockedId', 'createdByName'],
        limit: 5000,
      }),
      strapi.documents(TIME_OFF_UID).findMany({
        filters: { blockSeriesKey: { $notNull: true } },
        fields: ['blockSeriesKey'],
        limit: 2000,
      }),
    ]);
    const timeOffKeys = new Set(timeOffs.map((t) => t.blockSeriesKey).filter(Boolean));
    // только окно записи: за его концом блоков плана ещё нет, и удалённый старый блок
    // оставил бы дату открытой до ближайшего пересчёта — такие блоки остаются как были
    const horizon = await this._horizon(today);
    if (!horizon) return { items: [], horizon: null };
    const later = new Map();
    const groups = new Map();
    for (const b of blocks) {
      const key = String(b.noonaKey || '');
      if (isPlanKey(key) || timeOffKeys.has(key)) continue;
      let gk = null;
      if (key.startsWith('own|')) gk = key;
      else if (String(b.noonaBlockedId || '').trim()) gk = `mirror|${b.noonaBlockedId}`;
      if (!gk) continue;
      if (String(b.date) > horizon) {
        later.set(gk, (later.get(gk) || 0) + 1);
        continue;
      }
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(b);
    }
    const hours = await this._hours(today, horizon);
    const out = [];
    for (const [key, list] of groups) {
      const dates = new Set(list.map((b) => String(b.date)));
      if (dates.size < LEGACY_MIN_DATES) continue;
      const covered = list.every((b) => {
        const d = String(b.date);
        const win = salonWindow(hours.get(d));
        // салон в этот день закрыт — блок ни на что не влияет
        if (!win) return true;
        const { startMin, endMin } = blockMinutes(b);
        const s = Math.max(startMin, win.openMin);
        const e = Math.min(endMin, win.closeMin);
        return covers(desiredBlocks(effectiveDay(schedule, d).day, win), s, e);
      });
      if (!covered) continue;
      const sorted = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const firstB = sorted[0];
      const mins = blockMinutes(firstB);
      out.push({
        key,
        kind: key.startsWith('mirror|') ? 'mirror' : 'own',
        title: firstB.title || (key.startsWith('mirror|') ? 'Nepracovní doba (Noona)' : 'Blokace'),
        count: list.length,
        first: String(firstB.date),
        last: String(sorted[sorted.length - 1].date),
        weekdays: WEEK_ORDER.filter((i) => list.some((b) => dowOf(String(b.date)) === i)).map((i) => DOW_CS[i]),
        time: `${minToHHMM(mins.startMin)}–${minToHHMM(mins.endMin)}`,
        createdBy: firstB.createdByName || null,
        later: later.get(key) || 0,
      });
    }
    out.sort((a, b) => a.first.localeCompare(b.first));
    return { items: out, horizon };
  },

  /** Удалить будущие блоки выбранных старых серий (только тех, что план покрывает) в пределах окна записи. */
  async replaceLegacy({ session, personal, body, now = new Date() }) {
    if (!isManagement(session)) throw new ScheduleError(403, 'management_only', 'Старые блоки заменяет только руководство');
    const keys = Array.isArray(body?.keys) ? body.keys.map(String) : [];
    if (!keys.length) throw new ScheduleError(400, 'no_keys', 'Не выбрано ни одной серии');
    const person = await this._master(personal);
    const today = PRAGUE_DAY.format(now);
    const { items, horizon } = await this.legacyCandidates({ personal: person.documentId, now });
    const byKey = new Map(items.map((i) => [i.key, i]));
    const bad = keys.filter((k) => !byKey.has(k));
    if (bad.length) {
      throw new ScheduleError(409, 'legacy_not_covered', 'Серия не покрыта планом или уже удалена — обновите список');
    }
    let deleted = 0;
    for (const k of keys) {
      const filters = k.startsWith('mirror|')
        ? { noonaBlockedId: { $eq: k.slice('mirror|'.length) }, noonaEmployeeId: { $eq: person.noonaEmployeeId }, date: { $gte: today, $lte: horizon } }
        : { noonaKey: { $eq: k }, date: { $gte: today, $lte: horizon } };
      const rows = await strapi.documents(TIME_BLOCK_UID).findMany({ filters, fields: ['date'], limit: 5000 });
      for (const b of rows) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
      deleted += rows.length;
    }
    const pieces = keys.map((k) => `${byKey.get(k).title} (${byKey.get(k).count}×)`);
    this._log('schedule_legacy_replace', session, person, person.documentId, logSummary('legacy', person.name, pieces), {
      mistr: person.name,
      série: pieces.join(', '),
      smazáno: String(deleted),
    });
    return { deleted };
  },
};
