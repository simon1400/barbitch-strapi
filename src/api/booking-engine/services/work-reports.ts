// @ts-nocheck
/**
 * «Výkaz práce» — ежедневный отчёт управляющей владельцу (s239, план
 * MANAGER_REPORT_NEXT_SESSION_PROMPT.md, Фаза 1; решения владельца — §8 плана).
 *
 * Кто что может:
 *   • автор (роль из `REPORT_ROLES` — сейчас только `manager`) пишет СВОЙ отчёт за день:
 *     карточка — по сессии (utils/staff-identity), id карточки в запросе нет вовсе.
 *     У владельца карточки нет — 404 `no_card`; другим ролям — 403 `not_allowed`
 *     (администраторам механизм не открывать, решение §8.12);
 *   • владелец (ручки под `requireOwner`, НЕ `requireManagement`) читает все отчёты,
 *     отмечает «přečteno», ставит оценку 1–5 и пишет комментарии; автор видит всё это
 *     у своего отчёта и отвечает в той же нити.
 *
 * Правила времени (Прага): отчёт ждём пн–пт с `REPORTS_SINCE`, кроме дней отпуска/больничного
 * (`time-off`) и дней, отмеченных «volno». Вовремя — поданный до 10:00 следующего дня, позже —
 * «pozdě» (решение владельца 01.10.2026). Заполнить/исправить можно не дальше `BACKFILL_DAYS`
 * дней назад. Правка после прочтения владельцем — разрешена, прежний текст уходит
 * в `history`, у отчёта бейдж «upraveno po přečtení».
 *
 * Коллекция `work-report` — без REST-роутов (паттерн staff-note): администраторы читают
 * REST всех незакрытых коллекций. Запись — условным UPDATE по `version` (одновременные
 * правка автора и комментарий владельца не затирают друг друга: второй получает 409).
 * Журнал — calendar_logs, entityType `report`, БЕЗ текста отчёта (журнал читают шире).
 *
 * Фаза 2 (s240): «Systém zaznamenal» — что журналы системы записали за день от имени автора
 * (calendar_logs + отметки дозаписей + дубли клиентов, по логину учётки). Видят обе стороны
 * (решение §8.7). Это дополнение к отчёту, а не оценка: звонки, поставщики и собеседования
 * в систему не попадают. Снимок сводки кладётся в `systemFacts` при подаче/правке — чтобы
 * последующее удаление записей журнала было видно. Итог месяца — ещё и по категориям пунктов.
 *
 * Верх файла — чистые функции (tests/work-reports.test.mjs), ниже — сервис.
 */

import { minToHHMM, pragueDateOf, pragueMinOf, pragueMinToUtcIso } from './slots-core';
import { findSessionPersonal } from '../../../utils/staff-identity';
import { normalizeReportTasks } from './owner-tasks';

export class ReportError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const REPORT_UID = 'api::work-report.work-report';
const TIME_OFF_UID = 'api::time-off.time-off';
const PERSONAL_UID = 'api::personal.personal';
const ADMIN_UID = 'api::admin-user.admin-user';
const LOG_UID = 'api::calendar-log.calendar-log';
const UPSELL_ATTEMPT_UID = 'api::upsell-attempt.upsell-attempt';
const MERGE_LOG_UID = 'api::client-merge-log.client-merge-log';

// ── настройки (решения владельца §8 — менять здесь, больше нигде) ──────────────

/** Роли, которые пишут výkaz. Администраторам — нет (§8.12). */
export const REPORT_ROLES = ['manager'];
/** Отчёты ждём с этого дня (§8.11). */
export const REPORTS_SINCE = '2026-10-01';
/** Заполнить или исправить отчёт — не дальше стольких дней назад (§8.3, уточнено 01.10.2026). */
export const BACKFILL_DAYS = 7;
/** Вовремя — если подан до этого времени СЛЕДУЮЩЕГО дня (минуты от полуночи, Прага); позже — «pozdě». */
export const ON_TIME_UNTIL_MIN = 10 * 60;
/** Часы: от и до, шаг полчаса (§8.1 — одно поле «сколько часов»). */
export const HOURS_MIN = 0.5;
export const HOURS_MAX = 16;
/** «Сегодня» владельца: непрочитанные, пропуски и вопросы — за столько дней назад. */
export const ATTENTION_DAYS = 14;

export const MAX_ITEMS = 20;
export const MAX_ITEM_TEXT = 500;
export const MAX_TEXT = 2000;
export const MAX_HISTORY = 20;
export const MAX_COMMENTS = 50;
export const MAX_COMMENT = 1000;

/** Категории пунктов «Na čem jsem pracovala» — ключ → подпись (UI чешский, §8.10). */
export const CATEGORIES = {
  staff: 'Personál',
  clients: 'Klienti a reklamace',
  supplies: 'Nákupy a sklad',
  marketing: 'Marketing a sítě',
  calendar: 'Kalendář a rezervace',
  finance: 'Finance a mzdy',
  training: 'Školení',
  admin: 'Administrativa',
  other: 'Jiné',
} as const;

/** Причина «nepracovní den». */
export const DAY_OFF_REASONS = {
  weekend: 'Víkend',
  vacation: 'Dovolená',
  sick: 'Nemoc',
  other: 'Jiné',
} as const;

/** Поля, которые пишет автор (и которые сравниваются/уходят в историю). */
export const CONTENT_FIELDS = ['status', 'dayOffReason', 'hours', 'items', 'done', 'carried', 'needsOwner', 'planTomorrow', 'taskNotes'] as const;

/** «Systém zaznamenal»: группы действий (entityType журнала + два своих источника) → подпись. */
export const FACT_GROUPS = {
  booking: 'Rezervace',
  block: 'Bloky v kalendáři',
  client: 'Údaje klientů',
  korekce: 'Korekce',
  correction: 'Úpravy mezd',
  cost: 'Náklady',
  timeoff: 'Absence',
  shift: 'Směny administrátorů',
  schedule: 'Plán mistrů',
  staff: 'Tým',
  visit: 'Uzavření návštěv',
  shift_close: 'Uzavření směny',
  task: 'Úkoly od majitele',
  upsell: 'Dozápisy — označení klientů',
  dedupe: 'Duplicity klientů',
  other: 'Jiné',
} as const;

/** Подписи действий (как в журнале админки); неизвестное — ключом. */
export const FACT_ACTIONS: Record<string, string> = {
  booking_create: 'nová rezervace',
  booking_move: 'přesun',
  booking_status: 'změna stavu',
  booking_service: 'změna služby',
  booking_edit: 'úprava',
  booking_delete: 'smazání',
  block_create: 'nový blok',
  block_edit: 'úprava bloku',
  block_delete: 'smazání bloku',
  block_approve: 'blok schválen',
  block_reject: 'blok zamítnut',
  client_edit: 'údaje klienta',
  korekce_link: 'korekce',
  korekce_transfer: 'převod podílu',
  korekce_revert: 'převod zrušen',
  correction_create: 'nový záznam',
  correction_delete: 'smazáno',
  cost_create: 'nový náklad',
  cost_update: 'změna',
  cost_delete: 'smazáno',
  cost_request: 'žádost',
  cost_approve: 'schváleno',
  cost_reject: 'zamítnuto',
  cost_cancel: 'žádost stažena',
  cost_file_add: 'doklad',
  cost_file_delete: 'doklad smazán',
  cost_cash_skip: 'pokladna: není náklad',
  cost_cash_unskip: 'pokladna: zpět do kontroly',
  timeoff_create: 'nový záznam',
  timeoff_update: 'úprava',
  timeoff_delete: 'smazáno',
  shift_create: 'nový rozpis',
  shift_update: 'změna',
  shift_delete: 'smazáno',
  schedule_template: 'šablona',
  schedule_day: 'změna dne',
  schedule_request: 'návrh',
  schedule_approve: 'schváleno',
  schedule_reject: 'zamítnuto',
  schedule_legacy_replace: 'staré bloky',
  staff_create: 'nový zaměstnanec',
  staff_update: 'karta',
  staff_rate: 'sazba',
  staff_file_add: 'nový soubor',
  staff_file_update: 'dokument',
  staff_file_delete: 'dokument smazán',
  staff_note: 'poznámka',
  staff_account: 'přístup',
  staff_rename: 'přejmenování',
  staff_leave: 'ukončení',
  staff_erase: 'údaje smazány',
  visit_close: 'uzavřena',
  visit_close_edit: 'úprava',
  visit_close_delete: 'zrušeno',
  shift_close: 'směna uzavřena',
  shift_revert: 'uzavření zrušeno',
  task_done: 'hotovo',
  task_progress: 'průběh',
  task_comment: 'komentář',
  task_file_add: 'příloha',
  task_file_delete: 'příloha smazána',
  upsell_declined: 'klient odmítl',
  upsell_not_offered: 'nenabízeno',
  dedupe_merge: 'sloučení',
  dedupe_ignore: 'nejsou duplicity',
  dedupe_unignore: 'zpět do kontroly',
  dedupe_blacklist: 'blacklist',
};

/** Предел строк одного источника за период (месяц управляющей — сотни). */
export const FACTS_LIMIT = 5000;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;
const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

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

/** 0 = неделя, 6 = суббота. */
export const dowOfYmd = (ymd: string): number => new Date(`${ymd}T00:00:00Z`).getUTCDay();
export const isWeekday = (ymd: string): boolean => {
  const d = dowOfYmd(ymd);
  return d >= 1 && d <= 5;
};

export const datesBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
};

/** YYYY-MM → первый и последний день месяца включительно. */
export const monthRange = (raw: unknown): { from: string; to: string } => {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw new ReportError(400, 'bad_month', 'Měsíc ve formátu RRRR-MM');
  const last = new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate();
  return { from: `${s}-01`, to: `${s}-${String(last).padStart(2, '0')}` };
};

/** «01.10.2026». */
export const fmtDay = (ymd: unknown): string => {
  const s = String(ymd ?? '');
  return YMD.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '—';
};

/** «7,5». */
export const fmtHours = (h: unknown): string => {
  const n = Number(h);
  return Number.isFinite(n) ? String(n).replace('.', ',') : '—';
};

const cut = (s: unknown, n: number) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/** Текст поля: обрезка пробелов, \r\n → \n; длиннее предела — 400 (молча не режем). */
export const cleanText = (v: unknown, max: number, code: string): string => {
  if (v != null && typeof v !== 'string') throw new ReportError(400, code, 'Text má neplatný formát');
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.length > max) throw new ReportError(400, code, `Text je delší než ${max} znaků`);
  return s;
};

export const normalizeHours = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(',', '.'));
  if (v === '' || v == null || !Number.isFinite(n) || n < HOURS_MIN || n > HOURS_MAX || Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) {
    throw new ReportError(400, 'bad_hours', `Odpracované hodiny: ${fmtHours(HOURS_MIN)}–${HOURS_MAX} po půl hodině`);
  }
  return Math.round(n * 2) / 2;
};

/** Пункты «чем занималась»: пустые строки выкидываются, категория — из списка. */
export const normalizeItems = (raw: unknown): Array<{ category: string; text: string }> => {
  if (raw != null && !Array.isArray(raw)) throw new ReportError(400, 'bad_items', 'Body výkazu mají neplatný formát');
  const items = [];
  for (const it of (raw as any[]) || []) {
    const text = cleanText(it?.text, MAX_ITEM_TEXT, 'item_too_long');
    if (!text) continue;
    const category = String(it?.category ?? '').trim();
    if (!has(CATEGORIES, category)) throw new ReportError(400, 'bad_category', 'Vyberte kategorii bodu');
    items.push({ category, text });
  }
  if (!items.length) throw new ReportError(400, 'items_required', 'Napište aspoň jeden bod, na čem jste pracovala');
  if (items.length > MAX_ITEMS) throw new ReportError(400, 'too_many_items', `Nejvýš ${MAX_ITEMS} bodů`);
  return items;
};

/** Тело PUT → поля отчёта. Нерабочий день — только причина, остальное пусто. */
export const normalizeReportInput = (body: any) => {
  const status = String(body?.status ?? 'submitted');
  if (status === 'day_off') {
    const reason = String(body?.dayOffReason ?? '');
    if (!has(DAY_OFF_REASONS, reason)) throw new ReportError(400, 'bad_reason', 'Vyberte důvod nepracovního dne');
    return { status, dayOffReason: reason, hours: null, items: [], done: '', carried: '', needsOwner: '', planTomorrow: '', taskNotes: [] };
  }
  if (status !== 'submitted') throw new ReportError(400, 'bad_status', 'Neplatný stav výkazu');
  const hours = normalizeHours(body?.hours);
  const items = normalizeItems(body?.items);
  const done = cleanText(body?.done, MAX_TEXT, 'text_too_long');
  if (!done) throw new ReportError(400, 'done_required', 'Napište, co je hotovo');
  return {
    status,
    dayOffReason: null,
    hours,
    items,
    done,
    carried: cleanText(body?.carried, MAX_TEXT, 'text_too_long'),
    needsOwner: cleanText(body?.needsOwner, MAX_TEXT, 'text_too_long'),
    planTomorrow: cleanText(body?.planTomorrow, MAX_TEXT, 'text_too_long'),
    // заметки по поручениям — [{taskId, done, note}]; принадлежность и названия проверяет сервис
    taskNotes: normalizeReportTasks(body?.tasks),
  };
};

/** Содержимое отчёта в одном виде (для сравнения и снимка в историю). */
export const contentOf = (row: any) => ({
  status: row?.status || 'submitted',
  dayOffReason: row?.dayOffReason || null,
  hours: row?.hours == null ? null : Number(row.hours),
  items: Array.isArray(row?.items) ? row.items.map((i: any) => ({ category: i.category, text: i.text })) : [],
  done: row?.done || '',
  carried: row?.carried || '',
  needsOwner: row?.needsOwner || '',
  planTomorrow: row?.planTomorrow || '',
  // заметки по поручениям владельца (s240): [{taskId, title, note, done}]; title — на момент подачи
  taskNotes: Array.isArray(row?.taskNotes)
    ? row.taskNotes.map((n: any) => ({ taskId: n.taskId, title: n.title || '', note: n.note || '', done: n.done === true }))
    : [],
});

/** Сравнение содержимого без названий поручений (владелец мог переименовать поручение). */
const compareKey = (row: any) => {
  const c = contentOf(row);
  return JSON.stringify({ ...c, taskNotes: c.taskNotes.map(({ title, ...rest }) => rest) });
};

export const sameContent = (a: any, b: any): boolean => compareKey(a) === compareKey(b);

/** День, за который можно писать: не будущий, не раньше начала отсчёта и окна дозаполнения. */
export const checkReportDate = (date: unknown, today: string): string => {
  const d = String(date ?? '');
  if (!isValidYmd(d)) throw new ReportError(400, 'bad_date', 'Neplatné datum');
  if (d > today) throw new ReportError(409, 'future_date', 'Výkaz za budoucí den nelze vyplnit');
  if (d < REPORTS_SINCE) throw new ReportError(409, 'too_old', `Výkazy se vedou od ${fmtDay(REPORTS_SINCE)}`);
  if (d < addDaysYmd(today, -BACKFILL_DAYS)) {
    throw new ReportError(409, 'too_old', `Výkaz lze vyplnit nebo opravit nejvýš ${BACKFILL_DAYS} dní zpětně`);
  }
  return d;
};

/** Вовремя (до 10:00 следующего дня) или поздно — по моменту первой подачи (Прага). */
export const lateness = (date: string, at: Date): 'on_time' | 'late' => {
  const day = pragueDateOf(at);
  if (day <= date) return 'on_time';
  if (day === addDaysYmd(date, 1) && pragueMinOf(at) < ON_TIME_UNTIL_MIN) return 'on_time';
  return 'late';
};

/** Правка позже прочтения владельцем (бейдж; снимается следующим прочтением). */
export const editedAfterReview = (row: any): boolean =>
  !!row?.editedAt && !!row?.reviewedAt && new Date(row.editedAt).getTime() > new Date(row.reviewedAt).getTime();

/**
 * Что записать при сохранении. Нет записи — новая. Содержимое не изменилось — ничего.
 * Отчёт уже прочитан владельцем — прежнее содержимое уходит в историю (≤ MAX_HISTORY).
 * `submittedAt`/`late` ставятся один раз — при первой подаче отчёта (не «volno»).
 */
export const applyEdit = (existing: any, input: any, now: Date, date: string) => {
  const iso = now.toISOString();
  const firstSubmit = input.status === 'submitted' && !existing?.submittedAt;
  const stamp = firstSubmit ? { submittedAt: iso, late: lateness(date, now) } : {};
  if (!existing) return { changed: true, data: { ...input, ...stamp, history: [], editedAt: null } };
  if (sameContent(existing, input)) return { changed: false, data: {} };
  const data: any = { ...input, ...stamp };
  if (existing.reviewedAt) {
    const prev = Array.isArray(existing.history) ? existing.history : [];
    data.history = [...prev, { at: iso, snapshot: contentOf(existing) }].slice(-MAX_HISTORY);
    data.editedAt = iso;
  }
  return { changed: true, data };
};

/** Тело «прочитано / оценка / комментарий» владельца. Любой вызов = «přečteno». */
export const normalizeReview = (body: any): { rating?: number | null; comment?: string } => {
  const out: { rating?: number | null; comment?: string } = {};
  if (has(body, 'rating')) {
    const r = body.rating;
    if (r === null) out.rating = null;
    else {
      const n = Number(r);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new ReportError(400, 'bad_rating', 'Hodnocení 1–5');
      out.rating = n;
    }
  }
  if (has(body, 'comment')) {
    const t = cleanText(body.comment, MAX_COMMENT, 'comment_too_long');
    if (t) out.comment = t;
  }
  return out;
};

/** Новый комментарий в нить (≤ MAX_COMMENTS). */
export const appendComment = (comments: unknown, entry: { at: string; authorName: string; role: string; text: string }) => {
  const list = Array.isArray(comments) ? comments : [];
  if (list.length >= MAX_COMMENTS) throw new ReportError(409, 'too_many_comments', `Nejvýš ${MAX_COMMENTS} komentářů u jednoho výkazu`);
  return [...list, entry];
};

/** День попадает в отпуск/больничный. */
const inTimeOff = (date: string, timeOffs: any[]): boolean =>
  timeOffs.some((t) => t?.startDate && t?.endDate && t.startDate <= date && date <= t.endDate);

export type DayState =
  | 'on_time'
  | 'late'
  | 'day_off'
  | 'time_off'
  | 'weekend'
  | 'open'
  | 'missing'
  | 'future'
  | 'before';

/**
 * Состояние каждого дня периода: подан (вовремя/поздно), volno, отпуск, выходной,
 * «ещё можно вовремя» (сегодня и вчера до 10:00), «нет отчёта», будущее, до начала отсчёта.
 * `expected` — день, когда отчёт ждали (пн–пт, не отпуск, не volno, не будущее).
 * `nowMin` — минуты «сейчас» по Праге (без него вчерашний день уже «chybí»).
 */
export const dayStates = ({
  from,
  to,
  today,
  reports,
  timeOffs,
  nowMin = 24 * 60,
}: {
  from: string;
  to: string;
  today: string;
  reports: any[];
  timeOffs: any[];
  nowMin?: number;
}) => {
  const yesterdayOpen = nowMin < ON_TIME_UNTIL_MIN ? addDaysYmd(today, -1) : null;
  const byDate = new Map(reports.map((r) => [r.date, r]));
  return datesBetween(from, to).map((date) => {
    const r = byDate.get(date);
    const off = inTimeOff(date, timeOffs);
    const base = date >= REPORTS_SINCE && date <= today && isWeekday(date) && !off;
    let state: DayState;
    if (r?.status === 'day_off') state = 'day_off';
    else if (r?.status === 'submitted') state = r.late || 'on_time';
    else if (date < REPORTS_SINCE) state = 'before';
    else if (date > today) state = 'future';
    else if (off) state = 'time_off';
    else if (!isWeekday(date)) state = 'weekend';
    else if (date === today || date === yesterdayOpen) state = 'open';
    else state = 'missing';
    return { date, state, expected: base && r?.status !== 'day_off', reportId: r?.documentId || null };
  });
};

/** Итог периода: ожидалось / подано / вовремя / поздно / пропущено / часы / средняя оценка. */
export const summarize = (days: any[], reports: any[]) => {
  const inDays = new Set(days.map((d) => d.date));
  const rows = reports.filter((r) => inDays.has(r.date));
  const submitted = rows.filter((r) => r.status === 'submitted');
  const rated = submitted.filter((r) => Number.isInteger(r.rating));
  const count = (s: string) => days.filter((d) => d.state === s).length;
  return {
    // сегодняшний день, пока отчёта нет, ещё не «ожидался»
    expected: days.filter((d) => d.expected && d.state !== 'open').length,
    submitted: submitted.length,
    onTime: count('on_time'),
    late: count('late'),
    missing: count('missing'),
    dayOff: count('day_off'),
    timeOff: days.filter((d) => d.state === 'time_off' && isWeekday(d.date)).length,
    hours: submitted.reduce((s, r) => s + (Number(r.hours) || 0), 0),
    avgRating: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null,
    unread: submitted.filter((r) => !r.reviewedAt || editedAfterReview(r)).length,
    ...categoryTotals(submitted),
  };
};

const byCountThenLabel = (a: { count: number; label: string }, b: { count: number; label: string }) =>
  b.count - a.count || a.label.localeCompare(b.label, 'cs');

/** Пункты «Na čem jsem pracovala» по категориям (поданные отчёты периода). */
export const categoryTotals = (submitted: any[]) => {
  const counts = new Map<string, number>();
  for (const r of submitted) for (const it of contentOf(r).items) counts.set(it.category, (counts.get(it.category) || 0) + 1);
  const categories = [...counts]
    .map(([key, count]) => ({ key, label: CATEGORIES[key] || key, count }))
    .sort(byCountThenLabel);
  return { items: categories.reduce((s, c) => s + c.count, 0), categories };
};

// ── «Systém zaznamenal» (Фаза 2) ─────────────────────────────────────────────

export type FactEvent = { group: string; action: string; at: string };

/** Строки трёх источников → события. Действия с самим výkazem в сводку не идут (это не работа). */
export const factEventsOf = ({ logs = [], attempts = [], merges = [] }: { logs?: any[]; attempts?: any[]; merges?: any[] }): FactEvent[] => [
  ...logs
    .filter((l) => l?.entityType !== 'report')
    .map((l) => ({ group: String(l.entityType || 'other'), action: String(l.action || ''), at: l.createdAt })),
  ...attempts.map((a) => ({ group: 'upsell', action: `upsell_${a.outcome}`, at: a.updatedAt || a.createdAt })),
  ...merges.map((m) => ({ group: 'dedupe', action: `dedupe_${m.action}`, at: m.createdAt })),
];

const atMs = (e: FactEvent) => new Date(e?.at).getTime();

/** Сводка событий одного дня: сколько, первое и последнее время (Прага), по группам и действиям. */
export const buildFacts = (events: FactEvent[]) => {
  const list = events.filter((e) => Number.isFinite(atMs(e))).sort((a, b) => atMs(a) - atMs(b));
  const groups = new Map<string, { key: string; label: string; count: number; actions: Map<string, number> }>();
  for (const e of list) {
    const key = has(FACT_GROUPS, e.group) ? e.group : 'other';
    const g = groups.get(key) || { key, label: FACT_GROUPS[key], count: 0, actions: new Map() };
    g.count += 1;
    g.actions.set(e.action, (g.actions.get(e.action) || 0) + 1);
    groups.set(key, g);
  }
  const time = (e: FactEvent | undefined) => (e ? minToHHMM(pragueMinOf(e.at)) : null);
  return {
    total: list.length,
    first: time(list[0]),
    last: time(list[list.length - 1]),
    groups: [...groups.values()]
      .map((g) => ({
        key: g.key,
        label: g.label,
        count: g.count,
        actions: [...g.actions].map(([key, count]) => ({ key, label: FACT_ACTIONS[key] || key, count })).sort(byCountThenLabel),
      }))
      .sort(byCountThenLabel),
  };
};

/** События периода → сводка по пражским дням (только дни, где что-то было). */
export const factsByDay = (events: FactEvent[]) => {
  const byDay = new Map<string, FactEvent[]>();
  for (const e of events) {
    if (!Number.isFinite(atMs(e))) continue;
    const d = pragueDateOf(e.at);
    byDay.set(d, [...(byDay.get(d) || []), e]);
  }
  return Object.fromEntries([...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, ev]) => [d, buildFacts(ev)]));
};

/**
 * Логины, под которыми журналы записали действия человека: учётка, связанная с карточкой
 * (s229; без связи — учётка с логином = имени карточки, как accountForCard), плюс логины,
 * под которыми он подавал отчёты (логин могли переименовать — старые записи остались под старым).
 */
export const actorNamesFor = (person: { documentId: string; name?: string }, accounts: any[], extra: unknown[] = []): string[] => {
  const clean = (v: unknown) => String(v ?? '').trim();
  const linked = accounts.filter((a) => clean(a?.personalDocId) === person.documentId);
  const own = linked.length
    ? linked
    : accounts.filter((a) => !clean(a?.personalDocId) && clean(a?.username).toLowerCase() === clean(person.name).toLowerCase() && clean(person.name));
  return [...new Set([...own.map((a) => a.username), ...extra].map(clean).filter(Boolean))];
};

/** Строка отчёта наружу. */
export const toRow = (doc: any) => ({
  documentId: doc.documentId,
  date: doc.date,
  ...contentOf(doc),
  submittedAt: doc.submittedAt || null,
  late: doc.late || null,
  editedAt: doc.editedAt || null,
  editedAfterReview: editedAfterReview(doc),
  history: Array.isArray(doc.history) ? doc.history : [],
  reviewedAt: doc.reviewedAt || null,
  reviewedBy: doc.reviewedBy || null,
  rating: Number.isInteger(doc.rating) ? doc.rating : null,
  comments: Array.isArray(doc.comments) ? doc.comments : [],
  // снимок «Systém zaznamenal» на момент подачи/последней правки (Фаза 2)
  systemFacts: doc.systemFacts && typeof doc.systemFacts === 'object' && !Array.isArray(doc.systemFacts) ? doc.systemFacts : null,
  createdAt: doc.createdAt || null,
  updatedAt: doc.updatedAt || null,
});

/** Строка журнала — без текста отчёта: дата, часы, число пунктов. */
export const logSummary = (head: string, row: any): string => {
  const c = contentOf(row);
  const what =
    c.status === 'day_off'
      ? `nepracovní den (${DAY_OFF_REASONS[c.dayOffReason] || '—'})`
      : `${fmtHours(c.hours)} h · bodů ${c.items.length}`;
  return `${head} ${fmtDay(row.date)}: ${what}`;
};

const labelList = (o: Record<string, string>) => Object.entries(o).map(([key, label]) => ({ key, label }));

const REPORT_FIELDS = [
  'date',
  'kind',
  'status',
  'dayOffReason',
  'hours',
  'items',
  'done',
  'carried',
  'needsOwner',
  'planTomorrow',
  'submittedAt',
  'late',
  'editedAt',
  'history',
  'reviewedAt',
  'reviewedBy',
  'rating',
  'comments',
  'systemFacts',
  'taskNotes',
  'version',
  'createdAt',
  'updatedAt',
];

const notFound = () => new ReportError(404, 'report_not_found', 'Výkaz nenalezen');

export default {
  _today(now: Date) {
    return pragueDateOf(now);
  },

  _log(action: string, session: any, docId: string, employeeName: string, summary: string, details: any = {}) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({ action, entityType: 'report', actorName: session?.username || '', entityDocId: docId, employeeName, summary, details })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /** Карточка автора — сессии. Владельцу карточки нет; ролям вне REPORT_ROLES модуль закрыт. */
  async _author(session: any) {
    if (!session || session.role === 'owner') throw new ReportError(404, 'no_card', 'Výkaz vyplňuje zaměstnanec se svou kartou');
    if (!REPORT_ROLES.includes(session.role)) throw new ReportError(403, 'not_allowed', 'Výkaz práce není pro tuto roli');
    const p = await findSessionPersonal(strapi, session, { status: 'draft', fields: ['name', 'position', 'isActive'] });
    if (!p) throw new ReportError(404, 'no_card', 'Karta zaměstnance nenalezena — obraťte se na majitele');
    return p;
  },

  /** Чьи отчёты читает владелец: все карточки управляющих (и ушедших — ради истории). */
  async _people() {
    const rows = await strapi.documents(PERSONAL_UID).findMany({
      status: 'draft',
      filters: { position: { $eq: 'manager' } },
      fields: ['name', 'isActive'],
      sort: ['name:asc'],
      limit: 50,
    });
    return rows.map((p) => ({ documentId: p.documentId, name: String(p.name ?? '').trim(), isActive: p.isActive !== false }));
  },

  _reports(personalDocId: string, from: string, to: string) {
    return strapi.documents(REPORT_UID).findMany({
      filters: { personal: { documentId: { $eq: personalDocId } }, kind: { $eq: 'day' }, date: { $gte: from, $lte: to } },
      fields: REPORT_FIELDS,
      sort: [{ date: 'asc' }, { id: 'asc' }],
      limit: 1000,
    });
  },

  _timeOffs(personalDocId: string, from: string, to: string) {
    return strapi.documents(TIME_OFF_UID).findMany({
      filters: { personal: { documentId: { $eq: personalDocId } }, startDate: { $lte: to }, endDate: { $gte: from } },
      fields: ['type', 'startDate', 'endDate'],
      limit: 200,
    });
  },

  async _findDay(personalDocId: string, date: string) {
    const rows = await this._reports(personalDocId, date, date);
    return rows[0] || null;
  },

  /**
   * Условная запись: проходит, только если с чтения `existing` никто не записал отчёт
   * (поле `version`). Иначе 409 — клиент перечитывает и повторяет.
   */
  async _write(existing: any, data: any, now: Date) {
    const v = Number.isInteger(existing.version) ? existing.version : null;
    const res = await strapi.db.query(REPORT_UID).updateMany({
      where: { documentId: existing.documentId, version: v == null ? { $null: true } : v },
      data: { ...data, version: (v ?? 0) + 1, updatedAt: now },
    });
    if (!res || !res.count) throw new ReportError(409, 'report_changed', 'Výkaz se mezitím změnil — načtěte ho znovu');
    return strapi.documents(REPORT_UID).findOne({ documentId: existing.documentId, fields: REPORT_FIELDS });
  },

  /** Логины человека для журналов (см. actorNamesFor): учётка + логины всех его отчётов. */
  async _actorNames(person: { documentId: string; name?: string }, extra: unknown[] = []) {
    const [accounts, authored] = await Promise.all([
      strapi.db.query(ADMIN_UID).findMany({ select: ['username', 'personalDocId'], limit: 1000 }),
      strapi.documents(REPORT_UID).findMany({
        filters: { personal: { documentId: { $eq: person.documentId } } },
        fields: ['authorName'],
        limit: 5000,
      }),
    ]);
    return actorNamesFor(person, accounts || [], [...(authored || []).map((r) => r.authorName), ...extra]);
  },

  /** События журналов от имени `names` за пражские дни from…to включительно. */
  async _factEvents(names: string[], from: string, to: string): Promise<FactEvent[]> {
    if (!names.length) return [];
    const range = { $gte: new Date(pragueMinToUtcIso(from, 0)), $lt: new Date(pragueMinToUtcIso(addDaysYmd(to, 1), 0)) };
    const [logs, attempts, merges] = await Promise.all([
      strapi.db.query(LOG_UID).findMany({
        where: { actorName: { $in: names }, createdAt: range },
        select: ['action', 'entityType', 'createdAt'],
        limit: FACTS_LIMIT,
      }),
      strapi.db.query(UPSELL_ATTEMPT_UID).findMany({
        where: { adminUsername: { $in: names }, updatedAt: range },
        select: ['outcome', 'createdAt', 'updatedAt'],
        limit: FACTS_LIMIT,
      }),
      strapi.db.query(MERGE_LOG_UID).findMany({
        where: { actorName: { $in: names }, createdAt: range },
        select: ['action', 'createdAt'],
        limit: FACTS_LIMIT,
      }),
    ]);
    return factEventsOf({ logs: logs || [], attempts: attempts || [], merges: merges || [] });
  },

  /** «Systém zaznamenal» по дням месяца; сбой журналов не гасит отчёты — null. */
  async _monthFacts(person: { documentId: string; name?: string }, from: string, to: string) {
    try {
      const names = await this._actorNames(person);
      return factsByDay(await this._factEvents(names, from, to));
    } catch (e) {
      strapi.log.error(`work-reports facts failed: ${e?.message || e}`);
      return null;
    }
  },

  /** Снимок сводки дня в отчёт (при подаче/правке). Сбой — без снимка, отчёт всё равно сохраняется. */
  async _snapshot(person: { documentId: string; name?: string }, extra: unknown[], day: string, now: Date) {
    try {
      const names = await this._actorNames(person, extra);
      return { ...buildFacts(await this._factEvents(names, day, day)), at: now.toISOString() };
    } catch (e) {
      strapi.log.error(`work-reports snapshot failed: ${e?.message || e}`);
      return null;
    }
  },

  /** Месяц одного человека: дни, отчёты, итог. Отчёты — и за BACKFILL_DAYS до начала месяца (вчерашний план). */
  async _month(person: { documentId: string; name?: string }, month: unknown, today: string, nowMin: number) {
    const { from, to } = monthRange(month);
    const [reports, timeOffs] = await Promise.all([
      this._reports(person.documentId, addDaysYmd(from, -BACKFILL_DAYS), to),
      this._timeOffs(person.documentId, from, to),
    ]);
    const days = dayStates({ from, to, today, reports, timeOffs, nowMin });
    // будущих дней в журнале нет — до сегодня
    const facts = from <= today ? await this._monthFacts(person, from, to < today ? to : today) : {};
    const summary = summarize(days, reports);
    const system = facts
      ? { days: Object.keys(facts).length, actions: Object.values(facts).reduce((s: number, f: any) => s + f.total, 0) }
      : null;
    return {
      month: from.slice(0, 7),
      days,
      reports: reports.map(toRow),
      summary: { ...summary, system },
      facts,
      timeOffs: timeOffs.map((t) => ({ type: t.type, startDate: t.startDate, endDate: t.endDate })),
    };
  },

  _meta(today: string) {
    const earliest = addDaysYmd(today, -BACKFILL_DAYS);
    return {
      today,
      since: REPORTS_SINCE,
      backfillDays: BACKFILL_DAYS,
      earliest: earliest < REPORTS_SINCE ? REPORTS_SINCE : earliest,
      hours: { min: HOURS_MIN, max: HOURS_MAX, step: 0.5 },
      categories: labelList(CATEGORIES),
      dayOffReasons: labelList(DAY_OFF_REASONS),
    };
  },

  // ── автор ──────────────────────────────────────────────────────────────────

  /** GET /work-reports/mine?month=YYYY-MM — свои отчёты месяца. */
  async mine({ session, month, now = new Date() }: { session: any; month?: unknown; now?: Date }) {
    const p = await this._author(session);
    const today = this._today(now);
    // поручения в работе — для блока «Úkoly» в форме (сбой не гасит отчёты)
    const openTasks = await strapi
      .service('api::booking-engine.owner-tasks')
      .openFor(p.documentId, now)
      .catch((e) => {
        strapi.log.error(`work-reports: open tasks failed: ${e?.message || e}`);
        return null;
      });
    return {
      ...this._meta(today),
      name: p.name,
      openTasks,
      ...(await this._month(p, month || today.slice(0, 7), today, pragueMinOf(now))),
    };
  },

  /** PUT /work-reports/mine/:date — подать или исправить свой отчёт за день (upsert). */
  async saveMine({ session, date, body, now = new Date() }: { session: any; date: unknown; body: any; now?: Date }) {
    const p = await this._author(session);
    const today = this._today(now);
    const day = checkReportDate(date, today);
    const input = normalizeReportInput(body);
    // поручения — только свои; названия — с сервера
    if (input.taskNotes.length) input.taskNotes = await strapi.service('api::booking-engine.owner-tasks').checkReportTasks(session, input.taskNotes);
    const existing = await this._findDay(p.documentId, day);
    const plan = applyEdit(existing, input, now, day);
    let saved = existing;
    if (plan.changed) {
      const snap = await this._snapshot(p, [session?.username], day, now);
      if (snap) plan.data.systemFacts = snap;
    }

    if (!existing) {
      const created = await strapi.documents(REPORT_UID).create({
        data: {
          personal: p.documentId,
          date: day,
          kind: 'day',
          authorAccountId: Number(session?.id) || null,
          authorName: session?.username || '',
          comments: [],
          version: 1,
          ...plan.data,
        },
      });
      // два одновременных «Odeslat» (двойной тап) — остаётся первая запись дня
      const all = await this._reports(p.documentId, day, day);
      if (all.length > 1 && all[0].documentId !== created.documentId) {
        await strapi.documents(REPORT_UID).delete({ documentId: created.documentId });
        throw new ReportError(409, 'report_changed', 'Výkaz za tento den už existuje — načtěte ho znovu');
      }
      saved = all.find((r) => r.documentId === created.documentId) || created;
      const action = input.status === 'day_off' ? 'report_day_off' : 'report_submit';
      this._log(action, session, saved.documentId, p.name, logSummary('Výkaz', saved), { datum: fmtDay(day), stav: saved.late || 'volno' });
    } else if (plan.changed) {
      saved = await this._write(existing, plan.data, now);
      const after = existing.reviewedAt ? ' — upraveno po přečtení' : '';
      const action = input.status === 'day_off' && existing.status !== 'day_off' ? 'report_day_off' : 'report_edit';
      this._log(action, session, saved.documentId, p.name, `${logSummary('Výkaz upraven', saved)}${after}`, {
        datum: fmtDay(day),
        'po přečtení': existing.reviewedAt ? 'ano' : 'ne',
      });
    }

    // заметки по поручениям → лента поручений (только новые/изменившиеся; отчёт уже сохранён)
    if (plan.changed && (input.taskNotes.length || existing?.taskNotes?.length)) {
      await strapi
        .service('api::booking-engine.owner-tasks')
        .applyReportTasks(session, contentOf(existing).taskNotes, input.taskNotes, day, now)
        .catch((e) => strapi.log.error(`work-reports: task notes ${day} failed: ${e?.message || e}`));
    }

    return { saved: toRow(saved), ...(await this.mine({ session, month: day.slice(0, 7), now })) };
  },

  /** POST /work-reports/mine/:date/comments {text} — ответ в нити своего отчёта. */
  async commentMine({ session, date, body, now = new Date() }: { session: any; date: unknown; body: any; now?: Date }) {
    const p = await this._author(session);
    const day = String(date ?? '');
    if (!isValidYmd(day)) throw new ReportError(400, 'bad_date', 'Neplatné datum');
    const existing = await this._findDay(p.documentId, day);
    if (!existing) throw notFound();
    const text = cleanText(body?.text, MAX_COMMENT, 'comment_too_long');
    if (!text) throw new ReportError(400, 'comment_required', 'Napište komentář');
    const comments = appendComment(existing.comments, { at: now.toISOString(), authorName: session?.username || '', role: session.role, text });
    const saved = await this._write(existing, { comments }, now);
    this._log('report_comment', session, saved.documentId, p.name, `Komentář k výkazu ${fmtDay(day)}`, { datum: fmtDay(day) });
    return { saved: toRow(saved) };
  },

  // ── владелец ───────────────────────────────────────────────────────────────

  /** GET /work-reports?month=&personal= — месяц выбранной управляющей (по умолчанию — первой). */
  async list({ month, personal, now = new Date() }: { month?: unknown; personal?: unknown; now?: Date }) {
    const today = this._today(now);
    const people = await this._people();
    const want = String(personal ?? '').trim();
    const person = people.find((p) => p.documentId === want) || people.find((p) => p.isActive) || people[0] || null;
    const meta = this._meta(today);
    if (!person) {
      const { from } = monthRange(month || today.slice(0, 7));
      return {
        ...meta,
        people,
        personal: null,
        month: from.slice(0, 7),
        days: [],
        reports: [],
        summary: { ...summarize([], []), system: null },
        facts: {},
        timeOffs: [],
      };
    }
    return { ...meta, people, personal: person.documentId, ...(await this._month(person, month || today.slice(0, 7), today, pragueMinOf(now))) };
  },

  /** POST /work-reports/:id/review {seen?, rating?, comment?} — прочитано, оценка, комментарий. */
  async review({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const documentId = String(id ?? '').trim();
    if (!DOC_ID.test(documentId)) throw notFound();
    const existing = await strapi.documents(REPORT_UID).findOne({ documentId, fields: REPORT_FIELDS, populate: { personal: { fields: ['name'] } } });
    if (!existing) throw notFound();
    const r = normalizeReview(body);
    const data: any = { reviewedAt: now, reviewedBy: session?.username || '' };
    if (has(r, 'rating')) data.rating = r.rating;
    if (r.comment) {
      data.comments = appendComment(existing.comments, { at: now.toISOString(), authorName: session?.username || '', role: 'owner', text: r.comment });
    }
    const saved = await this._write(existing, data, now);
    const parts = ['přečten'];
    if (has(r, 'rating')) parts.push(r.rating == null ? 'hodnocení zrušeno' : `hodnocení ${r.rating}/5`);
    if (r.comment) parts.push('komentář');
    this._log('report_review', session, saved.documentId, existing.personal?.name || '', `Výkaz ${fmtDay(existing.date)}: ${parts.join(' · ')}`, {
      datum: fmtDay(existing.date),
    });
    return { saved: toRow(saved) };
  },

  /**
   * GET /work-reports/attention — для «Сегодня» владельца: непрочитанные (и исправленные
   * после прочтения) отчёты, дни без отчёта, «Potřebuji rozhodnutí» без ответа — за ATTENTION_DAYS.
   */
  async attention({ now = new Date() }: { now?: Date } = {}) {
    const today = this._today(now);
    const start = addDaysYmd(today, -ATTENTION_DAYS);
    const from = start < REPORTS_SINCE ? REPORTS_SINCE : start;
    const people = (await this._people()).filter((p) => p.isActive);
    const unread = [];
    const missing = [];
    const questions = [];
    const todayState = [];
    if (from <= today) {
      for (const p of people) {
        const [reports, timeOffs] = await Promise.all([this._reports(p.documentId, from, today), this._timeOffs(p.documentId, from, today)]);
        const days = dayStates({ from, to: today, today, reports, timeOffs, nowMin: pragueMinOf(now) });
        for (const d of days) if (d.state === 'missing') missing.push({ personal: p.documentId, name: p.name, date: d.date });
        const t = days.find((d) => d.date === today);
        if (t) todayState.push({ personal: p.documentId, name: p.name, state: t.state });
        for (const r of reports) {
          const fresh = !r.reviewedAt || editedAfterReview(r);
          if (r.status !== 'submitted' || !fresh) continue;
          const c = contentOf(r);
          unread.push({
            documentId: r.documentId,
            personal: p.documentId,
            name: p.name,
            date: r.date,
            hours: c.hours,
            items: c.items.length,
            late: r.late || null,
            editedAfterReview: editedAfterReview(r),
          });
          if (c.needsOwner) questions.push({ documentId: r.documentId, personal: p.documentId, name: p.name, date: r.date, text: cut(c.needsOwner, 300) });
        }
      }
    }
    const desc = (a: any, b: any) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    return { today, from, unread: unread.sort(desc), missing: missing.sort(desc), questions: questions.sort(desc), todayState };
  },
};
