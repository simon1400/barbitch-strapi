// @ts-nocheck
/**
 * Поручения владельца управляющей (s240, «Výkaz práce» Фаза 3, решения владельца 02.10.2026 —
 * §11 плана MANAGER_REPORT_NEXT_SESSION_PROMPT.md).
 *
 * Кто что может:
 *   • владелец создаёт и правит поручение (название, описание, срок, приоритет), принимает
 *     сделанное, возвращает в работу, отменяет, комментирует;
 *   • исполнитель (роль из REPORT_ROLES — сейчас manager, карточка по сессии) видит СВОИ
 *     поручения, пишет о ходе работы, отмечает «hotovo», комментирует;
 *   • вложения (фото/PDF, закрытый каталог TASK_FILES_DIR) добавляют обе стороны;
 *     удалить — владелец любое, исполнитель только своё.
 *
 * Статусы: open → done (ждёт владельца) → accepted; из done/accepted/cancelled владелец
 * возвращает в open; open/done владелец отменяет (cancelled). Всё, что происходило, — в `events`
 * (одна лента: создано, правка, ход работы, hotovo, принято, возвращено, отменено, комментарии).
 * Ход работы и «hotovo» можно отметить и из формы ежедневного отчёта — событие несёт дату отчёта.
 *
 * Коллекции без REST-роутов (администраторам REST незакрытых коллекций открыт). Запись —
 * условным UPDATE по `version`. Журнал — calendar_logs, entityType `task`, только название.
 */

import { pragueDateOf } from './slots-core';
import { findSessionPersonal } from '../../../utils/staff-identity';
import {
  MAX_FILE_BYTES,
  contentDisposition,
  detectFile,
  openPrivateFile,
  privateDir,
  readHead,
  removePrivateFile,
  safeFileName,
  storePrivateFile,
} from '../../../utils/private-files';

export class TaskError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const TASK_UID = 'api::owner-task.owner-task';
export const TASK_FILE_UID = 'api::owner-task-file.owner-task-file';
const PERSONAL_UID = 'api::personal.personal';

/** Кому дают поручения — те же роли, что пишут výkaz. */
export const TASK_ROLES = ['manager'];
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 4000;
export const MAX_EVENT_TEXT = 2000;
export const MAX_EVENTS = 300;
export const MAX_FILES_PER_TASK = 10;
/** Заметок по поручениям в одном отчёте. */
export const MAX_REPORT_TASKS = 30;

export const PRIORITIES = { normal: 'Běžná', urgent: 'Urgentní' } as const;
export const STATUSES = {
  open: 'V práci',
  done: 'Hotovo — čeká na převzetí',
  accepted: 'Převzato',
  cancelled: 'Zrušeno',
} as const;

/** Что можно сделать: роль → действие → из каких статусов и в какой. */
export const TRANSITIONS = {
  manager: {
    done: { from: ['open'], to: 'done' },
    progress: { from: ['open'], to: null },
    comment: { from: ['open', 'done', 'accepted', 'cancelled'], to: null },
  },
  owner: {
    accept: { from: ['done'], to: 'accepted' },
    reopen: { from: ['done', 'accepted', 'cancelled'], to: 'open' },
    cancel: { from: ['open', 'done'], to: 'cancelled' },
    comment: { from: ['open', 'done', 'accepted', 'cancelled'], to: null },
  },
} as const;

/** Действия, где текст обязателен. */
const TEXT_REQUIRED = new Set(['progress', 'comment']);

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;
const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

export const isValidYmd = (s: unknown): boolean => {
  const v = String(s ?? '');
  if (!YMD.test(v)) return false;
  return new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
};

export const fmtDay = (ymd: unknown): string => {
  const s = String(ymd ?? '');
  return YMD.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '—';
};

const cut = (s: unknown, n: number) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

export const cleanText = (v: unknown, max: number, code: string): string => {
  if (v != null && typeof v !== 'string') throw new TaskError(400, code, 'Text má neplatný formát');
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.length > max) throw new TaskError(400, code, `Text je delší než ${max} znaků`);
  return s;
};

/**
 * Поля поручения от владельца. `partial` — правка: меняется только присланное.
 * Новый срок не может быть в прошлом; при правке старый срок можно оставить как есть.
 */
export const normalizeTaskInput = (body: any, { today, partial = false, current = null }: { today: string; partial?: boolean; current?: any }) => {
  const out: any = {};
  if (!partial || has(body, 'title')) {
    const title = cleanText(body?.title, MAX_TITLE, 'title_too_long').replace(/\s+/g, ' ');
    if (!title) throw new TaskError(400, 'title_required', 'Napište, co je potřeba udělat');
    out.title = title;
  }
  if (!partial || has(body, 'description')) out.description = cleanText(body?.description, MAX_DESCRIPTION, 'text_too_long');
  if (!partial || has(body, 'dueDate')) {
    const raw = body?.dueDate;
    if (raw == null || raw === '') out.dueDate = null;
    else {
      const d = String(raw);
      if (!isValidYmd(d)) throw new TaskError(400, 'bad_due_date', 'Neplatný termín');
      if (d < today && d !== current?.dueDate) throw new TaskError(400, 'due_in_past', 'Termín nemůže být v minulosti');
      out.dueDate = d;
    }
  }
  if (!partial || has(body, 'priority')) {
    const p = body?.priority == null || body?.priority === '' ? 'normal' : String(body.priority);
    if (!has(PRIORITIES, p)) throw new TaskError(400, 'bad_priority', 'Neplatná priorita');
    out.priority = p;
  }
  if (partial && !Object.keys(out).length) throw new TaskError(400, 'nothing_to_change', 'Není co měnit');
  return out;
};

/** Что поменялось при правке — для ленты и журнала (без текста описания). */
export const changedFields = (current: any, next: any): string[] =>
  ['title', 'description', 'dueDate', 'priority'].filter((k) => has(next, k) && (current?.[k] ?? null) !== (next[k] ?? null) && !(k === 'description' && !current?.[k] && !next[k]));

/**
 * Действие над поручением: проверка роли и статуса, новая запись ленты, новые поля.
 * `reportDate` — действие пришло из ежедневного отчёта.
 */
export const applyTaskAction = (
  task: any,
  { action, role, text, by, at, reportDate = null }: { action: string; role: string; text?: unknown; by: string; at: string; reportDate?: string | null }
) => {
  const rules = TRANSITIONS[role];
  const rule = rules?.[action];
  if (!rule) throw new TaskError(403, 'action_not_allowed', 'Tuto akci nemůžete provést');
  const status = task?.status || 'open';
  if (!rule.from.includes(status)) throw new TaskError(409, 'bad_transition', `Úkol je ve stavu «${STATUSES[status] || status}» — akci nelze provést`);
  const t = cleanText(text, MAX_EVENT_TEXT, 'text_too_long');
  if (TEXT_REQUIRED.has(action) && !t) throw new TaskError(400, 'text_required', 'Napište text');
  const events = Array.isArray(task?.events) ? task.events : [];
  if (events.length >= MAX_EVENTS) throw new TaskError(409, 'too_many_events', 'Úkol má příliš mnoho záznamů');
  const event: any = { at, kind: action, by, role, text: t };
  if (reportDate) event.reportDate = reportDate;
  const data: any = { events: [...events, event] };
  if (rule.to) {
    data.status = rule.to;
    if (rule.to === 'done') data.doneAt = at;
    if (rule.to === 'accepted' || rule.to === 'cancelled') {
      data.closedAt = at;
      data.closedBy = by;
    }
    if (rule.to === 'open') {
      data.doneAt = null;
      data.closedAt = null;
      data.closedBy = null;
    }
  }
  return { data, event };
};

/** Поручение просрочено: в работе и срок прошёл. */
export const isOverdue = (task: any, today: string): boolean => (task?.status || 'open') === 'open' && !!task?.dueDate && task.dueDate < today;

// принятые и отменённые — одна группа «закрытые»
const STATUS_ORDER = { open: 0, done: 1, accepted: 2, cancelled: 2 };

/** Порядок списка: в работе (просроченные, срочные, по сроку), ждут владельца, закрытые — свежие сверху. */
export const sortTasks = (rows: any[], today: string) =>
  [...rows].sort((a, b) => {
    const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (s) return s;
    if (a.status === 'open') {
      const o = Number(isOverdue(b, today)) - Number(isOverdue(a, today));
      if (o) return o;
      const u = Number(b.priority === 'urgent') - Number(a.priority === 'urgent');
      if (u) return u;
      const ad = a.dueDate || '9999-99-99';
      const bd = b.dueDate || '9999-99-99';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return String(a.createdAt) < String(b.createdAt) ? -1 : 1;
    }
    const at = String(a.closedAt || a.doneAt || a.updatedAt || '');
    const bt = String(b.closedAt || b.doneAt || b.updatedAt || '');
    return at < bt ? 1 : at > bt ? -1 : 0;
  });

export const fileView = (f: any) => ({
  documentId: f.documentId,
  fileName: f.fileName || 'soubor',
  mime: f.mime || null,
  size: Number(f.size) || 0,
  uploadedBy: f.uploadedBy || null,
  uploadedRole: f.uploadedRole || null,
  createdAt: f.createdAt || null,
});

/** Поручение наружу. */
export const taskRow = (doc: any, files: any[] = [], today = '') => ({
  documentId: doc.documentId,
  personal: doc.personal?.documentId || null,
  personalName: doc.personal?.name || null,
  title: doc.title || '',
  description: doc.description || '',
  dueDate: doc.dueDate || null,
  priority: doc.priority || 'normal',
  status: doc.status || 'open',
  overdue: today ? isOverdue(doc, today) : false,
  createdByName: doc.createdByName || null,
  doneAt: doc.doneAt || null,
  closedAt: doc.closedAt || null,
  closedBy: doc.closedBy || null,
  events: Array.isArray(doc.events) ? doc.events : [],
  files: files.map(fileView),
  version: Number.isInteger(doc.version) ? doc.version : 0,
  createdAt: doc.createdAt || null,
  updatedAt: doc.updatedAt || null,
});

/**
 * Заметки по поручениям из формы отчёта: [{id, done, note}] → только непустые
 * (отмечено «hotovo» или есть текст), без повторов.
 */
export const normalizeReportTasks = (raw: unknown) => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new TaskError(400, 'bad_tasks', 'Úkoly ve výkazu mají neplatný formát');
  const out = [];
  const seen = new Set();
  for (const it of raw) {
    const id = String(it?.id ?? '').trim();
    if (!DOC_ID.test(id)) throw new TaskError(400, 'bad_tasks', 'Úkoly ve výkazu mají neplatný formát');
    if (seen.has(id)) continue;
    seen.add(id);
    const note = cleanText(it?.note, MAX_EVENT_TEXT, 'text_too_long');
    const done = it?.done === true;
    if (!note && !done) continue;
    out.push({ taskId: id, done, note });
  }
  if (out.length > MAX_REPORT_TASKS) throw new TaskError(400, 'too_many_tasks', `Nejvýš ${MAX_REPORT_TASKS} úkolů ve výkazu`);
  return out;
};

/**
 * Какие заметки отчёта надо применить к поручениям: новые и изменившиеся по сравнению
 * с прошлой версией отчёта (правка отчёта не дублирует ленту). «hotovo» срабатывает
 * один раз — для поручения в работе; заметка без «hotovo» — ход работы.
 */
export const reportTaskActions = (prev: any[], next: any[]) => {
  const before = new Map((Array.isArray(prev) ? prev : []).map((n) => [n.taskId, n]));
  const out = [];
  for (const n of next) {
    const p = before.get(n.taskId);
    const becameDone = n.done && !p?.done;
    const noteChanged = n.note && n.note !== p?.note;
    if (becameDone) out.push({ taskId: n.taskId, action: 'done', text: n.note });
    else if (noteChanged) out.push({ taskId: n.taskId, action: 'progress', text: n.note });
  }
  return out;
};

const FIELDS = ['title', 'description', 'dueDate', 'priority', 'status', 'createdByName', 'doneAt', 'closedAt', 'closedBy', 'events', 'version', 'createdAt', 'updatedAt'];
const FILE_FIELDS = ['taskDocId', 'fileName', 'mime', 'size', 'uploadedBy', 'uploadedRole', 'createdAt'];
const notFound = () => new TaskError(404, 'task_not_found', 'Úkol nenalezen');
const fileNotFound = () => new TaskError(404, 'file_not_found', 'Příloha nenalezena');

const labelList = (o: Record<string, string>) => Object.entries(o).map(([key, label]) => ({ key, label }));

export default {
  _today(now: Date) {
    return pragueDateOf(now);
  },

  _log(action: string, session: any, task: any, summary: string) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'task',
        actorName: session?.username || '',
        entityDocId: task?.documentId || '',
        employeeName: task?.personal?.name || '',
        summary,
        details: {},
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /** Кто спрашивает: владелец — всё; исполнитель — свою карточку; остальным — 403. */
  async _who(session: any) {
    if (session?.role === 'owner') return { role: 'owner', personal: null };
    if (!session || !TASK_ROLES.includes(session.role)) throw new TaskError(403, 'not_allowed', 'Úkoly nejsou pro tuto roli');
    const p = await findSessionPersonal(strapi, session, { status: 'draft', fields: ['name'] });
    if (!p) throw new TaskError(404, 'no_card', 'Karta zaměstnance nenalezena — obraťte se na majitele');
    return { role: 'manager', personal: p };
  },

  /** Кому можно дать поручение: карточки управляющих (работающие). */
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

  async _filesDir() {
    const dir = await privateDir(process.env.TASK_FILES_DIR, 'tasks');
    if (!dir) throw new TaskError(503, 'storage_not_configured', 'Úložiště příloh na serveru není nastavené');
    return dir;
  },

  async _filesFor(taskDocIds: string[]) {
    const out = new Map<string, any[]>();
    const ids = [...new Set(taskDocIds.filter(Boolean))];
    if (!ids.length) return out;
    const rows = await strapi.documents(TASK_FILE_UID).findMany({
      filters: { taskDocId: { $in: ids } },
      fields: FILE_FIELDS,
      sort: [{ createdAt: 'asc' }],
      limit: ids.length * MAX_FILES_PER_TASK + 50,
    });
    for (const f of rows) {
      if (!out.has(f.taskDocId)) out.set(f.taskDocId, []);
      out.get(f.taskDocId).push(f);
    }
    return out;
  },

  /** Поручение с проверкой доступа: исполнитель видит только свои (чужое — 404, не 403). */
  async _find(id: unknown, who: any) {
    const documentId = String(id ?? '').trim();
    if (!DOC_ID.test(documentId)) throw notFound();
    const doc = await strapi.documents(TASK_UID).findOne({ documentId, fields: FIELDS, populate: { personal: { fields: ['name'] } } });
    if (!doc) throw notFound();
    if (who.role !== 'owner' && doc.personal?.documentId !== who.personal.documentId) throw notFound();
    return doc;
  },

  async _row(doc: any, today: string) {
    const files = (await this._filesFor([doc.documentId])).get(doc.documentId) || [];
    return taskRow(doc, files, today);
  },

  async _write(existing: any, data: any, now: Date) {
    const v = Number.isInteger(existing.version) ? existing.version : null;
    const res = await strapi.db.query(TASK_UID).updateMany({
      where: { documentId: existing.documentId, version: v == null ? { $null: true } : v },
      data: { ...data, version: (v ?? 0) + 1, updatedAt: now },
    });
    if (!res || !res.count) throw new TaskError(409, 'task_changed', 'Úkol se mezitím změnil — načtěte ho znovu');
    return strapi.documents(TASK_UID).findOne({ documentId: existing.documentId, fields: FIELDS, populate: { personal: { fields: ['name'] } } });
  },

  _meta(today: string) {
    return { today, priorities: labelList(PRIORITIES), statuses: labelList(STATUSES), maxFiles: MAX_FILES_PER_TASK };
  },

  /** GET /tasks?scope=active|closed|all — владелец: все; исполнитель: свои. */
  async list({ session, scope, personal, now = new Date() }: { session: any; scope?: unknown; personal?: unknown; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const sc = ['active', 'closed', 'all'].includes(String(scope)) ? String(scope) : 'active';
    const filters: any = {};
    if (sc === 'active') filters.status = { $in: ['open', 'done'] };
    if (sc === 'closed') filters.status = { $in: ['accepted', 'cancelled'] };
    if (who.role === 'owner') {
      const want = String(personal ?? '').trim();
      if (DOC_ID.test(want)) filters.personal = { documentId: { $eq: want } };
    } else filters.personal = { documentId: { $eq: who.personal.documentId } };
    const rows = await strapi.documents(TASK_UID).findMany({
      filters,
      fields: FIELDS,
      populate: { personal: { fields: ['name'] } },
      sort: [{ createdAt: 'desc' }],
      limit: sc === 'active' ? 500 : 300,
    });
    const files = await this._filesFor(rows.map((r) => r.documentId));
    const tasks = sortTasks(rows, today).map((r) => taskRow(r, files.get(r.documentId) || [], today));
    return {
      ...this._meta(today),
      role: who.role,
      scope: sc,
      ...(who.role === 'owner' ? { people: await this._people() } : {}),
      tasks,
    };
  },

  /** POST /tasks — новое поручение (владелец). */
  async create({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const today = this._today(now);
    const input = normalizeTaskInput(body, { today });
    const people = (await this._people()).filter((p) => p.isActive);
    const want = String(body?.personal ?? '').trim();
    const person = people.find((p) => p.documentId === want) || (people.length === 1 && !want ? people[0] : null);
    if (!person) throw new TaskError(400, 'bad_personal', 'Vyberte, komu úkol patří');
    const at = now.toISOString();
    const created = await strapi.documents(TASK_UID).create({
      data: {
        ...input,
        personal: person.documentId,
        status: 'open',
        createdByName: session?.username || '',
        createdByAccountId: Number(session?.id) || null,
        events: [{ at, kind: 'created', by: session?.username || '', role: 'owner', text: '' }],
        version: 1,
      },
    });
    const doc = await strapi.documents(TASK_UID).findOne({ documentId: created.documentId, fields: FIELDS, populate: { personal: { fields: ['name'] } } });
    this._log('task_create', session, doc, `Nový úkol: ${cut(doc.title, 120)}${doc.dueDate ? ` · do ${fmtDay(doc.dueDate)}` : ''}`);
    return { task: await this._row(doc, today) };
  },

  /** PATCH /tasks/:id — правка названия, описания, срока, приоритета (владелец). */
  async update({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const existing = await this._find(id, { role: 'owner' });
    if (['accepted', 'cancelled'].includes(existing.status)) throw new TaskError(409, 'task_closed', 'Uzavřený úkol nelze upravit — nejdřív ho vraťte do práce');
    const input = normalizeTaskInput(body, { today, partial: true, current: existing });
    const changed = changedFields(existing, input);
    if (!changed.length) return { task: await this._row(existing, today) };
    const at = now.toISOString();
    const labels = { title: 'název', description: 'popis', dueDate: 'termín', priority: 'priorita' };
    const events = Array.isArray(existing.events) ? existing.events : [];
    const text = changed.map((k) => labels[k]).join(', ');
    const saved = await this._write(existing, { ...input, events: [...events, { at, kind: 'edited', by: session?.username || '', role: 'owner', text }] }, now);
    this._log('task_edit', session, saved, `Úkol upraven (${text}): ${cut(saved.title, 120)}`);
    return { task: await this._row(saved, today) };
  },

  /** POST /tasks/:id/actions {action, text} — hotovo / ход работы / принять / вернуть / отменить / комментарий. */
  async act({ session, id, body, now = new Date(), reportDate = null }: { session: any; id: unknown; body: any; now?: Date; reportDate?: string | null }) {
    const who = await this._who(session);
    const today = this._today(now);
    const existing = await this._find(id, who);
    const action = String(body?.action ?? '');
    const { data } = applyTaskAction(existing, { action, role: who.role, text: body?.text, by: session?.username || '', at: now.toISOString(), reportDate });
    const saved = await this._write(existing, data, now);
    const head = {
      done: 'Úkol hotov',
      progress: 'Úkol: průběh',
      comment: 'Úkol: komentář',
      accept: 'Úkol převzat',
      reopen: 'Úkol vrácen do práce',
      cancel: 'Úkol zrušen',
    }[action];
    this._log(`task_${action}`, session, saved, `${head}: ${cut(saved.title, 120)}${reportDate ? ` (výkaz ${fmtDay(reportDate)})` : ''}`);
    return { task: await this._row(saved, today) };
  },

  /**
   * Заметки из отчёта (saveMine): применить новые/изменившиеся к поручениям исполнителя.
   * Проверка до записи отчёта — `checkReportTasks`; здесь сбой одного поручения не роняет
   * остальные (отчёт уже сохранён) — в лог.
   */
  async checkReportTasks(session: any, notes: any[]) {
    if (!notes.length) return [];
    const who = await this._who(session);
    const out = [];
    for (const n of notes) {
      const doc = await this._find(n.taskId, who).catch(() => null);
      if (!doc) throw new TaskError(400, 'bad_tasks', 'Úkol ve výkazu nenalezen');
      out.push({ ...n, title: doc.title || '' });
    }
    return out;
  },

  async applyReportTasks(session: any, prev: any[], next: any[], reportDate: string, now = new Date()) {
    for (const a of reportTaskActions(prev, next)) {
      try {
        await this.act({ session, id: a.taskId, body: { action: a.action, text: a.text }, now, reportDate });
      } catch (e) {
        // поручение уже не в работе (ждёт владельца, принято, отменено) — заметка уходит комментарием
        if (e?.code === 'bad_transition' && a.text) {
          await this.act({ session, id: a.taskId, body: { action: 'comment', text: a.text }, now, reportDate }).catch(() => {});
        } else strapi.log.error(`owner-tasks: заметка отчёта ${reportDate} к ${a.taskId} не применена: ${e.message}`);
      }
    }
  },

  /** Поручения исполнителя для формы отчёта: в работе и ждут владельца. */
  async openFor(personalDocId: string, now = new Date()) {
    const today = this._today(now);
    const rows = await strapi.documents(TASK_UID).findMany({
      filters: { personal: { documentId: { $eq: personalDocId } }, status: { $in: ['open', 'done'] } },
      fields: ['title', 'dueDate', 'priority', 'status', 'createdAt'],
      limit: 200,
    });
    return sortTasks(rows, today).map((r) => ({
      documentId: r.documentId,
      title: r.title || '',
      dueDate: r.dueDate || null,
      priority: r.priority || 'normal',
      status: r.status || 'open',
      overdue: isOverdue(r, today),
    }));
  },

  /** GET /tasks/attention — «Сегодня»: владельцу — просроченные и ждущие принятия; исполнителю — свои в работе. */
  async attention({ session, now = new Date() }: { session: any; now?: Date }) {
    const who = await this._who(session);
    const today = this._today(now);
    const filters: any = { status: { $in: who.role === 'owner' ? ['open', 'done'] : ['open'] } };
    if (who.role !== 'owner') filters.personal = { documentId: { $eq: who.personal.documentId } };
    const rows = await strapi.documents(TASK_UID).findMany({
      filters,
      fields: ['title', 'dueDate', 'priority', 'status', 'doneAt', 'createdAt'],
      populate: { personal: { fields: ['name'] } },
      limit: 500,
    });
    const view = (r) => ({
      documentId: r.documentId,
      title: r.title || '',
      personalName: r.personal?.name || null,
      dueDate: r.dueDate || null,
      priority: r.priority || 'normal',
      status: r.status,
      overdue: isOverdue(r, today),
      doneAt: r.doneAt || null,
    });
    const sorted = sortTasks(rows, today);
    return {
      role: who.role,
      today,
      open: sorted.filter((r) => r.status === 'open').length,
      overdue: sorted.filter((r) => isOverdue(r, today)).map(view),
      urgent: sorted.filter((r) => r.status === 'open' && r.priority === 'urgent' && !isOverdue(r, today)).map(view),
      waiting: who.role === 'owner' ? sorted.filter((r) => r.status === 'done').map(view) : [],
      // исполнителю — ближайшие в работе (для карточки)
      next: who.role === 'owner' ? [] : sorted.filter((r) => r.status === 'open').slice(0, 5).map(view),
    };
  },

  // ── вложения ───────────────────────────────────────────────────────────────

  /** POST /tasks/:id/files (multipart, поле `files`, один файл) — обе стороны; у отменённого — нет. */
  async uploadFile({ session, id, files }: { session: any; id: unknown; files: any }) {
    const who = await this._who(session);
    const file = files?.files;
    if (!file || Array.isArray(file) || !file.filepath) throw new TaskError(400, 'file_required', 'Vyberte jeden soubor');
    const size = Number(file.size) || 0;
    if (size <= 0) throw new TaskError(400, 'file_empty', 'Soubor je prázdný');
    if (size > MAX_FILE_BYTES) throw new TaskError(413, 'file_too_big', 'Soubor je větší než 10 MB');
    const doc = await this._find(id, who);
    if (doc.status === 'cancelled') throw new TaskError(409, 'task_closed', 'Ke zrušenému úkolu nelze přidat přílohu');
    const type = detectFile(await readHead(file.filepath));
    if (!type) throw new TaskError(400, 'bad_file_type', 'Podporované formáty: JPG, PNG, WEBP a PDF');
    const existing = (await this._filesFor([doc.documentId])).get(doc.documentId) || [];
    if (existing.length >= MAX_FILES_PER_TASK) throw new TaskError(409, 'too_many_files', `K úkolu nejvýš ${MAX_FILES_PER_TASK} příloh`);
    const fileName = safeFileName(file.originalFilename, type.ext, 'priloha');
    const dir = await this._filesDir();
    const { storedName } = await storePrivateFile(dir, file.filepath);
    let created;
    try {
      created = await strapi.documents(TASK_FILE_UID).create({
        data: { taskDocId: doc.documentId, fileName, mime: type.mime, size, storedName, uploadedBy: session?.username || null, uploadedRole: who.role },
      });
    } catch (e) {
      await removePrivateFile(dir, storedName, `tasks: příloha ${storedName}`);
      throw e;
    }
    this._log('task_file_add', session, doc, `Příloha k úkolu: ${cut(doc.title, 100)} — ${cut(fileName, 60)}`);
    return { file: fileView({ ...created, fileName, mime: type.mime, size, uploadedBy: session?.username || null, uploadedRole: who.role }) };
  },

  async _findFile(taskDocId: string, fid: unknown, withStored = false) {
    const documentId = String(fid ?? '').trim();
    if (!DOC_ID.test(documentId)) throw fileNotFound();
    const rows = await strapi.documents(TASK_FILE_UID).findMany({
      filters: { documentId: { $eq: documentId }, taskDocId: { $eq: taskDocId } },
      fields: withStored ? [...FILE_FIELDS, 'storedName'] : FILE_FIELDS,
      limit: 1,
    });
    if (!rows[0]) throw fileNotFound();
    return rows[0];
  },

  /** GET /tasks/:id/files/:fid — файл потоком (контроллер ставит заголовки). */
  async downloadFile({ session, id, fid }: { session: any; id: unknown; fid: unknown }) {
    const who = await this._who(session);
    const doc = await this._find(id, who);
    const file = await this._findFile(doc.documentId, fid, true);
    const opened = await openPrivateFile(await this._filesDir(), file.storedName);
    if (!opened) throw new TaskError(404, 'file_missing', 'Soubor přílohy na serveru nenalezen');
    const name = safeFileName(file.fileName, '', 'priloha');
    return { stream: opened.stream, size: opened.size, mime: file.mime || 'application/octet-stream', disposition: contentDisposition(name) };
  },

  /** DELETE /tasks/:id/files/:fid — владелец любое; исполнитель только своё. */
  async deleteFile({ session, id, fid }: { session: any; id: unknown; fid: unknown }) {
    const who = await this._who(session);
    const doc = await this._find(id, who);
    const file = await this._findFile(doc.documentId, fid, true);
    if (who.role !== 'owner' && (file.uploadedRole !== who.role || file.uploadedBy !== session?.username)) {
      throw new TaskError(403, 'not_your_file', 'Smazat můžete jen svou přílohu');
    }
    await strapi.documents(TASK_FILE_UID).delete({ documentId: file.documentId });
    await removePrivateFile(await this._filesDir().catch(() => null), file.storedName, `tasks: příloha ${file.documentId}`);
    this._log('task_file_delete', session, doc, `Příloha smazána: ${cut(doc.title, 100)} — ${cut(file.fileName, 60)}`);
    return { deleted: file.documentId };
  },
};
