// Поручения владельца управляющей (services/owner-tasks.ts, s240 — §11 плана «Výkaz práce»):
//   - поля: название обязательно, срок не в прошлом (старый при правке можно оставить), приоритет из списка;
//   - статусы: open → done (исполнитель) → accepted (владелец); вернуть/отменить — владелец;
//     s245: исполнитель снимает «hotovo» (undone: done → open), пока владелец не принял;
//     чужая роль или неверный статус — 403/409; ход работы и комментарий — с текстом;
//   - исполнитель видит только свои (чужое — 404), владелец — все; администратору/мастеру — 403;
//   - порядок: просроченные, срочные, по сроку; ждут владельца; закрытые свежие сверху;
//   - запись условная по version; журнал — entityType task, только название;
//   - заметки из отчёта: применяются только новые/изменившиеся, «hotovo» один раз;
//   - ручки: все — requireStaff + роль в сервисе (s246: создать/править может и управляющая); REST нет;
//   - s246: задачи управляющей себе и владельцу — стороны «исполнитель/постановщик», «кто поставил —
//     тот принимает», себе и владельцу — закрываются сразу по «hotovo»; старые строки без полей —
//     поручения владельца управляющей.
//   - s247: создание и каждое действие отдают событие в manager-notify (кому слать — решает он);
//     сбой push не ломает поручение.
//   - s258: автор удаляет свой комментарий / ход работы бесследно — без события, журнала и push,
//     запись журнала о комментарии стирается; чужое — 403, нет такой — 404.
// Запуск: cd strapi && node --test tests/owner-tasks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const toJs = (file) =>
  ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

let js = toJs('src/api/booking-engine/services/owner-tasks.ts');
for (const [from, file] of [
  ["from './slots-core'", 'src/api/booking-engine/services/slots-core.ts'],
  ["from '../../../utils/staff-identity'", 'src/utils/staff-identity.ts'],
  ["from '../../../utils/private-files'", 'src/utils/private-files.ts'],
]) {
  assert.ok(js.includes(from), from);
  js = js.split(from).join(`from '${dataUrl(toJs(file))}'`);
}
const T = await import(dataUrl(js));
const svc = T.default;

const TASK = 'api::owner-task.owner-task';
const FILE = 'api::owner-task-file.owner-task-file';
const PERSONAL = 'api::personal.personal';
const MARIIA = 'mariia000000000000000001';
const ANNA = 'anna00000000000000000002';
const OLD = 'oldmgr000000000000000003';

const owner = { id: 1, role: 'owner', username: 'Dima' };
const manager = { id: 11, role: 'manager', username: 'Mariia Medvedeva', personalDocId: MARIIA };
const anna = { id: 15, role: 'manager', username: 'Anna', personalDocId: ANNA };
const admin = { id: 12, role: 'administrator', username: 'Vika' };
const master = { id: 13, role: 'master', username: 'Karina' };

const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
const matchCond = (val, cond) => {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return val === cond;
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$eq') return val === arg;
    if (op === '$eqi') return String(val ?? '').toLowerCase() === String(arg).toLowerCase();
    if (op === '$in') return arg.includes(val);
    if (op === '$gte') return val != null && val >= arg;
    if (op === '$null') return arg ? val == null : val != null;
    return val != null && matchCond(val[op], arg);
  });
};
const get = (row, key) => (key === 'personal' ? (row.personalDocId ? { documentId: row.personalDocId } : null) : row[key]);
const matches = (row, filters = {}) => Object.entries(filters).every(([k, c]) => matchCond(get(row, k), c));

let seq = 1;
function fresh() {
  const db = {
    [PERSONAL]: [
      { documentId: MARIIA, name: 'Mariia Medvedeva', position: 'manager', isActive: true },
      { documentId: ANNA, name: 'Anna', position: 'manager', isActive: true },
      { documentId: OLD, name: 'Stará', position: 'manager', isActive: false },
    ],
    [TASK]: [],
    [FILE]: [],
  };
  const logs = [];
  // s258: журнал как таблица — найти запись удалённого события и стереть её
  const logQuery = {
    async findMany({ where, limit }) {
      await tick();
      const { createdAt: c, ...eq } = where;
      return logs
        .filter((l) => Object.entries(eq).every(([k, v]) => l[k] === v))
        .filter((l) => Date.parse(l.createdAt) >= c.$gte.getTime() && Date.parse(l.createdAt) <= c.$lte.getTime())
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, limit);
    },
    async delete({ where }) {
      const i = logs.findIndex((l) => l.id === where.id);
      if (i >= 0) logs.splice(i, 1);
    },
  };
  const withPersonal = (r) => ({ ...clone(r), personal: r.personalDocId ? { documentId: r.personalDocId, name: db[PERSONAL].find((p) => p.documentId === r.personalDocId)?.name } : null });
  globalThis.strapi = {
    rows: db,
    logs,
    documents: (uid) => ({
      async findMany({ filters = {}, limit, populate } = {}) {
        await tick();
        const rows = db[uid].filter((r) => matches(r, filters)).slice(0, limit ?? 1000);
        return populate?.personal ? rows.map(withPersonal) : clone(rows);
      },
      async findOne({ documentId, populate }) {
        await tick();
        const r = db[uid].find((x) => x.documentId === documentId);
        return r ? (populate?.personal ? withPersonal(r) : clone(r)) : null;
      },
      async create({ data }) {
        await tick();
        const { personal, ...rest } = data;
        const row = { id: seq, documentId: `doc${String(seq++).padStart(18, '0')}`, personalDocId: personal, createdAt: new Date().toISOString(), ...clone(rest) };
        db[uid].push(row);
        return clone(row);
      },
      async delete({ documentId }) {
        db[uid] = db[uid].filter((r) => r.documentId !== documentId);
      },
    }),
    db: {
      query: (uid) => uid === 'api::calendar-log.calendar-log' ? logQuery : ({
        async updateMany({ where, data }) {
          await tick();
          const rows = db[uid].filter((r) => matches(r, where));
          for (const r of rows) Object.assign(r, clone({ ...data, updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : data.updatedAt }));
          return { count: rows.length };
        },
      }),
    },
    // s247: push — шпион manager-notify (failPush — сбой отправки)
    pushes: [],
    failPush: false,
    service: (uid) => {
      if (uid === 'api::booking-engine.manager-notify') {
        return {
          async taskEvent(task, ev) {
            await tick();
            globalThis.strapi.pushes.push({ id: task.documentId, personal: task.personal?.documentId || null, ...ev });
            if (globalThis.strapi.failPush) throw new Error('push down');
          },
        };
      }
      assert.equal(uid, 'api::calendar-log.calendar-log');
      return { write: async (e) => void logs.push({ id: logs.length + 1, createdAt: globalThis.strapi.logAt || new Date().toISOString(), ...e }) };
    },
    log: { error() {}, warn() {} },
  };
  return globalThis.strapi;
}
const now = new Date('2026-10-02T10:00:00Z');
const expectErr = async (p, status, code) =>
  assert.rejects(p, (e) => (assert.equal(e.status, status, `${e.status} ${e.code}`), code && assert.equal(e.code, code), true));

test('поля: название, срок не в прошлом, приоритет; правка — только присланное', () => {
  const today = '2026-10-02';
  assert.deepEqual(T.normalizeTaskInput({ title: '  Objednat   křeslo ', dueDate: '2026-10-05' }, { today }), {
    title: 'Objednat křeslo',
    description: '',
    dueDate: '2026-10-05',
    priority: 'normal',
  });
  assert.throws(() => T.normalizeTaskInput({ title: ' ' }, { today }), (e) => e.code === 'title_required');
  assert.throws(() => T.normalizeTaskInput({ title: 'a', dueDate: '2026-10-01' }, { today }), (e) => e.code === 'due_in_past');
  assert.throws(() => T.normalizeTaskInput({ title: 'a', dueDate: '2026-02-30' }, { today }), (e) => e.code === 'bad_due_date');
  assert.throws(() => T.normalizeTaskInput({ title: 'a', priority: 'top' }, { today }), (e) => e.code === 'bad_priority');
  assert.deepEqual(T.normalizeTaskInput({ dueDate: '2026-09-30', priority: 'urgent' }, { today, partial: true, current: { dueDate: '2026-09-30' } }), {
    dueDate: '2026-09-30',
    priority: 'urgent',
  });
  assert.throws(() => T.normalizeTaskInput({}, { today, partial: true }), (e) => e.code === 'nothing_to_change');
  assert.deepEqual(T.changedFields({ title: 'A', dueDate: null, description: null }, { title: 'A', dueDate: '2026-10-09', description: '' }), ['dueDate']);
});

test('статусы: кто и откуда', () => {
  const at = '2026-10-02T10:00:00.000Z';
  const act = (task, action, role, text) => T.applyTaskAction(task, { action, role, text, by: 'x', at });
  const done = act({ status: 'open', events: [] }, 'done', 'manager');
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.doneAt, at);
  assert.throws(() => act({ status: 'open' }, 'accept', 'owner'), (e) => e.code === 'bad_transition');
  assert.throws(() => act({ status: 'open' }, 'accept', 'manager'), (e) => e.code === 'action_not_allowed');
  assert.throws(() => act({ status: 'open' }, 'done', 'owner'), (e) => e.code === 'action_not_allowed');
  assert.throws(() => act({ status: 'done' }, 'progress', 'manager', 'x'), (e) => e.code === 'bad_transition');
  assert.throws(() => act({ status: 'open' }, 'progress', 'manager', ' '), (e) => e.code === 'text_required');
  const acc = act({ status: 'done' }, 'accept', 'owner');
  assert.equal(acc.data.status, 'accepted');
  assert.equal(acc.data.closedBy, 'x');
  const re = act({ status: 'accepted' }, 'reopen', 'owner', 'Ještě ne');
  assert.deepEqual([re.data.status, re.data.closedAt, re.data.doneAt], ['open', null, null]);
  // s245: исполнитель снимает «hotovo» только из done; текст необязателен
  const un = act({ status: 'done', doneAt: at, events: [] }, 'undone', 'manager');
  assert.deepEqual([un.data.status, un.data.doneAt, un.event.kind, un.event.text], ['open', null, 'undone', '']);
  assert.throws(() => act({ status: 'accepted' }, 'undone', 'manager'), (e) => e.code === 'bad_transition', 'после převzato — только владелец');
  assert.throws(() => act({ status: 'open' }, 'undone', 'manager'), (e) => e.code === 'bad_transition');
  assert.throws(() => act({ status: 'done' }, 'undone', 'owner'), (e) => e.code === 'action_not_allowed');
  assert.throws(() => act({ status: 'accepted' }, 'cancel', 'owner'), (e) => e.code === 'bad_transition');
  assert.equal(act({ status: 'cancelled' }, 'comment', 'manager', 'ok').data.status, undefined);
  const fromReport = T.applyTaskAction({ status: 'open' }, { action: 'progress', role: 'manager', text: 'a', by: 'x', at, reportDate: '2026-10-01' });
  assert.equal(fromReport.event.reportDate, '2026-10-01');
});

test('порядок и просрочка', () => {
  const rows = [
    { documentId: 'a', status: 'accepted', closedAt: '2026-10-01T00:00:00Z' },
    { documentId: 'b', status: 'open', dueDate: '2026-10-10', priority: 'normal' },
    { documentId: 'c', status: 'open', dueDate: '2026-10-01', priority: 'normal' },
    { documentId: 'd', status: 'done', doneAt: '2026-10-02T00:00:00Z' },
    { documentId: 'e', status: 'open', priority: 'urgent' },
    { documentId: 'f', status: 'cancelled', closedAt: '2026-10-02T00:00:00Z' },
    { documentId: 'g', status: 'open', dueDate: '2026-10-03', priority: 'normal' },
  ];
  assert.deepEqual(T.sortTasks(rows, '2026-10-02').map((r) => r.documentId).join(''), 'cegbdfa');
  assert.equal(T.isOverdue({ status: 'open', dueDate: '2026-10-01' }, '2026-10-02'), true);
  assert.equal(T.isOverdue({ status: 'done', dueDate: '2026-10-01' }, '2026-10-02'), false);
  assert.equal(T.isOverdue({ status: 'open', dueDate: '2026-10-02' }, '2026-10-02'), false, 'срок сегодня — ещё не просрочено');
});

test('заметки отчёта: новые и изменившиеся, «hotovo» один раз', () => {
  const n = T.normalizeReportTasks([
    { id: 'task0000000000000000001', done: true, note: ' x ' },
    { id: 'task0000000000000000002', note: '' },
    { id: 'task0000000000000000001', note: 'dup' },
  ]);
  assert.deepEqual(n, [{ taskId: 'task0000000000000000001', done: true, note: 'x' }]);
  assert.throws(() => T.normalizeReportTasks([{ id: '../x' }]), (e) => e.code === 'bad_tasks');
  assert.throws(() => T.normalizeReportTasks('x'), (e) => e.code === 'bad_tasks');
  const A = 'task0000000000000000001';
  const B = 'task0000000000000000002';
  assert.deepEqual(T.reportTaskActions([], [{ taskId: A, done: true, note: 'x' }, { taskId: B, done: false, note: 'y' }]), [
    { taskId: A, action: 'done', text: 'x' },
    { taskId: B, action: 'progress', text: 'y' },
  ]);
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: true, note: 'x' }], [{ taskId: A, done: true, note: 'x' }]), []);
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: true, note: 'x' }], [{ taskId: A, done: true, note: 'x2' }]), [{ taskId: A, action: 'progress', text: 'x2' }]);
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: false, note: 'x' }], [{ taskId: A, done: true, note: 'x' }]), [{ taskId: A, action: 'done', text: 'x' }]);
  // s245: снятое «hotovo» — явная отметка undone (ключ только когда true; при done отбрасывается)
  assert.deepEqual(T.normalizeReportTasks([{ id: A, undone: true }, { id: B, done: true, undone: true }, { id: 'task0000000000000000003', undone: false }]), [
    { taskId: A, done: false, note: '', undone: true },
    { taskId: B, done: true, note: '' },
  ]);
  assert.deepEqual(T.reportTaskActions([], [{ taskId: A, done: false, note: '', undone: true }]), [{ taskId: A, action: 'undone', text: '' }]);
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: true, note: 'x' }], [{ taskId: A, done: false, note: 'chybí sklad', undone: true }]), [{ taskId: A, action: 'undone', text: 'chybí sklad' }]);
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: true, note: 'x' }], [{ taskId: A, done: false, note: 'x', undone: true }]), [{ taskId: A, action: 'undone', text: '' }], 'старый текст второй раз не идёт');
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: false, note: 'x', undone: true }], [{ taskId: A, done: false, note: 'x', undone: true }]), [], 'правка отчёта не повторяет undone');
  assert.deepEqual(T.reportTaskActions([{ taskId: A, done: true, note: 'x' }], []), [], 'отсутствие записи «hotovo» не снимает');
});

test('доступ: владелец создаёт и видит всё; исполнитель — только свои; остальным 403', async () => {
  const s = fresh();
  await expectErr(svc.create({ session: owner, body: { title: 'X' }, now }), 400, 'bad_personal');
  await expectErr(svc.create({ session: owner, body: { title: 'X', personal: OLD }, now }), 400, 'bad_personal');
  const a = (await svc.create({ session: owner, body: { title: 'Objednat křeslo', personal: MARIIA, dueDate: '2026-10-05', priority: 'urgent', description: 'TAJNÝ POPIS' }, now })).task;
  const b = (await svc.create({ session: owner, body: { title: 'Pro Annu', personal: ANNA }, now })).task;
  assert.equal(a.personalName, 'Mariia Medvedeva');
  assert.deepEqual(a.events.map((e) => e.kind), ['created']);
  assert.equal(s.logs[0].action, 'task_create');
  assert.equal(s.logs[0].entityType, 'task');
  assert.doesNotMatch(JSON.stringify(s.logs), /TAJNÝ/, 'описание в журнал не идёт');

  const all = await svc.list({ session: owner, now });
  assert.equal(all.tasks.length, 2);
  assert.equal(all.people.length, 3);
  const mine = await svc.list({ session: manager, now });
  assert.deepEqual(mine.tasks.map((t) => t.title), ['Objednat křeslo']);
  assert.equal(mine.people, undefined, 'список людей — только владельцу');
  await expectErr(svc.act({ session: manager, id: b.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found');
  await expectErr(svc.list({ session: admin, now }), 403, 'not_allowed');
  await expectErr(svc.list({ session: master, now }), 403, 'not_allowed');
  await expectErr(svc.attention({ session: admin, now }), 403, 'not_allowed');
});

test('путь поручения: ход работы → hotovo → вернуть → hotovo → принять; правка закрытого — 409', async () => {
  const s = fresh();
  const t = (await svc.create({ session: owner, body: { title: 'Inventura', personal: MARIIA }, now })).task;
  const id = t.documentId;
  await svc.act({ session: manager, id, body: { action: 'progress', text: 'Půlka' }, now });
  let r = (await svc.act({ session: manager, id, body: { action: 'done', text: 'Hotovo' }, now })).task;
  assert.equal(r.status, 'done');
  const att = await svc.attention({ session: owner, now });
  assert.deepEqual(att.waiting.map((x) => x.documentId), [id]);
  r = (await svc.act({ session: owner, id, body: { action: 'reopen', text: 'Chybí sklad' }, now })).task;
  assert.equal(r.status, 'open');
  await svc.act({ session: manager, id, body: { action: 'done' }, now });
  // s245: управляющая передумала — снимает «hotovo» сама, потом снова hotovo
  r = (await svc.act({ session: manager, id, body: { action: 'undone', text: 'Ještě faktura' }, now })).task;
  assert.equal(r.status, 'open');
  assert.equal(r.doneAt, null);
  await svc.act({ session: manager, id, body: { action: 'done' }, now });
  r = (await svc.act({ session: owner, id, body: { action: 'accept' }, now })).task;
  assert.equal(r.status, 'accepted');
  await expectErr(svc.act({ session: manager, id, body: { action: 'undone' }, now }), 409, 'bad_transition');
  assert.deepEqual(r.events.map((e) => e.kind), ['created', 'progress', 'done', 'reopen', 'done', 'undone', 'done', 'accept']);
  await expectErr(svc.update({ session: owner, id, body: { title: 'Y' }, now }), 409, 'task_closed');
  assert.equal((await svc.list({ session: owner, now })).tasks.length, 0, 'принятое — не в активных');
  assert.equal((await svc.list({ session: owner, scope: 'closed', now })).tasks.length, 1);
  assert.deepEqual(s.logs.map((l) => l.action), ['task_create', 'task_progress', 'task_done', 'task_reopen', 'task_done', 'task_undone', 'task_done', 'task_accept']);
  assert.match(s.logs[5].summary, /^Úkol vrácen — ještě není hotovo: Inventura$/);
});

test('правка владельцем: лента «edited»; без изменений — без записи; устаревшая версия — 409', async () => {
  const s = fresh();
  const t = (await svc.create({ session: owner, body: { title: 'A', personal: MARIIA }, now })).task;
  const r = (await svc.update({ session: owner, id: t.documentId, body: { dueDate: '2026-10-09', priority: 'urgent' }, now })).task;
  assert.equal(r.events.at(-1).kind, 'edited');
  assert.equal(r.events.at(-1).text, 'termín, priorita');
  const v = s.rows[TASK][0].version;
  await svc.update({ session: owner, id: t.documentId, body: { dueDate: '2026-10-09' }, now });
  assert.equal(s.rows[TASK][0].version, v, 'то же — без записи');
  // гонка: две записи с одной прочитанной версией
  const res = await Promise.allSettled([
    svc.act({ session: manager, id: t.documentId, body: { action: 'comment', text: '1' }, now }),
    svc.act({ session: owner, id: t.documentId, body: { action: 'comment', text: '2' }, now }),
  ]);
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(res.find((x) => x.status === 'rejected').reason.code, 'task_changed');
});

test('«Сегодня»: владельцу просроченные и ждущие; исполнителю — свои в работе', async () => {
  fresh();
  const mk = async (title, personal, extra = {}) => (await svc.create({ session: owner, body: { title, personal, ...extra }, now })).task;
  const late = await mk('Pozdě', MARIIA, { dueDate: '2026-10-03' });
  await mk('Urgentní', MARIIA, { priority: 'urgent' });
  await mk('Anny', ANNA, { dueDate: '2026-10-03' });
  const later = new Date('2026-10-05T10:00:00Z');
  const o = await svc.attention({ session: owner, now: later });
  assert.deepEqual(o.overdue.map((x) => x.title).sort(), ['Anny', 'Pozdě']);
  assert.deepEqual(o.urgent.map((x) => x.title), ['Urgentní']);
  const m = await svc.attention({ session: manager, now: later });
  assert.equal(m.open, 2);
  assert.deepEqual(m.overdue.map((x) => x.documentId), [late.documentId]);
  assert.deepEqual(m.next.map((x) => x.title), ['Pozdě', 'Urgentní']);
  assert.deepEqual(m.waiting, []);
  const a = await svc.attention({ session: anna, now: later });
  assert.deepEqual(a.overdue.map((x) => x.title), ['Anny']);
});

test('вложения: без каталога — 503; чужое поручение — 404; удалить чужое исполнителю нельзя', async () => {
  const s = fresh();
  const t = (await svc.create({ session: owner, body: { title: 'A', personal: MARIIA }, now })).task;
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'task-')), 'a.pdf');
  fs.writeFileSync(tmp, '%PDF-1.4 test');
  delete process.env.TASK_FILES_DIR;
  await expectErr(svc.uploadFile({ session: manager, id: t.documentId, files: { files: { filepath: tmp, size: 13, originalFilename: 'a.pdf' } } }), 503, 'storage_not_configured');
  await expectErr(svc.uploadFile({ session: anna, id: t.documentId, files: { files: { filepath: tmp, size: 13 } } }), 404, 'task_not_found');
  await expectErr(svc.uploadFile({ session: manager, id: t.documentId, files: {} }), 400, 'file_required');
  s.rows[FILE].push({ documentId: 'file0000000000000000001', taskDocId: t.documentId, fileName: 'x.pdf', storedName: 'a'.repeat(32), uploadedBy: 'Dima', uploadedRole: 'owner' });
  await expectErr(svc.deleteFile({ session: manager, id: t.documentId, fid: 'file0000000000000000001' }), 403, 'not_your_file');
  const listed = await svc.list({ session: manager, now });
  assert.equal(listed.tasks[0].files[0].fileName, 'x.pdf');
  assert.equal(listed.tasks[0].files[0].storedName, undefined, 'имя на диске наружу не уходит');
  await svc.deleteFile({ session: owner, id: t.documentId, fid: 'file0000000000000000001' });
  assert.equal(s.rows[FILE].length, 0);
});

test('ручки и коллекции: гейты, REST-роутов нет', () => {
  const routes = read('src/api/booking-engine/routes/booking-engine.ts');
  const ctrl = read('src/api/booking-engine/controllers/booking-engine.ts');
  const want = {
    adminTasksAttention: ['GET', '/engine/admin/tasks/attention', 'requireStaff'],
    adminTasksList: ['GET', '/engine/admin/tasks', 'requireStaff'],
    adminTaskCreate: ['POST', '/engine/admin/tasks', 'requireStaff'],
    adminTaskUpdate: ['PATCH', '/engine/admin/tasks/:id', 'requireStaff'],
    adminTaskAction: ['POST', '/engine/admin/tasks/:id/actions', 'requireStaff'],
    adminTaskEventRemove: ['POST', '/engine/admin/tasks/:id/events/remove', 'requireStaff'],
    adminTaskFileUpload: ['POST', '/engine/admin/tasks/:id/files', 'requireStaff'],
    adminTaskFileDownload: ['GET', '/engine/admin/tasks/:id/files/:fid', 'requireStaff'],
    adminTaskFileDelete: ['DELETE', '/engine/admin/tasks/:id/files/:fid', 'requireStaff'],
  };
  for (const [handler, [method, p, gate]] of Object.entries(want)) {
    assert.ok(routes.includes(`admin('${method}', '${p}', 'booking-engine.${handler}')`), `роут ${handler}`);
    const body = ctrl.split(`async ${handler}(ctx) {`)[1]?.split('\n  },')[0] || '';
    assert.ok(body.includes(`const session = ${gate}(ctx);`), `гейт ${handler} — ${gate}`);
  }
  assert.ok(routes.indexOf("'/engine/admin/tasks/attention'") < routes.indexOf("'/engine/admin/tasks/:id'"), 'attention раньше :id');
  for (const c of ['owner-task', 'owner-task-file']) {
    assert.equal(fs.existsSync(path.join(root, `src/api/${c}/routes`)), false, `${c}: REST-роутов нет`);
    assert.equal(fs.existsSync(path.join(root, `src/api/${c}/controllers`)), false);
  }
  const f = JSON.parse(read('src/api/owner-task-file/content-types/owner-task-file/schema.json'));
  assert.equal(f.attributes.storedName.private, true);
});

// ── s246: задачи управляющей себе и владельцу ───────────────────────────────
test('s246 стороны: матрица действий на трёх видах задач × две роли', () => {
  const keys = (task, role) => Object.keys(T.transitionsFor(task, role)).sort().join()
  const legacy = {} // старая строка без полей = поручение владельца управляющей
  const self = { assignee: 'manager', createdByRole: 'manager' }
  const toOwner = { assignee: 'owner', createdByRole: 'manager' }
  assert.equal(keys(legacy, 'manager'), 'comment,done,progress,undone')
  assert.equal(keys(legacy, 'owner'), 'accept,cancel,comment,reopen')
  assert.equal(keys(self, 'manager'), 'cancel,comment,done,progress,reopen')
  assert.equal(keys(self, 'owner'), 'comment', 'задача управляющей самой себе — владельцу только комментарий')
  assert.equal(keys(toOwner, 'owner'), 'comment,done', 'владелец-исполнитель: hotovo и комментарий')
  assert.equal(keys(toOwner, 'manager'), 'cancel,comment,reopen', 'постановщик: вернуть, отменить')
  assert.equal(keys(legacy, 'administrator'), 'comment')
  assert.deepEqual([T.assigneeOf(legacy), T.creatorOf(legacy), T.closesOnDone(legacy)], ['manager', 'owner', false])
  assert.equal(T.closesOnDone(self), true)
  assert.equal(T.closesOnDone(toOwner), true)
  const at = '2026-10-07T10:00:00.000Z'
  const act = (task, action, role) => T.applyTaskAction({ status: 'open', events: [], ...task }, { action, role, by: 'x', at })
  const d = act(self, 'done', 'manager')
  assert.deepEqual([d.data.status, d.data.doneAt, d.data.closedAt, d.data.closedBy, d.event.kind], ['accepted', at, at, 'x', 'done'], 'себе — сразу закрыта')
  const o = act(toOwner, 'done', 'owner')
  assert.deepEqual([o.data.status, o.data.closedBy], ['accepted', 'x'])
  assert.throws(() => act(toOwner, 'progress', 'owner'), (e) => e.code === 'action_not_allowed')
  assert.throws(() => act(toOwner, 'done', 'manager'), (e) => e.code === 'action_not_allowed', 'задачу владельцу управляющая не закрывает')
  assert.throws(() => act(self, 'done', 'owner'), (e) => e.code === 'action_not_allowed')
  assert.throws(() => T.applyTaskAction({ status: 'accepted', ...self }, { action: 'undone', role: 'manager', by: 'x', at }), (e) => e.code === 'action_not_allowed')
  assert.throws(() => T.applyTaskAction({ status: 'accepted', ...self }, { action: 'cancel', role: 'manager', by: 'x', at }), (e) => e.code === 'bad_transition')
  assert.equal(T.applyTaskAction({ status: 'accepted', ...toOwner }, { action: 'reopen', role: 'manager', by: 'x', at }).data.status, 'open')
  assert.equal(T.applyTaskAction({ status: 'open', ...toOwner }, { action: 'cancel', role: 'manager', by: 'x', at }).data.status, 'cancelled')
  assert.throws(() => act(legacy, 'done', 'administrator'), (e) => e.code === 'action_not_allowed')
  // наружу — стороны всегда, со значениями по умолчанию у старых строк
  const row = T.taskRow({ documentId: 'a', title: 'x' })
  assert.deepEqual([row.assignee, row.createdByRole], ['manager', 'owner'])
})

test('s246 создание управляющей: себе и владельцу; карточка — своя по сессии; владелец себе — нет', async () => {
  const s = fresh()
  await expectErr(svc.create({ session: manager, body: { title: 'X' }, now }), 400, 'bad_assignee')
  await expectErr(svc.create({ session: manager, body: { title: 'X', assignee: 'admin' }, now }), 400, 'bad_assignee')
  await expectErr(svc.create({ session: owner, body: { title: 'X', personal: MARIIA, assignee: 'owner' }, now }), 400, 'bad_assignee')
  await expectErr(svc.create({ session: admin, body: { title: 'X', assignee: 'manager' }, now }), 403, 'not_allowed')
  const mine = (await svc.create({ session: manager, body: { title: 'Zavolat účetní', assignee: 'manager', personal: ANNA }, now })).task
  assert.deepEqual([mine.assignee, mine.createdByRole, mine.personal, mine.createdByName], ['manager', 'manager', MARIIA, 'Mariia Medvedeva'], '«personal» из тела не читается')
  assert.deepEqual(mine.events.map((e) => [e.kind, e.role]), [['created', 'manager']])
  const forOwner = (await svc.create({ session: manager, body: { title: 'Podepsat smlouvu', assignee: 'owner', dueDate: '2026-10-05', description: 'TAJNÉ' }, now })).task
  assert.deepEqual([forOwner.assignee, forOwner.createdByRole, forOwner.personal], ['owner', 'manager', MARIIA])
  const legacy = (await svc.create({ session: owner, body: { title: 'Od majitele', personal: MARIIA }, now })).task
  assert.deepEqual([legacy.assignee, legacy.createdByRole], ['manager', 'owner'])
  assert.deepEqual(s.logs.map((l) => l.summary), ['Nový vlastní úkol: Zavolat účetní', 'Nový úkol pro majitele: Podepsat smlouvu · do 05.10.2026', 'Nový úkol: Od majitele'])
  assert.ok(s.logs.every((l) => l.action === 'task_create' && l.entityType === 'task' && l.employeeName === 'Mariia Medvedeva'))
  assert.doesNotMatch(JSON.stringify(s.logs), /TAJNÉ/)
  // видимость: Марии — все три (её карточка), Анне — ничего, владельцу — все
  assert.equal((await svc.list({ session: manager, now })).tasks.length, 3)
  assert.equal((await svc.list({ session: anna, now })).tasks.length, 0)
  assert.equal((await svc.list({ session: owner, now })).tasks.length, 3)
  await expectErr(svc.act({ session: anna, id: forOwner.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found')
})

test('s246 путь задачи себе и задачи владельцу; правит только постановщик', async () => {
  const s = fresh()
  const mine = (await svc.create({ session: manager, body: { title: 'Vlastní', assignee: 'manager' }, now })).task
  const forOwner = (await svc.create({ session: manager, body: { title: 'Pro majitele', assignee: 'owner' }, now })).task
  const legacy = (await svc.create({ session: owner, body: { title: 'Od majitele', personal: MARIIA }, now })).task
  // правка: своё — да; чужое — 403 (и владельцу задачу управляющей не править)
  const ed = (await svc.update({ session: manager, id: forOwner.documentId, body: { priority: 'urgent' }, now })).task
  assert.deepEqual([ed.priority, ed.events.at(-1).kind, ed.events.at(-1).role], ['urgent', 'edited', 'manager'])
  await svc.update({ session: manager, id: mine.documentId, body: { title: 'Vlastní 2' }, now })
  await expectErr(svc.update({ session: manager, id: legacy.documentId, body: { title: 'Y' }, now }), 403, 'not_creator')
  await expectErr(svc.update({ session: owner, id: mine.documentId, body: { title: 'Y' }, now }), 403, 'not_creator')
  await expectErr(svc.update({ session: owner, id: forOwner.documentId, body: { title: 'Y' }, now }), 403, 'not_creator')
  assert.equal((await svc.update({ session: owner, id: legacy.documentId, body: { title: 'Od majitele 2' }, now })).task.title, 'Od majitele 2')
  // себе: hotovo — сразу закрыта; владелец только комментирует; вернуть — сама
  await expectErr(svc.act({ session: owner, id: mine.documentId, body: { action: 'done' }, now }), 403, 'action_not_allowed')
  await svc.act({ session: owner, id: mine.documentId, body: { action: 'comment', text: 'Ok' }, now })
  let r = (await svc.act({ session: manager, id: mine.documentId, body: { action: 'done' }, now })).task
  assert.deepEqual([r.status, r.closedBy], ['accepted', 'Mariia Medvedeva'])
  r = (await svc.act({ session: manager, id: mine.documentId, body: { action: 'reopen', text: 'Ještě ne' }, now })).task
  assert.equal(r.status, 'open')
  // владельцу: управляющая не закрывает; владелец — hotovo сразу закрывает; управляющая возвращает
  await expectErr(svc.act({ session: manager, id: forOwner.documentId, body: { action: 'done' }, now }), 403, 'action_not_allowed')
  r = (await svc.act({ session: owner, id: forOwner.documentId, body: { action: 'done', text: 'Podepsáno' }, now })).task
  assert.deepEqual([r.status, r.closedBy, r.events.at(-1).role], ['accepted', 'Dima', 'owner'])
  await expectErr(svc.update({ session: manager, id: forOwner.documentId, body: { title: 'Z' }, now }), 409, 'task_closed')
  r = (await svc.act({ session: manager, id: forOwner.documentId, body: { action: 'reopen', text: 'Chybí podpis' }, now })).task
  assert.equal(r.status, 'open')
  r = (await svc.act({ session: manager, id: forOwner.documentId, body: { action: 'cancel' }, now })).task
  assert.equal(r.status, 'cancelled')
  assert.equal(s.logs.filter((l) => l.action === 'task_done').length, 2)
})

test('s246 výkaz: в форме — задачи, где она исполнитель (и свои); задачи владельцу — нет', async () => {
  fresh()
  const mine = (await svc.create({ session: manager, body: { title: 'Vlastní', assignee: 'manager' }, now })).task
  const forOwner = (await svc.create({ session: manager, body: { title: 'Pro majitele', assignee: 'owner' }, now })).task
  const legacy = (await svc.create({ session: owner, body: { title: 'Od majitele', personal: MARIIA }, now })).task
  // старая строка без полей вовсе (до s246) — как поручение владельца
  globalThis.strapi.rows[TASK].push({ id: 99, documentId: 'old00000000000000000099', personalDocId: MARIIA, title: 'Stará', status: 'open', events: [], version: 1, createdAt: '2026-09-01T00:00:00Z' })
  const open = await svc.openFor(MARIIA, now)
  assert.deepEqual(open.map((t) => t.title).sort(), ['Od majitele', 'Stará', 'Vlastní'])
  assert.deepEqual(open.filter((t) => t.own).map((t) => t.title), ['Vlastní'])
  const ok = await svc.checkReportTasks(manager, [{ taskId: mine.documentId, done: true, note: '' }, { taskId: legacy.documentId, done: false, note: 'x' }])
  assert.equal(ok.length, 2)
  await expectErr(svc.checkReportTasks(manager, [{ taskId: forOwner.documentId, done: false, note: 'x' }]), 400, 'bad_tasks')
  // своя задача, отмеченная из отчёта, закрывается сразу
  await svc.applyReportTasks(manager, [], [{ taskId: mine.documentId, done: true, note: 'Hotovo' }], '2026-10-02', now)
  const after = globalThis.strapi.rows[TASK].find((t) => t.documentId === mine.documentId)
  assert.deepEqual([after.status, after.events.at(-1).reportDate], ['accepted', '2026-10-02'])
})

test('s246 «Сегодня»: владельцу — поручения управляющей и задачи от неё; управляющей — свои + ждут владельца', async () => {
  const s = fresh()
  const later = new Date('2026-10-05T10:00:00Z')
  await svc.create({ session: owner, body: { title: 'Od majitele', personal: MARIIA, dueDate: '2026-10-03' }, now })
  await svc.create({ session: manager, body: { title: 'Vlastní pozdě', assignee: 'manager', dueDate: '2026-10-03' }, now })
  await svc.create({ session: manager, body: { title: 'Majiteli pozdě', assignee: 'owner', dueDate: '2026-10-03' }, now })
  await svc.create({ session: manager, body: { title: 'Majiteli urgentní', assignee: 'owner', priority: 'urgent' }, now })
  const doneOne = (await svc.create({ session: manager, body: { title: 'Majiteli hotovo', assignee: 'owner' }, now })).task
  await svc.act({ session: owner, id: doneOne.documentId, body: { action: 'done' }, now })
  const o = await svc.attention({ session: owner, now: later })
  assert.deepEqual(o.overdue.map((x) => x.title), ['Od majitele'], 'своя задача управляющей и задачи владельцу — не в «Поручениях»')
  assert.equal(o.open, 1)
  assert.deepEqual([o.forMe.open, o.forMe.overdue], [2, 1])
  assert.deepEqual(o.forMe.list.map((x) => [x.title, x.personalName]), [['Majiteli pozdě', 'Mariia Medvedeva'], ['Majiteli urgentní', 'Mariia Medvedeva']])
  assert.equal(o.toOwner, undefined)
  const m = await svc.attention({ session: manager, now: later })
  assert.equal(m.open, 2, 'её в работе: от владельца и своя')
  assert.deepEqual(m.overdue.map((x) => x.title).sort(), ['Od majitele', 'Vlastní pozdě'])
  assert.deepEqual(m.toOwner, { open: 2, done: 1 })
  assert.equal(m.forMe, undefined)
  // выполненное владельцем больше 7 дней назад — не считается
  s.rows[TASK].find((t) => t.documentId === doneOne.documentId).closedAt = '2026-09-20T10:00:00.000Z'
  assert.equal((await svc.attention({ session: manager, now: later })).toOwner.done, 0)
  assert.equal((await svc.attention({ session: anna, now: later })).toOwner.open, 0)
})

test('s247 push: создание и действия отдают событие в manager-notify; сбой push не ломает поручение', async () => {
  const s = fresh()
  const legacy = (await svc.create({ session: owner, body: { title: 'Od majitele', personal: MARIIA }, now })).task
  const forOwner = (await svc.create({ session: manager, body: { title: 'Pro majitele', assignee: 'owner' }, now })).task
  await svc.act({ session: manager, id: legacy.documentId, body: { action: 'done', text: 'Hotovo  ' }, now })
  await svc.act({ session: owner, id: legacy.documentId, body: { action: 'reopen', text: 'Chybí foto' }, now })
  await svc.act({ session: owner, id: forOwner.documentId, body: { action: 'done' }, now })
  await tick()
  await tick()
  assert.deepEqual(
    s.pushes.map((p) => [p.id, p.kind, p.role, p.text ?? null, p.personal]),
    [
      [legacy.documentId, 'created', 'owner', null, MARIIA],
      [forOwner.documentId, 'created', 'manager', null, MARIIA],
      [legacy.documentId, 'done', 'manager', 'Hotovo', MARIIA],
      [legacy.documentId, 'reopen', 'owner', 'Chybí foto', MARIIA],
      [forOwner.documentId, 'done', 'owner', '', MARIIA],
    ],
    'событие несёт задачу ПОСЛЕ записи (с карточкой) и очищенный текст'
  )
  // сбой push — поручение создаётся и меняется как обычно
  s.failPush = true
  const t = (await svc.create({ session: owner, body: { title: 'Při výpadku', personal: MARIIA }, now })).task
  assert.equal(t.status, 'open')
  assert.equal((await svc.act({ session: manager, id: t.documentId, body: { action: 'done' }, now })).task.status, 'done')
  await tick()
  await tick()
  // сервис push недоступен вовсе (бросает синхронно) — тоже не ломает
  const orig = s.service
  s.service = (uid) => {
    if (uid === 'api::booking-engine.manager-notify') throw new Error('no service')
    return orig(uid)
  }
  assert.equal((await svc.create({ session: owner, body: { title: 'Bez služby', personal: MARIIA }, now })).task.status, 'open')
})

test('s258 удаление своей записи: бесследно — без события, журнала и push; чужое — 403', async () => {
  const s = fresh()
  const t = (await svc.create({ session: owner, body: { title: 'Nová lashmakerka', personal: MARIIA }, now })).task
  const at1 = new Date('2026-10-02T10:05:00Z')
  const at2 = new Date('2026-10-02T10:05:10Z')
  s.logAt = '2026-10-02T10:05:00.200Z'
  await svc.act({ session: owner, id: t.documentId, body: { action: 'comment', text: 'Podepsala smlouvu?' }, now: at1 })
  s.logAt = '2026-10-02T10:05:10.200Z'
  await svc.act({ session: manager, id: t.documentId, body: { action: 'progress', text: 'Zítra podepíšeme' }, now: at2 })
  await tick()
  await tick()
  const logsBefore = s.logs.length
  const pushesBefore = s.pushes.length
  assert.deepEqual(s.logs.map((l) => l.action), ['task_create', 'task_comment', 'task_progress'])

  // чужую — нельзя (и владельцу), не свою роль — тоже
  await expectErr(svc.removeEvent({ session: owner, id: t.documentId, body: { at: at2.toISOString() }, now }), 403, 'not_your_event')
  await expectErr(svc.removeEvent({ session: manager, id: t.documentId, body: { at: at1.toISOString() }, now }), 403, 'not_your_event')
  // «zadáno» и прочие события — не удаляются; несуществующее — 404
  const createdAt = s.rows[TASK][0].events[0].at
  await expectErr(svc.removeEvent({ session: owner, id: t.documentId, body: { at: createdAt }, now }), 404, 'event_not_found')
  await expectErr(svc.removeEvent({ session: owner, id: t.documentId, body: { at: 'x' }, now }), 404, 'event_not_found')
  await expectErr(svc.removeEvent({ session: admin, id: t.documentId, body: { at: at1.toISOString() }, now }), 403)
  await expectErr(svc.removeEvent({ session: anna, id: t.documentId, body: { at: at2.toISOString() }, now }), 404, 'task_not_found')

  // владелец — свой комментарий: ушёл из ленты, событие «удалено» не появилось, журнал о нём стёрт
  const r1 = await svc.removeEvent({ session: owner, id: t.documentId, body: { at: at1.toISOString() }, now })
  assert.deepEqual(r1.task.events.map((e) => e.kind), ['created', 'progress'])
  await tick()
  await tick()
  assert.deepEqual(s.logs.map((l) => l.action), ['task_create', 'task_progress'])
  assert.equal(s.logs.length, logsBefore - 1, 'новых записей журнала нет')
  assert.equal(s.pushes.length, pushesBefore, 'push нет')
  // повторно — уже нет
  await expectErr(svc.removeEvent({ session: owner, id: t.documentId, body: { at: at1.toISOString() }, now }), 404, 'event_not_found')

  // управляющая — свой průběh, в закрытой задаче тоже
  s.rows[TASK][0].status = 'accepted'
  const r2 = await svc.removeEvent({ session: manager, id: t.documentId, body: { at: at2.toISOString() }, now })
  assert.deepEqual(r2.task.events.map((e) => e.kind), ['created'])
  assert.deepEqual(s.logs.map((l) => l.action), ['task_create'])
  assert.equal(r2.task.version, s.rows[TASK][0].version, 'запись условная по version')

  // журнал не нашёлся / сбой журнала — запись всё равно удалена
  const at3 = new Date('2026-10-02T11:00:00Z')
  s.logAt = '2026-10-02T12:00:00.000Z'
  s.rows[TASK][0].status = 'open'
  await svc.act({ session: owner, id: t.documentId, body: { action: 'comment', text: 'Pozdní zápis' }, now: at3 })
  await tick()
  const r3 = await svc.removeEvent({ session: owner, id: t.documentId, body: { at: at3.toISOString() }, now })
  assert.deepEqual(r3.task.events.map((e) => e.kind), ['created'])
  assert.equal(s.logs.filter((l) => l.action === 'task_comment').length, 1, 'чужое окно времени — журнал не тронут')
})
