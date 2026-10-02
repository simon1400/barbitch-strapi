// Поручения владельца управляющей (services/owner-tasks.ts, s240 — §11 плана «Výkaz práce»):
//   - поля: название обязательно, срок не в прошлом (старый при правке можно оставить), приоритет из списка;
//   - статусы: open → done (исполнитель) → accepted (владелец); вернуть/отменить — владелец;
//     чужая роль или неверный статус — 403/409; ход работы и комментарий — с текстом;
//   - исполнитель видит только свои (чужое — 404), владелец — все; администратору/мастеру — 403;
//   - порядок: просроченные, срочные, по сроку; ждут владельца; закрытые свежие сверху;
//   - запись условная по version; журнал — entityType task, только название;
//   - заметки из отчёта: применяются только новые/изменившиеся, «hotovo» один раз;
//   - ручки: создать/править — requireOwner; остальное — requireStaff + роль в сервисе; REST нет.
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
      query: (uid) => ({
        async updateMany({ where, data }) {
          await tick();
          const rows = db[uid].filter((r) => matches(r, where));
          for (const r of rows) Object.assign(r, clone({ ...data, updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : data.updatedAt }));
          return { count: rows.length };
        },
      }),
    },
    service: (uid) => (assert.equal(uid, 'api::calendar-log.calendar-log'), { write: async (e) => void logs.push(e) }),
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
  r = (await svc.act({ session: owner, id, body: { action: 'accept' }, now })).task;
  assert.equal(r.status, 'accepted');
  assert.deepEqual(r.events.map((e) => e.kind), ['created', 'progress', 'done', 'reopen', 'done', 'accept']);
  await expectErr(svc.update({ session: owner, id, body: { title: 'Y' }, now }), 409, 'task_closed');
  assert.equal((await svc.list({ session: owner, now })).tasks.length, 0, 'принятое — не в активных');
  assert.equal((await svc.list({ session: owner, scope: 'closed', now })).tasks.length, 1);
  assert.deepEqual(s.logs.map((l) => l.action), ['task_create', 'task_progress', 'task_done', 'task_reopen', 'task_done', 'task_accept']);
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
    adminTaskCreate: ['POST', '/engine/admin/tasks', 'requireOwner'],
    adminTaskUpdate: ['PATCH', '/engine/admin/tasks/:id', 'requireOwner'],
    adminTaskAction: ['POST', '/engine/admin/tasks/:id/actions', 'requireStaff'],
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
