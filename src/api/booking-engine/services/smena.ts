// @ts-nocheck
/**
 * «Směna administrátora» (s263, Фаза 1 плана ADMIN_SHIFT_NEXT_SESSION_PROMPT.md; решения
 * владельца — §0 плана): касса и рабочие часы администраторов из админки вместо панели Strapi.
 *
 * Коллекции `cash` («Деньги») и `work-time` («Рабочие часы») НЕ меняются — это другой вход в
 * те же черновики, которые потом публикует «Uzavření směny». Поэтому:
 *   • касса — одна запись в день (общая для всех на смене), `sum` = остаток в кассе после смены
 *     (строка), `flow[]` = строки прихода/расхода (`sum` biginteger, `coment`), `profit` считает
 *     lifecycle `cash` (движок его не дублирует, передаёт '0');
 *   • 🟥 инвариант кассы тот же, что в lifecycle: остаток = остаток предыдущей записи (по дате,
 *     черновик) + Σ строк. Движок проверяет САМ до записи (ошибка с числами), lifecycle —
 *     вторая линия. Остаток вводит человек по пересчёту — ожидаемый НЕ подставляется (§3.4);
 *   • расхождение — только явным «Zapsat rozdíl» с причиной (§0.1): сервер сам добавляет строку
 *     `Rozdíl v pokladně: <причина>`, пишет `smena_cash_discrepancy` и шлёт push руководству
 *     (env `SMENA_PUSH_ENABLED`). Вручную такую строку завести нельзя (`line_reserved`);
 *   • есть касса позже по дате → Σ строк менять нельзя (`later_cash_exists`): lifecycle этого
 *     не проверяет и молча рвёт цепочку остатков следующих дней;
 *   • часы — своя запись (карточка сессии) на день, только роль administrator (управляющая на
 *     окладе, у владельца карточки нет): часы = конец − начало без перерыва по сетке 30 мин
 *     (как в панели), комментарий — в HTML (`<p>`), как пишет CKEditor;
 *   • опубликовано закрытием смены → 409 `shift_closed`; окно — сегодня и `BACKFILL_DAYS` назад
 *     (Фаза 1 — для всех ролей; руководство читает любой прошедший день);
 *   • оптимистическая блокировка: клиент присылает `expectedUpdatedAt` того, что видел.
 * Журнал — calendar_logs, entityType `smena`, без текста комментариев.
 *
 * s265 — «Předání směny» (Фаза 2, §0в плана): одной кнопкой администраторка оставляет коллеге
 * сообщение (коллекция `shift-handover` без REST), ставит ей задачи и передаёт свои незавершённые
 * (через `owner-tasks`: create и переход `handover`, без их push — получательнице уходит ОДНА
 * сводка; постановщикам переданных — их push). Частичный сбой задачи сообщение не роняет — ошибки
 * списком. Сообщение одно на (день, от кого, кому), пока не прочитано (повтор — правка + новые
 * задачи); прочитанное — следующее новое. «Přečteno» — только получательница. Руководство видит
 * сообщения дня в сводке «Uzavření směny». Push сообщения — без env-гейта (как push задач).
 *
 * s266 — Фаза 3: «Kontrola směny» в админке (`check` → тот же `shift-selfcheck.runSelfCheck`, что у
 * виджета панели); руководство правит любой прошедший день и часы любой администраторки (`personal`);
 * `attention` для «Сегодня» руководства (незаполненные смены §5.3 за неделю, расхождения кассы в
 * незакрытых сменах, непрочитанные передачи старше 3 дней); напоминания 20:30/09:30 (`remind`, env
 * `SMENA_PUSH_ENABLED`) и строка дайджеста (`missingOn`); в сводке «Uzavření směny» — текст её
 * записей этого дня и вложения задач.
 *
 * Верх файла — чистые функции (tests/smena.test.mjs), ниже — сервис.
 */

import { pragueDateOf } from './slots-core';
import { findSessionPersonal } from '../../../utils/staff-identity';
import { findWorkingAdmins } from '../../../utils/staff-roster';

export class SmenaError extends Error {
  status: number;
  code: string;
  details?: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const CASH_UID = 'api::cash.cash';
export const WORK_UID = 'api::work-time.work-time';
const TASK_UID = 'api::owner-task.owner-task';
const LOG_UID = 'api::calendar-log.calendar-log';
export const HANDOVER_UID = 'api::shift-handover.shift-handover';
const SHIFT_UID = 'api::shift.shift';

// ── константы (решения §0/§8 — менять здесь) ────────────────────────────────
export const BACKFILL_DAYS = 2;
export const TIME_MIN = '08:00';
export const TIME_MAX = '21:00';
export const TIME_STEP_MIN = 30;
export const HOURS_MAX = 14;
export const MAX_FLOW_LINES = 40;
export const MAX_LINE_SUM = 200000;
export const MAX_LINE_COMMENT = 200;
export const MAX_DAY_COMMENT = 500;
export const MAX_WORK_COMMENT = 1500;
export const MIN_WORK_COMMENT = 3;
export const MAX_REASON = 150;
export const DISCREPANCY_ALLOWED = true;
export const DISCREPANCY_LABEL = 'Rozdíl v pokladně';
/** Кто пишет свои часы: администраторы (управляющая — оклад, у владельца карточки нет). */
export const WORK_ROLES = ['administrator'];
export const MANAGEMENT_ROLES = ['owner', 'manager'];
// s265: передача смены
export const MAX_HANDOVER_TEXT = 2000;
export const MAX_HANDOVER_NEW_TASKS = 10;
export const MAX_HANDOVER_TASKS = 30;
export const MAX_HANDOVER_NOTE = 500;
/** Сколько дней вперёд искать в графике, кто дежурит следующим (подсказка «Komu»). */
export const ROSTER_LOOKAHEAD_DAYS = 7;
/** Входящее непрочитанное — сколько дней назад ещё показывать (старше — Фаза 3: руководству). */
export const HANDOVER_INBOX_DAYS = 14;
/** Самая ранняя дата, которую вообще можно открыть (руководство — история). */
const EARLIEST = '2020-01-01';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
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

/** «15.10.2026». */
export const fmtDay = (ymd: unknown): string => {
  const s = String(ymd ?? '');
  return YMD.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '—';
};

/** «12 350» — для журнала и push. */
export const fmtKc = (n: unknown): string => {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0 ? '−' : ''}${s} Kč`;
};

/** Суммы кассы в базе — строки из панели: бывают «12 350» и «445,5». */
export const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

export const isManagement = (role: unknown): boolean => MANAGEMENT_ROLES.includes(String(role));

/** Окно записи: сегодня и BACKFILL_DAYS дней назад. */
export const windowStart = (today: string): string => addDaysYmd(today, -BACKFILL_DAYS);

/**
 * Дата из адреса. Будущее — нельзя никому. Администратор — только в окне (чтение и запись);
 * руководство — любой прошедший день (s266, Фаза 3: правит вместо панели Strapi; `write` оставлен
 * в сигнатуре — окно у администратора одно и то же).
 */
export const checkDate = (date: unknown, today: string, { management }: { write?: boolean; management: boolean }): string => {
  const d = String(date ?? '').trim();
  if (!isValidYmd(d) || d < EARLIEST) throw new SmenaError(400, 'bad_date', 'Neplatné datum', { field: 'date' });
  if (d > today) throw new SmenaError(409, 'out_of_window', 'Směnu nelze vyplnit dopředu', { field: 'date' });
  if (!management && d < windowStart(today)) {
    throw new SmenaError(409, 'out_of_window', `Směnu lze vyplnit nebo opravit nejvýš ${BACKFILL_DAYS} dny zpětně — starší opraví vedení`, { field: 'date' });
  }
  return d;
};

const cleanText = (v: unknown, max: number, code: string, field: string): string => {
  if (v != null && typeof v !== 'string') throw new SmenaError(400, code, 'Text má neplatný formát', { field });
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.length > max) throw new SmenaError(400, code, `Text je delší než ${max} znaků`, { field });
  return s;
};

/** Строка-расхождение (ставит только сервер). */
export const isReservedComment = (c: unknown): boolean => String(c ?? '').trim().toLowerCase().startsWith(DISCREPANCY_LABEL.toLowerCase());
export const discrepancyLine = (diff: number, reason: string) => ({ sum: diff, comment: `${DISCREPANCY_LABEL}: ${reason}` });

/**
 * День без наличных: на проде (с июля 2026 — ~3 раза в месяц) так и пишут — ОДНА строка с суммой 0
 * без описания (`flow` у схемы обязателен — пустой кассу при публикации не пускать). Клиент шлёт
 * пустой список, сервер кладёт эту строку сам.
 */
export const NO_MOVEMENT_LINE = { sum: 0, comment: '' };
export const isNoMovement = (flow: Array<{ sum: unknown }>): boolean => Array.isArray(flow) && flow.length === 1 && num(flow[0]?.sum) === 0;

/**
 * Строки потока: 1…MAX_FLOW_LINES; `sum` — целые кроны ≠ 0 (знак = направление),
 * |sum| ≤ MAX_LINE_SUM; комментарий ≤ MAX_LINE_COMMENT, у расхода — обязателен (сверка кассы
 * с затратами s238 матчится по нему). Ошибка несёт индекс строки.
 * Пустой список (или одна строка 0) — «bez pohybu» → `[NO_MOVEMENT_LINE]`.
 */
export const normalizeFlow = (raw: unknown): Array<{ sum: number; comment: string }> => {
  if (!Array.isArray(raw)) throw new SmenaError(400, 'bad_flow', 'Řádky pokladny mají neplatný formát', { field: 'flow' });
  if (!raw.length || (raw.length === 1 && (raw[0]?.sum === 0 || String(raw[0]?.sum ?? '').trim() === '0'))) return [{ ...NO_MOVEMENT_LINE }];
  if (raw.length > MAX_FLOW_LINES) throw new SmenaError(400, 'bad_flow', `Nejvýš ${MAX_FLOW_LINES} řádků`, { field: 'flow' });
  return raw.map((line: any, index: number) => {
    const s = line?.sum;
    const n = typeof s === 'number' ? s : typeof s === 'string' && s.trim() ? Number(s.replace(/\s/g, '')) : NaN;
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_LINE_SUM) {
      throw new SmenaError(400, 'bad_line', `Částka: celé koruny, ne 0, nejvýš ${fmtKc(MAX_LINE_SUM)}`, { field: 'flow.sum', index });
    }
    if (line?.comment != null && typeof line.comment !== 'string') {
      throw new SmenaError(400, 'bad_line_comment', 'Popis řádku má neplatný formát', { field: 'flow.comment', index });
    }
    const comment = String(line?.comment ?? '').replace(/\s+/g, ' ').trim();
    if (comment.length > MAX_LINE_COMMENT) {
      throw new SmenaError(400, 'bad_line_comment', `Popis řádku je delší než ${MAX_LINE_COMMENT} znaků`, { field: 'flow.comment', index });
    }
    if (n < 0 && !comment) throw new SmenaError(400, 'line_comment_required', 'U výdaje napište, za co', { field: 'flow.comment', index });
    return { sum: n, comment };
  });
};

export const flowTotals = (flow: Array<{ sum: unknown }>) => {
  let income = 0;
  let outflow = 0;
  for (const f of flow || []) {
    const s = num(f?.sum);
    if (s >= 0) income += s;
    else outflow += s;
  }
  return { income, outflow, total: income + outflow };
};

/** Остаток — целые кроны ≥ 0 (пересчёт кассы). */
export const normalizeBalance = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/\s/g, '')) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new SmenaError(400, 'bad_balance', 'Zůstatek: celé koruny, 0 nebo víc', { field: 'balance' });
  return n;
};

/**
 * Строки-расхождения можно только сохранить как были (уже записанные сервером); новую
 * такую строку руками — нельзя (иначе расхождение обходит журнал и push).
 */
export const checkReservedLines = (flow: Array<{ sum: number; comment: string }>, existing: Array<{ sum: unknown; comment?: unknown }>) => {
  const pool = (existing || []).filter((f) => isReservedComment(f?.comment)).map((f) => `${num(f.sum)}|${String(f.comment ?? '').replace(/\s+/g, ' ').trim()}`);
  flow.forEach((f, index) => {
    if (!isReservedComment(f.comment)) return;
    const i = pool.indexOf(`${f.sum}|${f.comment}`);
    if (i < 0) throw new SmenaError(400, 'line_reserved', `Řádek „${DISCREPANCY_LABEL}“ zapisuje jen tlačítko Zapsat rozdíl`, { field: 'flow.comment', index });
    pool.splice(i, 1);
  });
};

/**
 * Касса: сверка остатка с потоком (тот же инвариант, что lifecycle `cash`). Не сходится —
 * либо 400 `cash_mismatch` с числами, либо (явное «Zapsat rozdíl» с причиной) строка-расхождение.
 */
export const planCash = ({
  flow,
  balance,
  prevBalance,
  reason,
}: {
  flow: Array<{ sum: number; comment: string }>;
  balance: number;
  prevBalance: number;
  reason: string;
}) => {
  const flowSum = flowTotals(flow).total;
  const expected = prevBalance + flowSum;
  const diff = balance - expected;
  if (diff === 0) return { flow, discrepancy: null };
  if (!DISCREPANCY_ALLOWED || !reason) {
    throw new SmenaError(400, 'cash_mismatch', `Zůstatek nesedí: očekáváno ${fmtKc(expected)}, spočítáno ${fmtKc(balance)} (rozdíl ${fmtKc(diff)})`, {
      field: 'balance',
      expected,
      prev: prevBalance,
      flowSum,
      diff,
    });
  }
  // день «bez pohybu» + расхождение — строка 0 больше не нужна
  const base = isNoMovement(flow) ? [] : flow;
  if (base.length >= MAX_FLOW_LINES) throw new SmenaError(400, 'bad_flow', `Nejvýš ${MAX_FLOW_LINES} řádků`, { field: 'flow' });
  const line = discrepancyLine(diff, reason);
  return { flow: [...base, line], discrepancy: { diff, reason, expected } };
};

export const normalizeReason = (v: unknown): string => {
  const s = cleanText(v, MAX_REASON, 'bad_reason', 'reason').replace(/\s+/g, ' ');
  if (s && s.length < 3) throw new SmenaError(400, 'bad_reason', 'Napište důvod rozdílu (aspoň 3 znaky)', { field: 'reason' });
  return s;
};

// ── часы ─────────────────────────────────────────────────────────────────────
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** «HH:MM» на сетке TIME_MIN…TIME_MAX шаг TIME_STEP_MIN (= customField time-slot панели). */
export const parseSlot = (v: unknown, field: string): string => {
  const s = String(v ?? '').trim();
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  const min = m ? toMin(s) : NaN;
  if (!m || Number(m[2]) > 59 || min < toMin(TIME_MIN) || min > toMin(TIME_MAX) || min % TIME_STEP_MIN !== 0) {
    throw new SmenaError(400, 'bad_time', `Čas ${TIME_MIN}–${TIME_MAX} po ${TIME_STEP_MIN} minutách`, { field });
  }
  return s;
};

/** Все слоты сетки (для подсказки клиенту). */
export const timeSlots = (): string[] => {
  const out = [];
  for (let m = toMin(TIME_MIN); m <= toMin(TIME_MAX); m += TIME_STEP_MIN) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
};

/** Часы = конец − начало, без перерыва (как на проде: 10:30–19:00 = 8.5). */
export const hoursBetween = (start: string, end: string): number => {
  const d = toMin(end) - toMin(start);
  if (d <= 0) throw new SmenaError(400, 'end_before_start', 'Konec musí být po začátku', { field: 'endTime' });
  if (d > HOURS_MAX * 60) throw new SmenaError(400, 'too_long_shift', `Směna nejvýš ${HOURS_MAX} hodin`, { field: 'endTime' });
  return Math.round((d / 60) * 100) / 100;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** HTML из CKEditor → текст (абзацы — пустой строкой, <br> — переносом). */
export const htmlToText = (html: unknown): string =>
  String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>\s*/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#39|#\d+|[a-z]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] != null) return ENTITIES[k];
      if (/^#\d+$/.test(k)) return String.fromCodePoint(Number(k.slice(1)));
      return m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Текст → HTML как у CKEditor: абзацы `<p>`, перенос внутри абзаца — `<br>`; без `&nbsp;`. */
export const textToHtml = (text: string): string =>
  String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split('\n').map((l) => escapeHtml(l.trim())).join('<br>')}</p>`)
    .join('');

export const normalizeWorkInput = (body: any) => {
  const startTime = parseSlot(body?.startTime, 'startTime');
  const endTime = parseSlot(body?.endTime, 'endTime');
  const hours = hoursBetween(startTime, endTime);
  const comment = cleanText(body?.comment, MAX_WORK_COMMENT, 'bad_comment', 'comment')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  if (comment.replace(/\s/g, '').length < MIN_WORK_COMMENT) throw new SmenaError(400, 'comment_required', 'Napište, co jste během směny dělal/a', { field: 'comment' });
  return { startTime, endTime, hours, comment };
};

// ── виды наружу ──────────────────────────────────────────────────────────────
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const cashView = (doc: any, closed: boolean, lastSavedBy = '') => {
  if (!doc) return null;
  const flow = (Array.isArray(doc.flow) ? doc.flow : []).map((f) => ({ sum: num(f?.sum), comment: String(f?.coment ?? '').trim() }));
  const t = flowTotals(flow);
  return {
    documentId: doc.documentId,
    closed,
    balance: num(doc.sum),
    flow,
    comment: String(doc.comment ?? ''),
    income: t.income,
    outflow: t.outflow,
    byName: doc.personal?.name || '',
    lastSavedBy,
    updatedAt: iso(doc.updatedAt),
  };
};

export const workTimeView = (doc: any, closed: boolean) =>
  doc
    ? {
        documentId: doc.documentId,
        closed,
        startTime: String(doc.startTime ?? ''),
        endTime: String(doc.endTime ?? ''),
        hours: num(doc.sum),
        comment: htmlToText(doc.comment),
        name: doc.personal?.name || '',
        personal: doc.personal?.documentId || null,
        updatedAt: iso(doc.updatedAt),
      }
    : null;

/** Совпадает ли то, что видел клиент, с записью сейчас (null — записи не было). */
export const isStale = (body: any, doc: any): boolean => {
  if (!has(body, 'expectedUpdatedAt')) return false;
  const want = body.expectedUpdatedAt == null || body.expectedUpdatedAt === '' ? null : iso(body.expectedUpdatedAt);
  return want !== (doc ? iso(doc.updatedAt) : null);
};

/**
 * Задачи администраторам, отмеченные «hotovo» в этот день (по Праге). `login` — только её
 * отметки. Берётся последнее «hotovo» дня; статус — текущий (принята / ждёт / снова в работе).
 */
export const doneOnDate = (tasks: any[], date: string, login: string | null = null) => {
  const out = [];
  for (const t of tasks || []) {
    const events = Array.isArray(t?.events) ? t.events : [];
    let hit = null;
    for (const e of events) {
      if (e?.kind !== 'done' || e?.role !== 'administrator' || !e?.at) continue;
      if (pragueDateOf(e.at) !== date) continue;
      if (login && String(e.by ?? '').trim().toLowerCase() !== login.trim().toLowerCase()) continue;
      hit = e;
    }
    // s266: текст её записей этого дня (hotovo, průběh, komentář) — руководству в «Uzavření směny»
    if (hit) out.push({ documentId: t.documentId, title: String(t.title ?? ''), doneAt: hit.at, by: String(hit.by ?? ''), status: t.status || 'open', notes: notesOnDate(t, date, hit.by) });
  }
  return out.sort((a, b) => String(a.doneAt).localeCompare(String(b.doneAt)));
};

/** Одинаковы ли строки кассы (для «ничего не изменилось»). */
const sameFlow = (a: Array<{ sum: number; comment: string }>, b: Array<{ sum: number; comment: string }>) =>
  a.length === b.length && a.every((x, i) => x.sum === b[i].sum && x.comment === b[i].comment);

// ── push руководству (расхождение кассы) ────────────────────────────────────
export const pushEnabled = (): boolean => process.env.SMENA_PUSH_ENABLED === 'true';

export const discrepancyPayloads = ({ date, diff, reason, by }: { date: string; diff: number; reason: string; by: string }) => {
  const dm = `${date.slice(8, 10)}.${date.slice(5, 7)}`;
  const r = reason.length > 80 ? `${reason.slice(0, 79)}…` : reason;
  return {
    owner: { title: '⚠️ Расхождение в кассе', body: `${dm} · ${fmtKc(diff)} · ${by || 'администратор'}\n${r}`, url: `/smena?date=${date}`, tag: `smena-diff-${date}` },
    manager: { title: '⚠️ Rozdíl v pokladně', body: `${dm} · ${fmtKc(diff)} · ${by || 'administrátorka'}\n${r}`, url: `/smena?date=${date}`, tag: `smena-diff-${date}` },
  };
};

// ── передача смены (s265) ────────────────────────────────────────────────────
const DOC_ID = /^[a-z0-9]{10,40}$/;

/**
 * Тело «Předat směnu»: кому, сообщение, новые задачи коллеге, свои задачи на передачу, заметка
 * к передаче. Пустое (ни текста, ни задач) — 400. Ошибки задач несут индекс строки.
 */
export const normalizeHandoverInput = (body: any) => {
  const to = String(body?.to ?? '').trim();
  if (!DOC_ID.test(to)) throw new SmenaError(400, 'bad_recipient', 'Vyberte, komu směnu předáváte', { field: 'to' });
  const text = cleanText(body?.text, MAX_HANDOVER_TEXT, 'bad_text', 'text');
  const note = cleanText(body?.note, MAX_HANDOVER_NOTE, 'bad_note', 'note');
  const rawTasks = body?.tasks == null ? [] : body.tasks;
  if (!Array.isArray(rawTasks)) throw new SmenaError(400, 'bad_tasks', 'Úkoly mají neplatný formát', { field: 'tasks' });
  if (rawTasks.length > MAX_HANDOVER_NEW_TASKS) throw new SmenaError(400, 'bad_tasks', `Nejvýš ${MAX_HANDOVER_NEW_TASKS} nových úkolů`, { field: 'tasks' });
  const tasks = rawTasks.map((t: any, index: number) => {
    const title = cleanText(t?.title, 200, 'bad_task', 'tasks.title').replace(/\s+/g, ' ');
    if (!title) throw new SmenaError(400, 'task_title_required', 'Napište, co je potřeba udělat', { field: 'tasks.title', index });
    const description = cleanText(t?.description, 4000, 'bad_task', 'tasks.description');
    return { title, description };
  });
  const rawIds = body?.handover == null ? [] : body.handover;
  if (!Array.isArray(rawIds) || rawIds.some((x) => !DOC_ID.test(String(x ?? '')))) {
    throw new SmenaError(400, 'bad_tasks', 'Předávané úkoly mají neplatný formát', { field: 'handover' });
  }
  const handover = [...new Set(rawIds.map(String))];
  if (handover.length > MAX_HANDOVER_TASKS) throw new SmenaError(400, 'bad_tasks', `Nejvýš ${MAX_HANDOVER_TASKS} úkolů najednou`, { field: 'handover' });
  if (!text && !tasks.length && !handover.length) {
    throw new SmenaError(400, 'handover_empty', 'Napište vzkaz nebo přidejte úkol', { field: 'text' });
  }
  return { to, text, note, tasks, handover };
};

/** Задачи сообщения: [{id, kind: 'new'|'handover'}] без повторов (повторная передача — последний вид). */
export const mergeHandoverTasks = (prev: unknown, next: Array<{ id: string; kind: string }>) => {
  const out = new Map<string, string>();
  for (const t of [...(Array.isArray(prev) ? prev : []), ...next]) {
    const id = String(t?.id ?? '');
    if (DOC_ID.test(id)) out.set(id, t?.kind === 'new' ? 'new' : 'handover');
  }
  return [...out].map(([id, kind]) => ({ id, kind }));
};

/** Сводка для push получательнице: «Vzkaz · 2 nové úkoly · 1 předaný». */
export const handoverParts = ({ text, created, handed }: { text: string; created: number; handed: number }): string => {
  const parts = [];
  if (text) parts.push('Vzkaz');
  if (created) parts.push(`${created} ${created === 1 ? 'nový úkol' : created <= 4 ? 'nové úkoly' : 'nových úkolů'}`);
  if (handed) parts.push(`${handed} ${handed === 1 ? 'předaný úkol' : handed <= 4 ? 'předané úkoly' : 'předaných úkolů'}`);
  return parts.join(' · ');
};

export const handoverPayload = ({ id, from, text, created, handed }: { id: string; from: string; text: string; created: number; handed: number }) => {
  const head = handoverParts({ text, created, handed });
  const t = text.replace(/\s+/g, ' ').trim();
  return {
    title: `📨 Předání směny${from ? ` od ${from.length > 40 ? `${from.slice(0, 39)}…` : from}` : ''}`,
    body: [head, t.length > 140 ? `${t.slice(0, 139)}…` : t].filter(Boolean).join('\n'),
    url: '/smena',
    tag: `handover-${id}`,
  };
};

/** Сообщение наружу; `tasksById` — текущие названия/статусы задач (чужие тоже — только название). */
export const handoverView = (doc: any, tasksById: Map<string, any> = new Map()) => ({
  documentId: doc.documentId,
  date: doc.date || null,
  fromName: String(doc.fromName ?? ''),
  fromPersonal: doc.fromPersonalDocId || null,
  toName: String(doc.toName ?? ''),
  toPersonal: doc.toPersonalDocId || null,
  text: String(doc.text ?? ''),
  tasks: (Array.isArray(doc.taskDocIds) ? doc.taskDocIds : []).map((t) => {
    const row = tasksById.get(t?.id);
    return { documentId: String(t?.id ?? ''), kind: t?.kind === 'new' ? 'new' : 'handover', title: row ? String(row.title ?? '') : '', status: row?.status || null };
  }),
  readAt: iso(doc.readAt),
  readBy: doc.readBy || null,
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

/**
 * Входящие получательнице: непрочитанные (не старше HANDOVER_INBOX_DAYS) и прочитанные сегодня
 * (по Праге — карточка ещё день видна свёрнутой). Свежие сверху.
 */
export const inboxOf = (rows: any[], today: string) =>
  (rows || [])
    .filter((r) => (r.readAt ? pragueDateOf(r.readAt) === today : String(r.date ?? '') >= addDaysYmd(today, -HANDOVER_INBOX_DAYS)))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const dowMon = (ymd: string) => (new Date(`${ymd}T12:00:00Z`).getUTCDay() + 6) % 7;
export const mondayOf = (ymd: string) => addDaysYmd(ymd, -dowMon(ymd));

/**
 * Кто дежурит следующим по графику `shift` (свободный текст «Вика»): первый день после `date`
 * (до ROSTER_LOOKAHEAD_DAYS) с непустым именем. Только подсказка человеку — карточки не сопоставляются.
 */
export const nextDutyOf = (weeks: Map<string, any>, date: string) => {
  for (let i = 1; i <= ROSTER_LOOKAHEAD_DAYS; i += 1) {
    const d = addDaysYmd(date, i);
    const name = String(weeks.get(mondayOf(d))?.[DAY_KEYS[dowMon(d)]] ?? '').trim();
    if (name) return { date: d, name };
  }
  return null;
};

// ── Фаза 3 (s266): «не заполнено», расхождения, непрочитанные передачи, напоминания ──

/** Сколько дней назад (до вчера включительно) «Сегодня» руководства ищет незаполненные смены. */
export const ATTENTION_DAYS = 7;
/** Расхождения кассы висят на «Сегодня», пока смена не закрыта, — но не старше этого. */
export const DISCREPANCY_DAYS = 14;
/** Непрочитанное сообщение передачи — руководству, когда ему столько дней (§0.6). */
export const HANDOVER_STALE_DAYS = 3;
/** …и не старше этого (дальше уже неважно). */
export const HANDOVER_STALE_MAX_DAYS = 30;
/** Статусы брони, при которых салон в этот день работал (клиенты были/будут). */
export const WORKING_BOOKING_STATUSES = ['active', 'checkedOut'];

/** Имя дежурного из недели графика `shift` (свободный текст) на дату; '' — не указан. */
export const dutyOn = (weeks: Map<string, any>, date: string): string => String(weeks.get(mondayOf(date))?.[DAY_KEYS[dowMon(date)]] ?? '').replace(/\s+/g, ' ').trim();

/**
 * §5.3: день «не заполнен» — салон работал (были брони или дежурный по графику), а кассы нет
 * или нет часов ни у одной администраторки. Выходные салона (ни броней, ни дежурного) — не считаются.
 * `visits` — число броней по дате, `duty` — дежурный, `cashDates`/`workDates` — есть запись (черновик или закрытая).
 */
export const missingDays = (
  dates: string[],
  { visits, duty, cashDates, workDates }: { visits: Map<string, number>; duty: Map<string, string>; cashDates: Set<string>; workDates: Set<string> }
) =>
  dates
    .map((date) => {
      const v = Number(visits.get(date)) || 0;
      const d = String(duty.get(date) ?? '');
      if (!v && !d) return null;
      const cash = !cashDates.has(date);
      const workTime = !workDates.has(date);
      return cash || workTime ? { date, cash, workTime, visits: v, duty: d } : null;
    })
    .filter(Boolean);

/** Причина из строки-расхождения («Rozdíl v pokladně: <причина>»). */
export const reasonOf = (comment: unknown): string =>
  String(comment ?? '')
    .trim()
    .slice(DISCREPANCY_LABEL.length)
    .replace(/^\s*:\s*/, '')
    .trim();

/**
 * Расхождения кассы в незакрытых сменах: строки «Rozdíl v pokladně» у касс без опубликованной
 * версии. `published` — documentId закрытых; `actors` — кто записал расхождение (из журнала).
 */
export const discrepanciesOf = (cashes: any[], published: Set<string>, actors: Map<string, string> = new Map()) => {
  const out = [];
  for (const c of cashes || []) {
    if (!c?.documentId || published.has(c.documentId)) continue;
    for (const f of Array.isArray(c.flow) ? c.flow : []) {
      if (!isReservedComment(f?.coment)) continue;
      out.push({ date: c.date, cashDocId: c.documentId, diff: num(f.sum), reason: reasonOf(f.coment), by: actors.get(c.documentId) || c.personal?.name || '' });
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
};

/** Непрочитанные сообщения передачи, которым ≥ HANDOVER_STALE_DAYS дней (по дате смены). */
export const staleHandoversOf = (rows: any[], today: string) => {
  const edge = addDaysYmd(today, -HANDOVER_STALE_DAYS);
  return (rows || [])
    .filter((h) => !h.readAt && String(h.date ?? '') <= edge)
    .map((h) => ({ documentId: h.documentId, date: h.date, fromName: String(h.fromName ?? ''), toName: String(h.toName ?? ''), days: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${h.date}T00:00:00Z`)) / 86400000) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
};

/** «pokladna a hodiny» / «pokladna» / «hodiny». */
export const missingText = (m: { cash: boolean; workTime: boolean }, lang: 'cs' | 'ru' | 'uk' = 'cs'): string => {
  const words = {
    cs: ['pokladna', 'hodiny', ' a '],
    ru: ['касса', 'часы', ' и '],
    uk: ['каса', 'години', ' і '],
  }[lang];
  return [m.cash ? words[0] : '', m.workTime ? words[1] : ''].filter(Boolean).join(words[2]);
};

/**
 * Напоминание «смена не заполнена» (§7): вечером 20:30 — за сегодня, утром 09:30 — за вчера.
 * Администраторкам — по-чешски; руководству (утро) — владельцу по-русски, управляющей по-чешски.
 */
export const reminderPayloads = (kind: 'evening' | 'morning', m: { date: string; cash: boolean; workTime: boolean }) => {
  const dm = `${m.date.slice(8, 10)}.${m.date.slice(5, 7)}`;
  const url = kind === 'evening' ? '/smena' : `/smena?date=${m.date}`;
  const tag = `smena-missing-${m.date}`;
  return {
    admin: {
      title: kind === 'evening' ? '📒 Směna dnes není vyplněná' : `📒 Směna ${dm} není vyplněná`,
      body: `Chybí ${missingText(m, 'cs')} — doplňte v modulu Směna.`,
      url,
      tag,
    },
    manager: { title: `📒 Směna ${dm} není vyplněná`, body: `Chybí ${missingText(m, 'cs')}.`, url: `/smena?date=${m.date}`, tag },
    owner: { title: `📒 Смена ${dm} не заполнена`, body: `Нет: ${missingText(m, 'ru')}.`, url: `/smena?date=${m.date}`, tag },
  };
};

/**
 * Задачи, отмеченные «hotovo» в этот день, + текст: что она написала в этот день (hotovo, průběh,
 * komentář) — руководству в «Uzavření směny» (§0б.4, Фаза 3).
 */
export const notesOnDate = (task: any, date: string, by: string) =>
  (Array.isArray(task?.events) ? task.events : [])
    .filter(
      (e) =>
        ['done', 'progress', 'comment'].includes(e?.kind) &&
        String(e?.text ?? '').trim() &&
        e?.at &&
        pragueDateOf(e.at) === date &&
        String(e.by ?? '').trim().toLowerCase() === String(by ?? '').trim().toLowerCase()
    )
    .map((e) => ({ kind: e.kind, at: e.at, text: String(e.text).trim() }));

/** Вложение задачи наружу (без имени файла на диске). */
export const fileOut = (f: any) => ({ documentId: f.documentId, fileName: f.fileName || 'soubor', mime: f.mime || null, size: Number(f.size) || 0, createdAt: f.createdAt || null });

// ── сервис ───────────────────────────────────────────────────────────────────

const CASH_FIELDS = ['date', 'sum', 'comment', 'createdAt', 'updatedAt'];
const WORK_FIELDS = ['date', 'startTime', 'endTime', 'sum', 'comment', 'createdAt', 'updatedAt'];

export default {
  _today(now: Date) {
    return pragueDateOf(now);
  },

  _log(action: string, session: any, docId: string, employeeName: string, summary: string, details: any = {}) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({ action, entityType: 'smena', actorName: session?.username || '', entityDocId: docId, employeeName, summary, details })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /**
   * Кто спрашивает. Администратор — по своей карточке (без неё — 404 `no_card`); руководство —
   * карточка, если есть (у владельца её нет — это нормально, часы он не пишет).
   */
  async _who(session: any) {
    const role = String(session?.role || '');
    if (!['owner', 'manager', 'administrator'].includes(role)) throw new SmenaError(403, 'not_allowed', 'Směna není pro tuto roli');
    const me = role === 'owner' ? null : await findSessionPersonal(strapi, session, { status: 'draft', fields: ['name'] });
    if (role === 'administrator' && !me) {
      throw new SmenaError(404, 'no_card', 'Účet není propojen s kartou zaměstnance — řekněte vedení');
    }
    return { role, management: isManagement(role), login: String(session?.username || ''), me: me ? { documentId: me.documentId, name: String(me.name ?? '').trim() } : null };
  },

  async _published(uid: string, ids: string[]) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Set();
    const rows = await strapi.documents(uid).findMany({ status: 'published', filters: { documentId: { $in: list } }, fields: ['id'], limit: list.length * 2 });
    return new Set(rows.map((r) => r.documentId));
  },

  _cashesOfDay(date: string) {
    return strapi.documents(CASH_UID).findMany({
      status: 'draft',
      filters: { date: { $eq: date } },
      fields: CASH_FIELDS,
      populate: { flow: { fields: ['sum', 'coment'] }, personal: { fields: ['name'] } },
      sort: [{ id: 'asc' }],
      limit: 10,
    });
  },

  /** Остаток предыдущей записи — тем же запросом, что lifecycle (черновик, `date <`). */
  async _prev(date: string) {
    const doc = await strapi.documents(CASH_UID).findFirst({ status: 'draft', sort: { date: 'desc' }, fields: ['date', 'sum'], filters: { date: { $lt: date } } });
    return { prevBalance: doc ? num(doc.sum) : 0, prevDate: doc?.date || null };
  },

  async _laterExists(date: string) {
    const doc = await strapi.documents(CASH_UID).findFirst({ status: 'draft', fields: ['date'], filters: { date: { $gt: date } } });
    return !!doc;
  },

  _workTimes(date: string, personalDocId: string | null = null) {
    return strapi.documents(WORK_UID).findMany({
      status: 'draft',
      filters: { date: { $eq: date }, ...(personalDocId ? { personal: { documentId: { $eq: personalDocId } } } : {}) },
      fields: WORK_FIELDS,
      populate: { personal: { fields: ['name'] } },
      sort: [{ id: 'asc' }],
      limit: 50,
    });
  },

  async _lastSavedBy(docId: string) {
    try {
      const row = await strapi.db.query(LOG_UID).findOne({
        where: { entityType: 'smena', entityDocId: docId, action: { $startsWith: 'smena_cash' } },
        select: ['actorName'],
        orderBy: { createdAt: 'desc' },
      });
      return row?.actorName || '';
    } catch {
      return '';
    }
  },

  async _tasksDone(date: string, login: string | null) {
    try {
      const rows = await strapi.documents(TASK_UID).findMany({
        filters: { assignee: { $eq: 'administrator' }, updatedAt: { $gte: `${addDaysYmd(date, -1)}T00:00:00.000Z` } },
        fields: ['title', 'status', 'events'],
        limit: 500,
      });
      return doneOnDate(rows, date, login);
    } catch (e) {
      strapi.log.error(`smena: tasks done ${date} failed: ${e?.message || e}`);
      return [];
    }
  },

  async _visitsOpen(date: string, now: Date) {
    try {
      return (await strapi.service('api::booking-engine.today').unclosedVisits({ from: date, to: date }, now)).length;
    } catch (e) {
      strapi.log.error(`smena: open visits ${date} failed: ${e?.message || e}`);
      return null;
    }
  },

  /** GET /smena/:date — касса дня, свои часы, статус. */
  async day({ session, date: rawDate, now = new Date() }: { session: any; date: unknown; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const date = checkDate(rawDate, today, { write: false, management: who.management });
    const canWriteHours = WORK_ROLES.includes(who.role) && !!who.me;
    const [cashes, prev, laterCashExists, works, visitsOpen, tasksDone] = await Promise.all([
      this._cashesOfDay(date),
      this._prev(date),
      this._laterExists(date),
      this._workTimes(date),
      this._visitsOpen(date, now),
      who.role === 'administrator' ? this._tasksDone(date, who.login) : Promise.resolve([]),
    ]);
    const cashDoc = cashes[0] || null;
    const handover = await this._handoverBlock(who, date, today);
    const published = await this._published(CASH_UID, cashDoc ? [cashDoc.documentId] : []);
    const workPublished = await this._published(WORK_UID, works.map((w) => w.documentId));
    const own = canWriteHours ? works.find((w) => w.personal?.documentId === who.me.documentId) || null : null;
    const cash = cashView(cashDoc, cashDoc ? published.has(cashDoc.documentId) : false, cashDoc ? await this._lastSavedBy(cashDoc.documentId) : '');
    const workTime = workTimeView(own, own ? workPublished.has(own.documentId) : false);
    const inWindow = date >= windowStart(today);
    return {
      date,
      today,
      // s266: руководство правит любой прошедший день (окно — только у администраторок)
      editable: who.management || inWindow,
      editableFrom: windowStart(today),
      backfillDays: BACKFILL_DAYS,
      role: who.role,
      me: who.me,
      canWriteHours,
      // s266: руководство пишет/правит часы любой администраторки (`personal` в теле / `?personal=`)
      canEditTeamHours: who.management,
      cash,
      cashDuplicate: cashes.length > 1,
      prevBalance: prev.prevBalance,
      prevDate: prev.prevDate,
      laterCashExists,
      workTime,
      // часы коллег — только руководству (администратору чужие часы не отдаём)
      others: who.management ? works.map((w) => workTimeView(w, workPublished.has(w.documentId))) : [],
      tasksDone,
      check: { cashMissing: !cashDoc, workTimeMissing: canWriteHours ? !own : null, visitsOpen },
      slots: timeSlots(),
      discrepancyLabel: DISCREPANCY_LABEL,
      ...handover,
    };
  },

  // ── передача смены (s265) ──────────────────────────────────────────────────

  /** Кто отправитель сообщения: карточка, у владельца — логин. */
  _fromKey(who: any) {
    return who.me ? { fromPersonalDocId: { $eq: who.me.documentId } } : { fromLogin: { $eq: who.login } };
  },

  async _tasksById(views: any[]) {
    const ids = [...new Set(views.flatMap((h) => (Array.isArray(h.taskDocIds) ? h.taskDocIds : []).map((t) => t?.id)).filter(Boolean))];
    if (!ids.length) return new Map();
    try {
      const rows = await strapi.documents(TASK_UID).findMany({ filters: { documentId: { $in: ids } }, fields: ['title', 'status'], limit: ids.length + 5 });
      return new Map(rows.map((r) => [r.documentId, r]));
    } catch (e) {
      strapi.log.error(`smena: handover tasks failed: ${e?.message || e}`);
      return new Map();
    }
  },

  async _nextDuty(date: string) {
    try {
      const mondays = [...new Set(Array.from({ length: ROSTER_LOOKAHEAD_DAYS }, (_, i) => mondayOf(addDaysYmd(date, i + 1))))];
      const weeks = await strapi.documents(SHIFT_UID).findMany({ status: 'draft', filters: { from: { $in: mondays } }, fields: ['from'], populate: { days: true }, limit: 10 });
      return nextDutyOf(new Map(weeks.map((w) => [String(w.from).slice(0, 10), w.days || {}])), date);
    } catch (e) {
      strapi.log.error(`smena: roster ${date} failed: ${e?.message || e}`);
      return null;
    }
  },

  /**
   * Для экрана смены: входящие сообщения (мне — не прочитано или прочитано сегодня), мои
   * сообщения за этот день, кому можно передать (работающие администраторки без меня),
   * кто следующий по графику. Сбой — пустой блок (касса и часы важнее).
   */
  async _handoverBlock(who: any, date: string, today: string) {
    const empty = { handoverIn: [], handoverOut: [], colleagues: [], nextDuty: null };
    try {
      const [incoming, outgoing, admins, nextDuty] = await Promise.all([
        who.me
          ? strapi.documents(HANDOVER_UID).findMany({
              filters: { toPersonalDocId: { $eq: who.me.documentId }, $or: [{ readAt: { $null: true } }, { readAt: { $gte: `${addDaysYmd(today, -1)}T00:00:00.000Z` } }] },
              sort: [{ createdAt: 'desc' }],
              limit: 50,
            })
          : Promise.resolve([]),
        strapi.documents(HANDOVER_UID).findMany({ filters: { date: { $eq: date }, ...this._fromKey(who) }, sort: [{ createdAt: 'asc' }], limit: 20 }),
        findWorkingAdmins(strapi),
        this._nextDuty(date),
      ]);
      const inbox = inboxOf(incoming, today);
      const tasks = await this._tasksById([...inbox, ...outgoing]);
      return {
        handoverIn: inbox.map((h) => handoverView(h, tasks)),
        handoverOut: outgoing.map((h) => handoverView(h, tasks)),
        colleagues: admins.filter((a) => a.documentId !== who.me?.documentId).map((a) => ({ documentId: a.documentId, name: a.name })),
        nextDuty,
      };
    } catch (e) {
      strapi.log.error(`smena: handover block ${date} failed: ${e?.message || e}`);
      return empty;
    }
  },

  /**
   * PUT /smena/:date/handover {to, text, tasks[{title, description}], handover[taskId], note} —
   * «Předat směnu»: задачи коллеге, передача своих, сообщение; один push получательнице.
   * Ответ: `{ handover, created, handedOver, errors, day }`.
   */
  async handover({ session, date: rawDate, body, now = new Date() }: { session: any; date: unknown; body: any; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const date = checkDate(rawDate, today, { write: true, management: who.management });
    const input = normalizeHandoverInput(body);
    const to = (await findWorkingAdmins(strapi)).find((a) => a.documentId === input.to);
    if (!to) throw new SmenaError(400, 'bad_recipient', 'Vyberte kolegyni ze seznamu', { field: 'to' });
    if (who.me && to.documentId === who.me.documentId) throw new SmenaError(400, 'bad_recipient', 'Sama sobě směnu předat nelze', { field: 'to' });

    const tasksSvc = strapi.service('api::booking-engine.owner-tasks');
    const done: Array<{ id: string; kind: string }> = [];
    const errors = [];
    for (const [index, t] of input.tasks.entries()) {
      try {
        const res = await tasksSvc.create({ session, body: { assignee: 'administrator', personal: to.documentId, title: t.title, description: t.description }, now, quiet: true });
        done.push({ id: res.task.documentId, kind: 'new' });
      } catch (e) {
        errors.push({ kind: 'new', index, title: t.title, code: e?.code || 'internal', message: e?.code ? e.message : 'Úkol se nepodařilo založit' });
      }
    }
    for (const id of input.handover) {
      try {
        await tasksSvc.act({ session, id, body: { action: 'handover', to: to.documentId, text: input.note }, now, quiet: 'assignee' });
        done.push({ id, kind: 'handover' });
      } catch (e) {
        errors.push({ kind: 'handover', id, code: e?.code || 'internal', message: e?.code ? e.message : 'Úkol se nepodařilo předat' });
      }
    }
    if (!input.text && !done.length) {
      throw new SmenaError(409, 'handover_failed', errors[0]?.message || 'Nic se nepředalo', { field: 'tasks', errors });
    }

    const fromName = who.me?.name || who.login;
    const [existing] = await strapi.documents(HANDOVER_UID).findMany({
      filters: { date: { $eq: date }, toPersonalDocId: { $eq: to.documentId }, readAt: { $null: true }, ...this._fromKey(who) },
      sort: [{ createdAt: 'desc' }],
      limit: 1,
    });
    const taskDocIds = mergeHandoverTasks(existing?.taskDocIds, done);
    // повтор без нового текста — прежний текст остаётся
    const text = input.text || existing?.text || '';
    const saved = existing
      ? await strapi.documents(HANDOVER_UID).update({ documentId: existing.documentId, data: { text, taskDocIds, version: (Number(existing.version) || 0) + 1 } })
      : await strapi.documents(HANDOVER_UID).create({
          data: {
            date,
            fromPersonalDocId: who.me?.documentId || null,
            fromName,
            fromLogin: who.login,
            fromRole: who.role,
            toPersonalDocId: to.documentId,
            toName: to.name,
            text,
            taskDocIds,
            version: 1,
          },
        });

    const created = done.filter((d) => d.kind === 'new').length;
    const handed = done.length - created;
    const parts = handoverParts({ text: input.text, created, handed });
    this._log(
      existing ? 'smena_handover_update' : 'smena_handover',
      session,
      saved.documentId,
      who.me?.name || '',
      `Předání směny ${fmtDay(date)} → ${to.name}${parts ? `: ${parts.toLowerCase()}` : ''}`,
      { datum: fmtDay(date), komu: to.name, vzkaz: input.text ? 'ano' : 'ne', 'nové úkoly': created, předané: handed, chyby: errors.length }
    );
    if (input.text || done.length) this._notifyHandover(to, handoverPayload({ id: saved.documentId, from: fromName, text: input.text, created, handed }));
    const tasks = await this._tasksById([saved]);
    return { handover: handoverView(saved, tasks), created, handedOver: handed, errors, day: await this.day({ session, date, now }) };
  },

  _notifyHandover(to: any, payload: any) {
    try {
      Promise.resolve(strapi.service('api::booking-engine.manager-notify').toAdmin(to, payload, 'smena_handover')).catch((e) =>
        strapi.log.error(`smena: push handover failed: ${e?.message || e}`)
      );
    } catch (e) {
      strapi.log.error(`smena: push handover failed: ${e?.message || e}`);
    }
  },

  /** POST /smena/handover/:id/read — «Přečteno»: только получательница; повтор — без изменений. */
  async readHandover({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    const who = await this._who(session);
    const documentId = String(id ?? '').trim();
    const notFound = () => new SmenaError(404, 'handover_not_found', 'Vzkaz nenalezen');
    if (!DOC_ID.test(documentId)) throw notFound();
    const doc = await strapi.documents(HANDOVER_UID).findOne({ documentId });
    if (!doc || !who.me || doc.toPersonalDocId !== who.me.documentId) throw notFound();
    let saved = doc;
    if (!doc.readAt) {
      saved = await strapi.documents(HANDOVER_UID).update({ documentId, data: { readAt: now.toISOString(), readBy: who.login, version: (Number(doc.version) || 0) + 1 } });
      this._log('smena_handover_read', session, documentId, who.me.name, `Vzkaz přečten: ${doc.fromName || '—'} → ${doc.toName || '—'} (${fmtDay(doc.date)})`, {
        datum: fmtDay(doc.date),
        od: doc.fromName || '',
      });
    }
    return { handover: handoverView(saved, await this._tasksById([saved])) };
  },

  /** PUT /smena/:date/cash {flow, balance, comment?, discrepancyReason?, expectedUpdatedAt?} */
  async saveCash({ session, date: rawDate, body, now = new Date() }: { session: any; date: unknown; body: any; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const date = checkDate(rawDate, today, { write: true, management: who.management });
    const input = normalizeFlow(body?.flow);
    const balance = normalizeBalance(body?.balance);
    const comment = cleanText(body?.comment, MAX_DAY_COMMENT, 'bad_comment', 'comment');
    const reason = normalizeReason(body?.discrepancyReason);

    const cashes = await this._cashesOfDay(date);
    if (cashes.length > 1) throw new SmenaError(409, 'cash_duplicate', 'Za tento den jsou dvě pokladny — opraví vedení v administraci Strapi');
    const existing = cashes[0] || null;
    if (existing && (await this._published(CASH_UID, [existing.documentId])).has(existing.documentId)) {
      throw new SmenaError(409, 'shift_closed', 'Směna je uzavřená vedením — opravu udělá vedení');
    }
    if (isStale(body, existing)) throw new SmenaError(409, 'stale', 'Pokladnu mezitím někdo změnil — načtěte ji znovu');
    const before = existing ? cashView(existing, false) : null;
    checkReservedLines(input, before?.flow || []);

    const { prevBalance } = await this._prev(date);
    const plan = planCash({ flow: input, balance, prevBalance, reason });
    const oldTotal = before ? flowTotals(before.flow).total : 0;
    if (flowTotals(plan.flow).total !== oldTotal && (await this._laterExists(date))) {
      throw new SmenaError(409, 'later_cash_exists', 'Pokladna z pozdějšího dne už existuje — změna částek by rozbila zůstatky, opraví vedení', { field: 'balance' });
    }
    if (before && sameFlow(before.flow, plan.flow) && before.balance === balance && before.comment === comment) {
      return this.day({ session, date, now });
    }

    const data = {
      date,
      sum: String(balance),
      comment,
      flow: plan.flow.map((f) => ({ sum: String(f.sum), coment: f.comment })),
    };
    let saved;
    try {
      if (existing) {
        saved = await strapi.documents(CASH_UID).update({ documentId: existing.documentId, status: 'draft', data });
      } else {
        // profit обязателен по схеме — lifecycle перезапишет своим расчётом
        saved = await strapi.documents(CASH_UID).create({ data: { ...data, profit: '0', personal: who.me?.documentId || null } });
        // двое сохранили одновременно — остаётся первая запись дня
        const all = await this._cashesOfDay(date);
        if (all.length > 1 && all[0].documentId !== saved.documentId) {
          await strapi.documents(CASH_UID).delete({ documentId: saved.documentId });
          throw new SmenaError(409, 'stale', 'Pokladnu mezitím někdo uložil — načtěte ji znovu');
        }
      }
    } catch (e) {
      if (e instanceof SmenaError) throw e;
      if (e?.name === 'ValidationError') throw new SmenaError(400, 'lifecycle_rejected', e.message || 'Pokladnu nelze uložit', { field: 'balance' });
      throw e;
    }

    const t = flowTotals(plan.flow);
    const details: any = { datum: fmtDay(date), zůstatek: balance, příjem: t.income, výdaj: t.outflow, řádků: plan.flow.length };
    if (before) Object.assign(details, { 'předtím zůstatek': before.balance, 'předtím řádků': before.flow.length });
    const action = existing ? 'smena_cash_update' : 'smena_cash_create';
    this._log(action, session, saved.documentId, who.me?.name || '', `${existing ? 'Pokladna upravena' : 'Pokladna zapsána'} ${fmtDay(date)}: zůstatek ${fmtKc(balance)}`, details);
    if (plan.discrepancy) {
      const d = plan.discrepancy;
      this._log('smena_cash_discrepancy', session, saved.documentId, who.me?.name || '', `Rozdíl v pokladně ${fmtDay(date)}: ${fmtKc(d.diff)}`, {
        datum: fmtDay(date),
        rozdíl: d.diff,
        očekáváno: d.expected,
        spočítáno: balance,
        důvod: d.reason,
      });
      this._notifyDiscrepancy({ date, diff: d.diff, reason: d.reason, by: who.me?.name || session?.username || '' });
    }
    return this.day({ session, date, now });
  },

  _notifyDiscrepancy({ date, diff, reason, by }: { date: string; diff: number; reason: string; by: string }) {
    if (!pushEnabled()) return;
    const p = discrepancyPayloads({ date, diff, reason, by });
    const n = strapi.service('api::booking-engine.manager-notify');
    Promise.all([n.toOwner(p.owner, 'smena_discrepancy'), n.toManagers(p.manager, 'smena_discrepancy')]).catch((e) =>
      strapi.log.error(`smena: push discrepancy ${date} failed: ${e?.message || e}`)
    );
  },

  /**
   * Чьи часы. Администраторка — свои (карточка сессии), `personal` не смотрим. Руководство (s266,
   * Фаза 3) — любой администраторки: `personal` обязателен; работающая или с записью в этот день
   * (ушедшая — поправить старое). Своих часов у руководства нет (управляющая — оклад).
   */
  async _workTarget(who: any, date: string, personalRaw: unknown) {
    if (WORK_ROLES.includes(who.role)) return who.me;
    if (!who.management) throw new SmenaError(403, 'not_allowed', 'Hodiny zapisují administrátorky');
    const id = String(personalRaw ?? '').trim();
    if (!DOC_ID.test(id)) throw new SmenaError(400, 'personal_required', 'Vyberte administrátorku', { field: 'personal' });
    const admin = (await findWorkingAdmins(strapi)).find((a) => a.documentId === id);
    if (admin) return { documentId: admin.documentId, name: admin.name };
    const [row] = await this._workTimes(date, id);
    if (row) return { documentId: id, name: String(row.personal?.name ?? '').trim() };
    throw new SmenaError(400, 'bad_personal', 'Hodiny se zapisují jen administrátorkám', { field: 'personal' });
  },

  async _workOf(target: any, date: string) {
    const rows = await this._workTimes(date, target.documentId);
    const doc = rows[0] || null;
    if (doc && (await this._published(WORK_UID, [doc.documentId])).has(doc.documentId)) {
      throw new SmenaError(409, 'shift_closed', 'Směna je uzavřená vedením — opravu udělá vedení');
    }
    return doc;
  },

  /**
   * PUT /smena/:date/work-time {startTime, endTime, comment, expectedUpdatedAt?, personal?} — свои часы;
   * руководство — часы администраторки `personal` (s266).
   */
  async saveWorkTime({ session, date: rawDate, body, now = new Date() }: { session: any; date: unknown; body: any; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const date = checkDate(rawDate, today, { write: true, management: who.management });
    const input = normalizeWorkInput(body);
    const target = await this._workTarget(who, date, body?.personal);
    const existing = await this._workOf(target, date);
    if (isStale(body, existing)) throw new SmenaError(409, 'stale', 'Hodiny se mezitím změnily — načtěte je znovu');
    const before = workTimeView(existing, false);
    if (before && before.startTime === input.startTime && before.endTime === input.endTime && before.comment === htmlToText(textToHtml(input.comment))) {
      return this.day({ session, date, now });
    }
    const data = { date, startTime: input.startTime, endTime: input.endTime, sum: input.hours, comment: textToHtml(input.comment) };
    const saved = existing
      ? await strapi.documents(WORK_UID).update({ documentId: existing.documentId, status: 'draft', data })
      : await strapi.documents(WORK_UID).create({ data: { ...data, personal: target.documentId } });
    if (!existing) {
      const all = await this._workTimes(date, target.documentId);
      if (all.length > 1 && all[0].documentId !== saved.documentId) {
        await strapi.documents(WORK_UID).delete({ documentId: saved.documentId });
        throw new SmenaError(409, 'stale', 'Hodiny za tento den už jsou uložené — načtěte je znovu');
      }
    }
    const details: any = { datum: fmtDay(date), od: input.startTime, do: input.endTime, hodin: input.hours };
    if (before) Object.assign(details, { předtím: `${before.startTime}–${before.endTime}` });
    if (who.management) details.zapsalo = 'vedení';
    this._log(
      existing ? 'smena_worktime_update' : 'smena_worktime_create',
      session,
      saved.documentId,
      target.name,
      `${existing ? 'Hodiny upraveny' : 'Hodiny zapsány'} ${fmtDay(date)}: ${input.startTime}–${input.endTime} (${String(input.hours).replace('.', ',')} h)${who.management ? ` — ${target.name}` : ''}`,
      details
    );
    return this.day({ session, date, now });
  },

  /** DELETE /smena/:date/work-time[?personal=] — своя запись (руководство — администраторки), только черновик. */
  async deleteWorkTime({ session, date: rawDate, personal, now = new Date() }: { session: any; date: unknown; personal?: unknown; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const date = checkDate(rawDate, today, { write: true, management: who.management });
    const target = await this._workTarget(who, date, personal);
    const existing = await this._workOf(target, date);
    if (!existing) throw new SmenaError(404, 'not_found', 'Hodiny za tento den nejsou uložené');
    await strapi.documents(WORK_UID).delete({ documentId: existing.documentId });
    const details: any = { datum: fmtDay(date), od: existing.startTime, do: existing.endTime };
    if (who.management) details.zapsalo = 'vedení';
    this._log(
      'smena_worktime_delete',
      session,
      existing.documentId,
      target.name,
      `Hodiny smazány ${fmtDay(date)}: ${existing.startTime}–${existing.endTime}${who.management ? ` — ${target.name}` : ''}`,
      details
    );
    return this.day({ session, date, now });
  },

  /**
   * GET /smena/:date/summary — руководству для «Uzavření směny» (§0б.4): по администраторам дня
   * часы и задачи, отмеченные «hotovo» в этот день; касса дня. Только чтение.
   */
  async summary({ date: rawDate, now = new Date() }: { date: unknown; now?: Date }) {
    const today = this._today(now);
    const date = checkDate(rawDate, today, { write: false, management: true });
    const [cashes, works, done, admins, handovers] = await Promise.all([
      this._cashesOfDay(date),
      this._workTimes(date),
      this._tasksDone(date, null),
      findWorkingAdmins(strapi),
      // s265: сообщения передачи смены этого дня — руководству в «Uzavření směny»
      strapi.documents(HANDOVER_UID).findMany({ filters: { date: { $eq: date } }, sort: [{ createdAt: 'asc' }], limit: 50 }).catch((e) => {
        strapi.log.error(`smena: summary handovers ${date} failed: ${e?.message || e}`);
        return [];
      }),
    ]);
    const cashDoc = cashes[0] || null;
    const [cashPub, workPub] = await Promise.all([this._published(CASH_UID, cashDoc ? [cashDoc.documentId] : []), this._published(WORK_UID, works.map((w) => w.documentId))]);
    const byLogin = new Map(admins.map((a) => [a.login.toLowerCase(), a]));
    const people = new Map();
    const at = (documentId: string | null, name: string) => {
      const key = documentId || `name:${name}`;
      if (!people.has(key)) people.set(key, { documentId, name, workTime: null, tasksDone: [] });
      return people.get(key);
    };
    for (const w of works) at(w.personal?.documentId || null, w.personal?.name || '').workTime = workTimeView(w, workPub.has(w.documentId));
    for (const t of done) {
      const a = byLogin.get(t.by.toLowerCase());
      at(a?.documentId || null, a?.name || t.by).tasksDone.push(t);
    }
    const tasks = await this._tasksById(handovers);
    // s266: вложения задач — руководству рядом с текстом (открываются ручкой задач, она проверяет доступ)
    const files = await this._taskFiles(done.map((t) => t.documentId));
    for (const p of people.values()) for (const t of p.tasksDone) t.files = files.get(t.documentId) || [];
    return {
      date,
      cash: cashView(cashDoc, cashDoc ? cashPub.has(cashDoc.documentId) : false),
      people: [...people.values()].sort((x, y) => x.name.localeCompare(y.name, 'cs')),
      handovers: handovers.map((h) => handoverView(h, tasks)),
    };
  },

  async _taskFiles(ids: string[]) {
    const out = new Map<string, any[]>();
    if (!ids.length) return out;
    try {
      const svc = strapi.service('api::booking-engine.owner-tasks');
      for (const [id, list] of await svc._filesFor(ids)) out.set(id, list.map(fileOut));
    } catch (e) {
      strapi.log.error(`smena: task files failed: ${e?.message || e}`);
    }
    return out;
  },

  // ── Фаза 3 (s266) ──────────────────────────────────────────────────────────

  /**
   * GET /smena/:date/check — «Kontrola směny» (порт виджета панели Strapi): платежи с неверными
   * суммами, клиенты без записи, записи без брони, услуга ≠ календарь, нет кассы/часов/услуг.
   * Тот же `shift-selfcheck.runSelfCheck` (одна логика на панель и админку). Окно — как у дня.
   */
  async check({ session, date: rawDate, now = new Date() }: { session: any; date: unknown; now?: Date }) {
    const who = await this._who(session);
    const date = checkDate(rawDate, this._today(now), { write: false, management: who.management });
    return strapi.service('api::shift-selfcheck.shift-selfcheck').runSelfCheck(date);
  },

  /** Брони по дням (салон работал) — число броней в статусах WORKING_BOOKING_STATUSES. */
  async _visitsByDay(from: string, to: string) {
    const rows = await strapi.db
      .connection('bookings')
      .where('date', '>=', from)
      .where('date', '<=', to)
      .whereIn('status', WORKING_BOOKING_STATUSES)
      .select(strapi.db.connection.raw("to_char(date,'YYYY-MM-DD') as date"), strapi.db.connection.raw('count(*) as n'))
      .groupByRaw("to_char(date,'YYYY-MM-DD')");
    return new Map(rows.map((r) => [String(r.date), Number(r.n) || 0]));
  },

  /** Дежурные по графику `shift` на дни диапазона (свободный текст; пусто — не указан). */
  async _dutyByDay(dates: string[]) {
    const mondays = [...new Set(dates.map(mondayOf))];
    const weeks = await strapi.documents(SHIFT_UID).findMany({ status: 'draft', filters: { from: { $in: mondays } }, fields: ['from'], populate: { days: true }, limit: mondays.length + 5 });
    const byMonday = new Map(weeks.map((w) => [String(w.from).slice(0, 10), w.days || {}]));
    return new Map(dates.map((d) => [d, dutyOn(byMonday, d)]));
  },

  /**
   * Незаполненные дни (§5.3) в [from, to]. Сбой графика не валит ответ — тогда «работал» только
   * по броням. Касса/часы — любая запись дня (черновик или закрытая).
   */
  async _missing(from: string, to: string) {
    const dates = [];
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) dates.push(d);
    const [visits, duty, cashes, works] = await Promise.all([
      this._visitsByDay(from, to),
      this._dutyByDay(dates).catch((e) => {
        strapi.log.error(`smena: roster ${from}…${to} failed: ${e?.message || e}`);
        return new Map();
      }),
      strapi.documents(CASH_UID).findMany({ status: 'draft', filters: { date: { $gte: from, $lte: to } }, fields: ['date'], limit: 200 }),
      strapi.documents(WORK_UID).findMany({ status: 'draft', filters: { date: { $gte: from, $lte: to } }, fields: ['date'], populate: { personal: { fields: ['name'] } }, limit: 500 }),
    ]);
    return {
      missing: missingDays(dates, { visits, duty, cashDates: new Set(cashes.map((c) => c.date)), workDates: new Set(works.map((w) => w.date)) }),
      works,
    };
  },

  /** Дайджест 08:00 (s266): вчерашняя смена не заполнена → `{date, cash, workTime}`, иначе null. */
  async missingOn({ date }: { date: string }) {
    const { missing } = await this._missing(date, date);
    return missing[0] || null;
  },

  /**
   * GET /smena/attention — руководству на «Сегодня» (s266): незаполненные смены за ATTENTION_DAYS
   * дней до вчера, расхождения кассы в незакрытых сменах, непрочитанные передачи старше
   * HANDOVER_STALE_DAYS дней. Каждый источник отдельно — сбой одного не гасит остальные.
   */
  async attention({ now = new Date() }: { now?: Date } = {}) {
    const today = this._today(now);
    const settle = async (name: string, fn: () => Promise<any>, fallback: any) => {
      try {
        return await fn();
      } catch (e) {
        strapi.log.error(`smena: attention ${name} failed: ${e?.message || e}`);
        return fallback;
      }
    };
    const [missing, discrepancies, handoversUnread] = await Promise.all([
      settle('missing', async () => (await this._missing(addDaysYmd(today, -ATTENTION_DAYS), addDaysYmd(today, -1))).missing, null),
      settle('discrepancies', () => this._discrepancies(today), null),
      settle(
        'handovers',
        async () =>
          staleHandoversOf(
            await strapi.documents(HANDOVER_UID).findMany({
              filters: { readAt: { $null: true }, date: { $gte: addDaysYmd(today, -HANDOVER_STALE_MAX_DAYS), $lte: addDaysYmd(today, -HANDOVER_STALE_DAYS) } },
              sort: [{ date: 'asc' }],
              limit: 50,
            }),
            today
          ),
        null
      ),
    ]);
    return { today, missing, discrepancies, handoversUnread };
  },

  async _discrepancies(today: string) {
    const cashes = await strapi.documents(CASH_UID).findMany({
      status: 'draft',
      filters: { date: { $gte: addDaysYmd(today, -DISCREPANCY_DAYS), $lte: today } },
      fields: ['date'],
      populate: { flow: { fields: ['sum', 'coment'] }, personal: { fields: ['name'] } },
      limit: 100,
    });
    const withLine = cashes.filter((c) => (c.flow || []).some((f) => isReservedComment(f?.coment)));
    if (!withLine.length) return [];
    const ids = withLine.map((c) => c.documentId);
    const [published, logs] = await Promise.all([
      this._published(CASH_UID, ids),
      strapi.db
        .query(LOG_UID)
        .findMany({ where: { entityType: 'smena', action: 'smena_cash_discrepancy', entityDocId: { $in: ids } }, select: ['entityDocId', 'actorName'], orderBy: { createdAt: 'asc' }, limit: 200 })
        .catch(() => []),
    ]);
    // последняя запись журнала по кассе — кто записал расхождение
    const actors = new Map(logs.map((l) => [l.entityDocId, l.actorName || '']));
    return discrepanciesOf(withLine, published, actors);
  },

  /**
   * Кроны (§7, env `SMENA_PUSH_ENABLED`): вечер 20:30 — за сегодня, утро 09:30 — за вчера. Кому:
   * если часы дня уже записала какая-то администраторка — ей (она на смене), иначе всем
   * администраторкам (кто дежурил — по графику не сопоставить: там прозвища кириллицей). Утром —
   * ещё управляющей и владельцу. День не рабочий или всё заполнено — молчим.
   */
  async remind({ kind, now = new Date() }: { kind: 'evening' | 'morning'; now?: Date }) {
    if (!pushEnabled()) return { skipped: 'disabled' };
    const today = this._today(now);
    const date = kind === 'evening' ? today : addDaysYmd(today, -1);
    const { missing, works } = await this._missing(date, date);
    const m = missing[0];
    if (!m) return { date, due: false };
    const p = reminderPayloads(kind, m);
    const n = strapi.service('api::booking-engine.manager-notify');
    const onShift = [...new Map(works.filter((w) => w.personal?.documentId).map((w) => [w.personal.documentId, { documentId: w.personal.documentId, name: w.personal.name || '' }])).values()];
    const sent = [];
    if (onShift.length) for (const person of onShift) sent.push(await n.toAdmin(person, p.admin, `smena_reminder_${kind}`));
    else sent.push(await n.toAdmins(p.admin, `smena_reminder_${kind}`));
    if (kind === 'morning') {
      sent.push(await n.toManagers(p.manager, 'smena_reminder_morning'));
      sent.push(await n.toOwner(p.owner, 'smena_reminder_morning'));
    }
    return { date, due: true, cash: m.cash, workTime: m.workTime, admins: onShift.length || 'all', sent: sent.reduce((a, r) => a + (Number(r?.sent) || 0), 0) };
  },
};
