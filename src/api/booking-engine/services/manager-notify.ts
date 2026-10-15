// @ts-nocheck
/**
 * Push управляющей и владельцу (s247, Фаза 3 плана MANAGER_UX_NEXT_SESSION_PROMPT.md — §5, §6а;
 * решения владельца §0.6–§0.10).
 *
 * Управляющей (тексты чешские): новое поручение владельца, «Vrátit do práce», владелец выполнил её
 * задачу; напоминание о výkazu (21:00 за сегодня, 09:00 за вчера); блоки/предложения графика,
 * которые ждут подтверждения дольше 6 ч (один раз на блок/серию), и ежедневная сводка 10:00 про
 * всё, что висит дольше суток.
 * Владельцу (тексты русские): výkaz отправлен (первая подача), поручение отмечено «hotovo»,
 * управляющая поставила ему задачу.
 * Без push: задача самой себе, комментарии, `undone`, правка отчёта, «volno».
 * s262 — администраторам (чешский): новая задача, «Vrátit do práce» (конкретной — её устройствам,
 * общей — всем работающим администраторам по логинам); их «hotovo» — постановщику (владельцу —
 * по-русски, управляющей — по-чешски).
 * s265 — задачи администраторки коллеге: новая — коллеге, «hotovo» — автору (`author`: её карточка
 * по логину учётки); передача задачи (`handover`) — получательнице и постановщику (если передал не он).
 *
 * Получатели: управляющая — устройства её карточки (`push-notify._subsFor`); владелец — подписки
 * без карточки с `employeeName` = логин учётки роли owner (у владельца карточки нет).
 * События из других сервисов — fire-and-forget (сбой пуша не роняет поручение/отчёт); гейт —
 * VAPID в push-notify. Кроны дополнительно включаются env `MANAGER_PUSH_ENABLED=true`.
 *
 * Идемпотентность «> 6 ч»: отметка `time-block.pendingPushAt` (действует, если не раньше начала
 * ожидания — `createdAt` у нового блока, `proposedAt` у предложения правки) и
 * `master-schedule.requestPushes[date] = at` предложения (новое предложение на ту же дату имеет
 * другой `at` — отметка перестаёт действовать). Отметку для предложений графика держим в отдельной
 * колонке, а не внутри `requests`: запись крона не должна затирать предложение, сохранённое
 * администратором между чтением и записью.
 *
 * Верх файла — чистые функции (tests/manager-notify.test.mjs), ниже — сервис.
 */

import { minToHHMM, pragueDateOf } from './slots-core';

const TIME_BLOCK_UID = 'api::time-block.time-block';
const SCHEDULE_UID = 'api::master-schedule.master-schedule';
const PERSONAL_UID = 'api::personal.personal';
const ADMIN_UID = 'api::admin-user.admin-user';

/** Через сколько часов ожидания блок попадает в push и в ежедневную сводку. */
export const AGING_HOURS = 6;
export const DAILY_HOURS = 24;
/** Строк в теле push (iOS на закрытом экране показывает ~4). */
export const MAX_BODY_LINES = 4;

const H = 3600_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const cut = (s: unknown, n: number): string => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/** 'YYYY-MM-DD' → 'dd.mm.' */
export const ddmm = (ymd: unknown): string => {
  const s = String(ymd ?? '');
  return YMD.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.` : '';
};

const ms = (v: unknown): number | null => {
  if (!v) return null;
  const t = new Date(v as any).getTime();
  return Number.isFinite(t) ? t : null;
};

const range = (a: unknown, b: unknown) =>
  Number.isFinite(a) && Number.isFinite(b) ? `${minToHHMM(Number(a))}–${minToHHMM(Number(b))}` : '';

const fmtHours = (h: unknown): string => {
  const n = Number(h);
  return Number.isFinite(n) ? String(n).replace('.', ',') : '—';
};

/** Склонение чешского «položka». */
const polozek = (n: number) => (n === 1 ? 'položka' : n >= 2 && n <= 4 ? 'položky' : 'položek');

// ── поручения ────────────────────────────────────────────────────────────────

const side = (v: unknown, dflt: string, allowed: string[]) => (allowed.includes(v as string) ? (v as string) : dflt);
const taskSides = (task: any) => ({
  assignee: side(task?.assignee, 'manager', ['owner', 'manager', 'administrator']),
  creator: side(task?.createdByRole, 'owner', ['owner', 'manager', 'administrator']),
});
const sameLogin = (a: unknown, b: unknown) => !!String(a ?? '').trim() && String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

const taskBody = (task: any, text: unknown) => [cut(task?.title, 120), cut(text, 200)].filter(Boolean).join('\n');
const dueCs = (task: any) => (task?.dueDate ? ` · do ${ddmm(task.dueDate)}` : '');
const dueRu = (task: any) => (task?.dueDate ? ` · до ${ddmm(task.dueDate)}` : '');
const toVykaz = (task: any) => `/vykaz?task=${encodeURIComponent(task.documentId)}`;
const toTeam = (task: any) => `/global/team/tasks?task=${encodeURIComponent(task.documentId)}`;
const toVykazTasks = (task: any) => `/vykaz?tab=ukoly&task=${encodeURIComponent(task.documentId)}`;
const toAdminTasks = (task: any) => `/ukoly?task=${encodeURIComponent(task.documentId)}`;
/** s262: кому из администраторов — конкретной (по карточке) или всем (общая задача). */
const adminTarget = (task: any) => (task?.personal?.documentId ? 'admin' : 'admins');
const tagOf = (task: any) => `task-${task.documentId}`;

/**
 * Кому и что отправить по событию поручения. `kind` — `created` или действие (`done`, `reopen`, …),
 * `role` — кто сделал. null — без push.
 *   • владелец поставил поручение → управляющей «📋 Nový úkol od majitele»;
 *   • управляющая поставила задачу владельцу → владельцу «📥 Задача от управляющей»;
 *   • владелец вернул её задачу в работу → управляющей «↩️ Úkol vrácen do práce»;
 *   • управляющая отметила «hotovo» поручение владельца → владельцу «✅ Поручение выполнено»;
 *   • владелец отметил «hotovo» её задачу ему → управляющей «✅ Majitel splnil váš úkol».
 */
export const taskPushFor = (task: any, { kind, role, text = '', by = '' }: { kind: string; role: string; text?: unknown; by?: string }) => {
  if (!task?.documentId) return null;
  const { assignee, creator } = taskSides(task);
  if (assignee === 'administrator') {
    if (kind === 'created') {
      return {
        to: adminTarget(task),
        kind: 'task_admin_created',
        payload: {
          title:
            creator === 'owner'
              ? '📋 Nový úkol od majitele'
              : creator === 'manager'
                ? '📋 Nový úkol od manažerky'
                : `📋 Úkol od kolegyně${task.createdByName ? ` ${cut(task.createdByName, 40)}` : ''}`,
          body: `${cut(task.title, 120)}${dueCs(task)}${task.priority === 'urgent' ? ' · urgentní' : ''}`,
          url: toAdminTasks(task),
          tag: tagOf(task),
        },
      };
    }
    if (kind === 'reopen' && role === creator) {
      return { to: adminTarget(task), kind: 'task_admin_reopened', payload: { title: '↩️ Úkol vrácen do práce', body: taskBody(task, text), url: toAdminTasks(task), tag: tagOf(task) } };
    }
    if (kind === 'done' && role === 'administrator') {
      // s265: задача от коллеги — автору (закрыта сразу, принимать нечего); сделала сама — молчим
      if (creator === 'administrator') {
        return sameLogin(by, task.createdByName)
          ? null
          : { to: 'author', kind: 'task_admin_done', payload: { title: `✅ ${cut(by, 40) || 'Kolegyně'} splnila váš úkol`, body: taskBody(task, text), url: toAdminTasks(task), tag: tagOf(task) } };
      }
      return creator === 'owner'
        ? { to: 'owner', kind: 'task_admin_done', payload: { title: '✅ Задача администратора выполнена — ждёт принятия', body: taskBody(task, text), url: toTeam(task), tag: tagOf(task) } }
        : { to: 'managers', kind: 'task_admin_done', payload: { title: '✅ Administrátorka splnila úkol — čeká na převzetí', body: taskBody(task, text), url: toVykazTasks(task), tag: tagOf(task) } };
    }
    return null;
  }
  if (kind === 'created') {
    if (creator === 'owner' && assignee === 'manager') {
      return {
        to: 'manager',
        kind: 'task_created',
        payload: {
          title: '📋 Nový úkol od majitele',
          body: `${cut(task.title, 120)}${dueCs(task)}${task.priority === 'urgent' ? ' · urgentní' : ''}`,
          url: toVykaz(task),
          tag: tagOf(task),
        },
      };
    }
    if (creator === 'manager' && assignee === 'owner') {
      return {
        to: 'owner',
        kind: 'task_for_owner',
        payload: {
          title: '📥 Задача от управляющей',
          body: `${cut(task.title, 120)}${dueRu(task)}${task.priority === 'urgent' ? ' · срочно' : ''}`,
          url: toTeam(task),
          tag: tagOf(task),
        },
      };
    }
    return null;
  }
  if (kind === 'reopen' && role === 'owner' && assignee === 'manager') {
    return { to: 'manager', kind: 'task_reopened', payload: { title: '↩️ Úkol vrácen do práce', body: taskBody(task, text), url: toVykaz(task), tag: tagOf(task) } };
  }
  if (kind === 'done' && role === 'manager' && assignee === 'manager' && creator === 'owner') {
    return {
      to: 'owner',
      kind: 'task_done',
      payload: { title: '✅ Поручение выполнено — ждёт принятия', body: taskBody(task, text), url: toTeam(task), tag: tagOf(task) },
    };
  }
  if (kind === 'done' && role === 'owner' && assignee === 'owner' && creator === 'manager') {
    return { to: 'manager', kind: 'task_owner_done', payload: { title: '✅ Majitel splnil váš úkol', body: taskBody(task, text), url: toVykaz(task), tag: tagOf(task) } };
  }
  return null;
};

/**
 * s265: все push по событию задачи. Передача (`handover`) — двум сторонам: получательнице
 * (`side: 'assignee'`) и постановщику, если передал не он сам; остальное — `taskPushFor`.
 * `quiet: 'assignee'` — получательнице не слать (передача смены шлёт ей одну сводку).
 */
export const taskPushesFor = (
  task: any,
  event: { kind: string; role: string; text?: unknown; by?: string; from?: string; quiet?: string }
): Array<{ to: string; kind: string; side?: string; payload: any }> => {
  if (!task?.documentId) return [];
  let plans: any[];
  if (event.kind === 'handover') {
    const { creator } = taskSides(task);
    const who = cut(event.by, 40);
    const route = `${cut(event.from, 40) || '—'} → ${cut(task.personal?.name, 40) || '—'}`;
    plans = [
      {
        to: 'admin',
        side: 'assignee',
        kind: 'task_handover_in',
        payload: { title: `📥 Předaný úkol${who ? ` od ${who}` : ''}`, body: taskBody(task, event.text), url: toAdminTasks(task), tag: tagOf(task) },
      },
    ];
    const creatorActed = creator === 'administrator' ? sameLogin(event.by, task.createdByName) : event.role === creator;
    if (!creatorActed) {
      const body = [cut(task.title, 120), route, cut(event.text, 160)].filter(Boolean).join('\n');
      if (creator === 'owner') plans.push({ to: 'owner', kind: 'task_handover', payload: { title: '🔁 Задачу администратора передали', body, url: toTeam(task), tag: tagOf(task) } });
      else if (creator === 'manager') plans.push({ to: 'managers', kind: 'task_handover', payload: { title: '🔁 Úkol předán kolegyni', body, url: toVykazTasks(task), tag: tagOf(task) } });
      else plans.push({ to: 'author', kind: 'task_handover', payload: { title: '🔁 Váš úkol byl předán', body, url: toAdminTasks(task), tag: tagOf(task) } });
    }
  } else {
    const one = taskPushFor(task, event);
    plans = one ? [{ ...one, ...(one.to === 'admin' || one.to === 'admins' ? { side: 'assignee' } : {}) }] : [];
  }
  return event.quiet === 'assignee' ? plans.filter((p) => p.side !== 'assignee') : plans;
};

// ── výkaz ────────────────────────────────────────────────────────────────────

/** Владельцу: управляющая впервые отправила výkaz за день. */
export const reportSubmittedPayload = ({
  name,
  personal,
  date,
  hours,
  items,
  needsOwner,
}: {
  name: string;
  personal: string;
  date: string;
  hours: unknown;
  items: number;
  needsOwner?: string;
}) => ({
  title: '📝 Výkaz отправлен',
  body: `${cut(name, 60) || 'Управляющая'} · ${ddmm(date)} · ${fmtHours(hours)} ч · пунктов ${items}${needsOwner ? '\n❓ Нужно ваше решение' : ''}`,
  url: `/global/team/reports?personal=${encodeURIComponent(personal)}&date=${date}`,
  tag: `report-${personal}-${date}`,
});

/** Управляющей: výkaz за день ещё не отправлен (`evening` — за сегодня в 21:00, `morning` — за вчера в 09:00). */
export const reportReminderPayload = (kind: 'evening' | 'morning', date: string) =>
  kind === 'evening'
    ? { title: '📝 Výkaz za dnešek', body: 'Ještě není odeslán — do 10:00 zítra je včas.', url: '/vykaz', tag: `vykaz-${date}` }
    : { title: '⏰ Výkaz za včerejšek', body: 'Do 10:00 je ještě včas.', url: `/vykaz?date=${date}`, tag: `vykaz-${date}` };

// ── блоки и предложения графика ke schválení ─────────────────────────────────

/**
 * Ожидающее подтверждения → группы для push: серия блоков = одна группа (`seriesKey`),
 * предложение правки блока — своя, предложение графика — по мастеру и дате.
 * `items`/`planRequests` — ответ `booking-engine.adminPendingBlocks()` (+ `pushedAt`, `proposedAt`).
 * `since` — с какого момента ждёт; `marked` — push по группе уже был (отметка не старше ожидания).
 */
export const pendingGroups = (items: any[] = [], planRequests: any[] = []) => {
  const groups = new Map<string, any>();
  for (const it of items) {
    const kind = it.kind === 'change' ? 'change' : 'block';
    const key = `${kind}|${it.seriesKey || it.documentId}`;
    const since = ms(kind === 'change' ? it.proposedAt || it.createdAt : it.createdAt);
    const marked = (() => {
      const p = ms(it.pushedAt);
      return p != null && since != null && p >= since;
    })();
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        key,
        kind,
        employeeName: it.employeeName || '',
        date: it.date,
        startMin: kind === 'change' ? it.proposedStartMin : it.startMin,
        endMin: kind === 'change' ? it.proposedEndMin : it.endMin,
        by: (kind === 'change' ? it.proposedByName : it.createdByName) || '',
        since,
        marked,
        count: 1,
        docIds: [it.documentId],
      });
    } else {
      g.count += 1;
      g.docIds.push(it.documentId);
      if (it.date < g.date) g.date = it.date;
      if (since != null && (g.since == null || since < g.since)) g.since = since;
      g.marked = g.marked && marked;
    }
  }
  for (const r of planRequests) {
    if (!r?.personal || !r?.date) continue;
    groups.set(`plan|${r.personal}|${r.date}`, {
      key: `plan|${r.personal}|${r.date}`,
      kind: 'plan',
      employeeName: r.employeeName || '',
      date: r.date,
      label: r.label || '',
      by: r.by || '',
      since: ms(r.at),
      marked: !!r.pushedAt && r.pushedAt === r.at,
      count: 1,
      plan: { personal: r.personal, date: r.date, at: r.at || null },
    });
  }
  return [...groups.values()].sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || String(a.date).localeCompare(String(b.date)));
};

/** Группы, ждущие не меньше `hours` часов; `ignoreMarks` — для ежедневной сводки. */
export const agingPending = (groups: any[], now: Date, hours: number, { ignoreMarks = false } = {}) => {
  const edge = now.getTime() - hours * H;
  return groups.filter((g) => g.since != null && g.since <= edge && (ignoreMarks || !g.marked));
};

const groupLine = (g: any) => {
  const who = cut(g.employeeName, 40) || '—';
  if (g.kind === 'plan') return `${who} · ${ddmm(g.date)} graf: ${cut(g.label, 40)}`;
  if (g.kind === 'change') return `${who} · ${ddmm(g.date)} změna → ${range(g.startMin, g.endMin)}`;
  return `${who} · ${ddmm(g.date)}${g.count > 1 ? ` (${g.count}×)` : ''} ${range(g.startMin, g.endMin)}`.trim();
};

const listLines = (groups: any[]) => {
  if (groups.length <= MAX_BODY_LINES) return groups.map(groupLine);
  return [...groups.slice(0, MAX_BODY_LINES - 1).map(groupLine), `… a další ${groups.length - (MAX_BODY_LINES - 1)}`];
};

const firstDate = (groups: any[]) => groups.map((g) => g.date).filter(Boolean).sort()[0] || '';

/** Управляющей: что ждёт подтверждения дольше AGING_HOURS (только новые для push группы). */
export const blockAgingPayload = (groups: any[], now: Date) => {
  const oldest = Math.min(...groups.map((g) => g.since));
  const hours = Math.max(AGING_HOURS, Math.floor((now.getTime() - oldest) / H));
  const date = firstDate(groups);
  if (groups.length === 1) {
    const g = groups[0];
    const what = g.kind === 'plan' ? 'Návrh grafu' : g.kind === 'change' ? 'Změna bloku' : 'Blok';
    return {
      title: `🔒 ${what} ke schválení čeká ${hours} h`,
      body: [groupLine(g), g.by ? `zadal/a ${cut(g.by, 40)}` : ''].filter(Boolean).join('\n'),
      url: `/calendar?date=${date}&pending=1`,
      tag: `block-${g.key}`,
    };
  }
  return {
    title: `🔒 Ke schválení čeká ${groups.length} ${polozek(groups.length)} · nejdéle ${hours} h`,
    body: listLines(groups).join('\n'),
    url: `/calendar?date=${date}&pending=1`,
    tag: 'blocks-aging',
  };
};

/** Управляющей, ежедневно 10:00: всё, что ждёт дольше суток. */
export const pendingBlocksPayload = (groups: any[]) => {
  const oldest = groups.reduce((a, g) => (a == null || g.since < a.since ? g : a), null);
  const names = [...new Set(groups.map((g) => cut(g.employeeName, 30)).filter(Boolean))];
  const shown = names.slice(0, 3).join(', ');
  return {
    title: `🟡 Ke schválení: ${groups.length} ${polozek(groups.length)}`,
    body: `Nejstarší čeká od ${ddmm(pragueDateOf(new Date(oldest.since)))}${shown ? ` · ${shown}${names.length > 3 ? ', …' : ''}` : ''}`,
    url: '/calendar?pending=1',
    tag: 'blocks-pending',
  };
};

// ── сервис ───────────────────────────────────────────────────────────────────

export default {
  _push() {
    return strapi.service('api::booking-engine.push-notify');
  },

  _logSent(kind: string, res: any) {
    if (res?.skipped) return;
    strapi.log.info(`manager-notify: ${kind} → ${res?.sent ?? 0} device(s)`);
  },

  /** Работающие управляющие (карточки `position='manager'`). */
  async _managers() {
    const rows = await strapi.documents(PERSONAL_UID).findMany({
      status: 'draft',
      filters: { position: { $eq: 'manager' } },
      fields: ['name', 'isActive'],
      limit: 50,
    });
    return rows.filter((p) => p.isActive !== false).map((p) => ({ documentId: p.documentId, name: String(p.name ?? '').trim() }));
  },

  /** s262: работающие учётки администраторов (логин + связь с карточкой). */
  async _adminAccounts() {
    const rows = await strapi.documents(ADMIN_UID).findMany({ filters: { role: { $eq: 'administrator' } }, fields: ['username', 'isActive', 'personalDocId'], limit: 50 });
    return rows.filter((a) => a.isActive !== false && String(a.username ?? '').trim());
  },

  /** Всем администраторам — по логинам (как склад, stock-notify.toAdmins). */
  async toAdmins(payload: any, kind: string) {
    const res = await this._push().notifyByNames((await this._adminAccounts()).map((a) => String(a.username).trim()), payload);
    this._logSent(kind, res);
    return res;
  },

  /** Конкретной администраторке: устройства карточки, иначе подписки её логина. */
  async toAdmin(person: { documentId: string; name?: string }, payload: any, kind: string) {
    const acc = (await this._adminAccounts()).find((a) => String(a.personalDocId ?? '').trim() === person.documentId);
    const res = await this._push().notifyPersonal({ personalDocId: person.documentId, employeeName: acc ? String(acc.username).trim() : person.name || '' }, payload);
    this._logSent(kind, res);
    return res;
  },

  /** Логины владельца (подписки владельца — с `employeeName` = логин, без карточки). */
  async _ownerNames() {
    const rows = await strapi.documents(ADMIN_UID).findMany({ filters: { role: { $eq: 'owner' } }, fields: ['username', 'isActive'], limit: 20 });
    return rows.filter((a) => a.isActive !== false).map((a) => String(a.username ?? '').trim()).filter(Boolean);
  },

  async toManager(person: { documentId: string; name?: string }, payload: any, kind: string) {
    const res = await this._push().notifyPersonal({ personalDocId: person.documentId, employeeName: person.name || '' }, payload);
    this._logSent(kind, res);
    return res;
  },

  async toManagers(payload: any, kind: string) {
    let sent = 0;
    for (const m of await this._managers()) {
      const res = await this._push().notifyPersonal({ personalDocId: m.documentId, employeeName: m.name }, payload);
      if (res?.skipped) return { skipped: res.skipped };
      sent += res?.sent || 0;
    }
    this._logSent(kind, { sent });
    return { sent };
  },

  async toOwner(payload: any, kind: string) {
    const res = await this._push().notifyByNames(await this._ownerNames(), payload, { withoutCard: true });
    this._logSent(kind, res);
    return res;
  },

  /** Событие поручения (create / действие): кому слать — решает `taskPushesFor` (s265: и несколько адресатов). */
  async taskEvent(task: any, event: { kind: string; role: string; text?: unknown; by?: string; from?: string; quiet?: string }) {
    const plans = taskPushesFor(task, event);
    if (!plans.length) return { skipped: 'no_push' };
    let last = null;
    for (const plan of plans) last = await this._sendPlan(task, plan);
    return plans.length === 1 ? last : { sent: plans.length };
  },

  async _sendPlan(task: any, plan: any) {
    if (plan.to === 'owner') return this.toOwner(plan.payload, plan.kind);
    if (plan.to === 'managers') return this.toManagers(plan.payload, plan.kind);
    if (plan.to === 'admins') return this.toAdmins(plan.payload, plan.kind);
    if (plan.to === 'author') return this.toAdminLogin(task.createdByName, plan.payload, plan.kind);
    if (!task.personal?.documentId) return { skipped: 'no_card' };
    if (plan.to === 'admin') return this.toAdmin(task.personal, plan.payload, plan.kind);
    return this.toManager(task.personal, plan.payload, plan.kind);
  },

  /** s265: администраторке по логину учётки (автор задачи коллеге): её карточка, иначе подписки логина. */
  async toAdminLogin(login: unknown, payload: any, kind: string) {
    const name = String(login ?? '').trim();
    if (!name) return { skipped: 'no_login' };
    const acc = (await this._adminAccounts()).find((a) => sameLogin(a.username, name));
    const personalDocId = String(acc?.personalDocId ?? '').trim();
    const res = personalDocId
      ? await this._push().notifyPersonal({ personalDocId, employeeName: String(acc.username).trim() }, payload)
      : await this._push().notifyByNames([name], payload);
    this._logSent(kind, res);
    return res;
  },

  /** Первая подача výkazu — владельцу. `content` — содержимое отчёта (contentOf). */
  async reportSubmitted({ person, date, content }: { person: { documentId: string; name?: string }; date: string; content: any }) {
    const payload = reportSubmittedPayload({
      name: person.name || '',
      personal: person.documentId,
      date,
      hours: content?.hours,
      items: Array.isArray(content?.items) ? content.items.length : 0,
      needsOwner: content?.needsOwner || '',
    });
    return this.toOwner(payload, 'report_submitted');
  },

  /** Кроны 21:00 (за сегодня) и 09:00 (за вчера): кому из управляющих výkaz ещё «можно вовремя». */
  async remindReports({ now = new Date(), kind }: { now?: Date; kind: 'evening' | 'morning' }) {
    const today = pragueDateOf(now);
    // вчера — от пражского полудня сегодня (переход часов не сдвигает дату)
    const date = kind === 'evening' ? today : new Date(new Date(`${today}T12:00:00Z`).getTime() - 24 * H).toISOString().slice(0, 10);
    const targets = await strapi.service('api::booking-engine.work-reports').reminderTargets({ date, now });
    let sent = 0;
    for (const p of targets) {
      const res = await this.toManager(p, reportReminderPayload(kind, date), `report_reminder_${kind}`);
      if (res?.skipped) return { date, targets: targets.length, skipped: res.skipped };
      sent += res.sent || 0;
    }
    return { date, targets: targets.length, sent };
  },

  async _pendingGroups() {
    const { items = [], planRequests = [] } = await strapi.service('api::booking-engine.booking-engine').adminPendingBlocks();
    return pendingGroups(items, planRequests);
  },

  /** Отметить группы «push отправлен»: блоки — `pendingPushAt`, предложения графика — `requestPushes`. */
  async _mark(groups: any[], now: Date) {
    const ids = groups.flatMap((g) => g.docIds || []);
    if (ids.length) {
      await strapi.db.query(TIME_BLOCK_UID).updateMany({ where: { documentId: { $in: ids } }, data: { pendingPushAt: now } });
    }
    const byPerson = new Map<string, any[]>();
    for (const g of groups) {
      if (!g.plan) continue;
      if (!byPerson.has(g.plan.personal)) byPerson.set(g.plan.personal, []);
      byPerson.get(g.plan.personal).push(g.plan);
    }
    const today = pragueDateOf(now);
    for (const [personal, reqs] of byPerson) {
      const [doc] = await strapi.documents(SCHEDULE_UID).findMany({ filters: { personal: { documentId: { $eq: personal } } }, fields: ['requestPushes'], limit: 1 });
      if (!doc) continue;
      const prev = doc.requestPushes && typeof doc.requestPushes === 'object' ? doc.requestPushes : {};
      // прошедшие даты чистим — колонка не растёт
      const next = Object.fromEntries(Object.entries(prev).filter(([d]) => d >= today));
      for (const r of reqs) next[r.date] = r.at;
      await strapi.db.query(SCHEDULE_UID).updateMany({ where: { documentId: doc.documentId }, data: { requestPushes: next } });
    }
  },

  /** Крон каждый час: то, что ждёт подтверждения дольше AGING_HOURS и ещё не было в push. */
  async pushAgingBlocks({ now = new Date() }: { now?: Date } = {}) {
    const due = agingPending(await this._pendingGroups(), now, AGING_HOURS);
    if (!due.length) return { due: 0 };
    const res = await this.toManagers(blockAgingPayload(due, now), 'blocks_aging');
    if (res?.skipped) return { due: due.length, skipped: res.skipped };
    // отметка — и когда устройств нет: иначе после подписки придёт пачка давно разобранного
    await this._mark(due, now);
    return { due: due.length, sent: res.sent };
  },

  /** Крон 10:00: сводка про всё, что ждёт дольше суток (без отметок — раз в день и так). */
  async remindPendingBlocks({ now = new Date() }: { now?: Date } = {}) {
    const due = agingPending(await this._pendingGroups(), now, DAILY_HOURS, { ignoreMarks: true });
    if (!due.length) return { due: 0 };
    const res = await this.toManagers(pendingBlocksPayload(due), 'blocks_pending');
    return { due: due.length, ...res };
  },
};
