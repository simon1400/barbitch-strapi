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
//   - s265: администраторка ставит задачу коллеге (не себе, не «всем»), стороны такой задачи — по
//     людям (исполнитель — карточка, автор — учётка), закрывается по «hotovo» без принятия; автор её
//     видит; переход `handover` — исполнительнице и руководству, только задача с карточкой в работе.
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
  ["from '../../../utils/staff-roster'", 'src/utils/staff-roster.ts'],
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
// s262: администраторки — Vika (связь по personalDocId), Olga (совместитель-мастер, связь по имени)
const VIKA = 'vika00000000000000000004';
const OLGA = 'olga00000000000000000005';
const ADMIN = 'api::admin-user.admin-user';

const owner = { id: 1, role: 'owner', username: 'Dima' };
const manager = { id: 11, role: 'manager', username: 'Mariia Medvedeva', personalDocId: MARIIA };
const anna = { id: 15, role: 'manager', username: 'Anna', personalDocId: ANNA };
const admin = { id: 12, role: 'administrator', username: 'Vika', personalDocId: VIKA };
const olga = { id: 16, role: 'administrator', username: 'Olga Eremina' };
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
const matches = (row, filters = {}) =>
  Object.entries(filters).every(([k, c]) => (k === '$or' ? c.some((f) => matches(row, f)) : matchCond(get(row, k), c)));

let seq = 1;
function fresh() {
  const db = {
    [PERSONAL]: [
      { documentId: MARIIA, name: 'Mariia Medvedeva', position: 'manager', isActive: true },
      { documentId: ANNA, name: 'Anna', position: 'manager', isActive: true },
      { documentId: OLD, name: 'Stará', position: 'manager', isActive: false },
      { documentId: VIKA, name: 'Viktoriia Tsybuliak', position: 'administrator', isActive: true },
      { documentId: OLGA, name: 'Olga Eremina', position: 'master', isActive: true },
    ],
    [ADMIN]: [
      { documentId: 'acc1', username: 'Vika', role: 'administrator', isActive: true, personalDocId: VIKA },
      { documentId: 'acc2', username: 'Olga Eremina', role: 'administrator', isActive: true, personalDocId: null },
      { documentId: 'acc3', username: 'Bez karty', role: 'administrator', isActive: true, personalDocId: null },
      { documentId: 'acc4', username: 'Stará admin', role: 'administrator', isActive: false, personalDocId: OLD },
      { documentId: 'acc5', username: 'Mariia Medvedeva', role: 'manager', isActive: true, personalDocId: MARIIA },
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
      // s265: смена исполнительницы при передаче — Document Service (связь)
      async update({ documentId, data }) {
        await tick();
        const r = db[uid].find((x) => x.documentId === documentId);
        const { personal, ...rest } = data;
        if (personal !== undefined) r.personalDocId = personal;
        Object.assign(r, clone(rest), { updatedAt: new Date().toISOString() });
        return clone(r);
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
  // s262: администраторка видит только задачи администраторам — поручения управляющей ей не видны
  assert.deepEqual((await svc.list({ session: admin, now })).tasks, [])
  await expectErr(svc.act({ session: admin, id: a.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found')
  await expectErr(svc.list({ session: master, now }), 403, 'not_allowed');
  await expectErr(svc.attention({ session: master, now }), 403, 'not_allowed');
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

test('s246 создание управляющей: себе и владельцу; карточка — своя по сессии', async () => {
  const s = fresh()
  await expectErr(svc.create({ session: manager, body: { title: 'X' }, now }), 400, 'bad_assignee')
  await expectErr(svc.create({ session: manager, body: { title: 'X', assignee: 'admin' }, now }), 400, 'bad_assignee')
  await expectErr(svc.create({ session: owner, body: { title: 'X', personal: MARIIA, assignee: 'admin' }, now }), 400, 'bad_assignee')
  // s265: администраторка ставит задачу только коллеге
  await expectErr(svc.create({ session: admin, body: { title: 'X', assignee: 'manager' }, now }), 400, 'bad_assignee')
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

test('s259 владелец ставит задачу себе: без карточки, управляющая не видит, закрывается по hotovo', async () => {
  const s = fresh()
  const own = (await svc.create({ session: owner, body: { title: 'Zavřít směnu adminům', assignee: 'owner', personal: MARIIA, dueDate: '2026-10-25' }, now })).task
  assert.deepEqual([own.assignee, own.createdByRole, own.personal, own.personalName], ['owner', 'owner', null, null], 'карточка из тела не берётся')
  assert.deepEqual(s.logs.map((l) => [l.summary, l.employeeName]), [['Nový vlastní úkol: Zavřít směnu adminům · do 25.10.2026', '']])
  assert.deepEqual(s.pushes.map((p) => [p.kind, p.role, p.personal]), [['created', 'owner', null]])
  // управляющей не видно ни в списке, ни по id, ни на «Сегодня»
  assert.equal((await svc.list({ session: manager, now })).tasks.length, 0)
  await expectErr(svc.act({ session: manager, id: own.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found')
  assert.equal((await svc.attention({ session: manager, now })).open, 0)
  // владельцу — в списке и в «forMe» на «Сегодня»; не среди поручений управляющей
  assert.deepEqual((await svc.list({ session: owner, now })).tasks.map((t) => t.documentId), [own.documentId])
  const att = await svc.attention({ session: owner, now })
  assert.deepEqual([att.open, att.forMe.open, att.forMe.list[0].personalName], [0, 1, null])
  // сам правит, hotovo — сразу закрыта, вернуть — сам
  assert.equal((await svc.update({ session: owner, id: own.documentId, body: { priority: 'urgent' }, now })).task.priority, 'urgent')
  await expectErr(svc.act({ session: owner, id: own.documentId, body: { action: 'progress', text: 'x' }, now }), 403, 'action_not_allowed')
  let r = (await svc.act({ session: owner, id: own.documentId, body: { action: 'done' }, now })).task
  assert.deepEqual([r.status, r.closedBy], ['accepted', 'Dima'])
  r = (await svc.act({ session: owner, id: own.documentId, body: { action: 'reopen' }, now })).task
  assert.equal(r.status, 'open')
  assert.equal((await svc.act({ session: owner, id: own.documentId, body: { action: 'cancel' }, now })).task.status, 'cancelled')
})

// ── s262: задачи администраторам ──────────────────────────────────────────────
test('s262 схема: enum assignee/createdByRole = стороны сервиса (иначе Strapi отвергнет запись)', () => {
  const sch = JSON.parse(read('src/api/owner-task/content-types/owner-task/schema.json'))
  assert.deepEqual([...sch.attributes.assignee.enum].sort(), [...T.SIDES].sort())
  // s265: постановщик — и администраторка (задача коллеге)
  assert.deepEqual([...sch.attributes.createdByRole.enum].sort(), ['administrator', 'manager', 'owner'])
  assert.match(read('types/generated/contentTypes.d.ts'), /assignee: Schema\.Attribute\.Enumeration<\['manager', 'owner', 'administrator'\]>/)
  assert.match(read('types/generated/contentTypes.d.ts'), /createdByRole: Schema\.Attribute\.Enumeration<\s*\['owner', 'manager', 'administrator'\]\s*>/)
})

test('s262 кому можно: работающие учётки administrator с карточкой (по связи или по имени)', async () => {
  fresh()
  assert.deepEqual(await svc._admins(), [
    { documentId: OLGA, name: 'Olga Eremina' },
    { documentId: VIKA, name: 'Viktoriia Tsybuliak' },
  ])
  const o = await svc.list({ session: owner, now })
  const m = await svc.list({ session: manager, now })
  const a = await svc.list({ session: admin, now })
  // s265: администраторке тоже — кому передать / поставить задачу (+ её карточка `me`)
  assert.deepEqual([o.admins.length, m.admins.length, a.admins.length, a.me, a.people, m.people], [2, 2, 2, VIKA, undefined, undefined])
})

test('s262 создание: владелец — конкретной, управляющая — всем; администраторка не ставит; чужая карточка — 400', async () => {
  const s = fresh()
  await expectErr(svc.create({ session: owner, body: { title: 'X', assignee: 'administrator' }, now }), 400, 'bad_personal')
  await expectErr(svc.create({ session: owner, body: { title: 'X', assignee: 'administrator', personal: MARIIA }, now }), 400, 'bad_personal')
  await expectErr(svc.create({ session: manager, body: { title: 'X', assignee: 'administrator', personal: OLD }, now }), 400, 'bad_personal')
  // s265: администраторка — только коллеге, не «всем»
  await expectErr(svc.create({ session: admin, body: { title: 'X', assignee: 'administrator', allAdmins: true }, now }), 400, 'bad_assignee')
  const one = (await svc.create({ session: owner, body: { title: 'Umýt vitrínu', assignee: 'administrator', personal: VIKA, dueDate: '2026-10-03' }, now })).task
  const all = (await svc.create({ session: manager, body: { title: 'Doplnit kávu', assignee: 'administrator', allAdmins: true, personal: VIKA }, now })).task
  assert.deepEqual([one.assignee, one.createdByRole, one.personal, one.personalName, one.allAdmins], ['administrator', 'owner', VIKA, 'Viktoriia Tsybuliak', false])
  assert.deepEqual([all.assignee, all.createdByRole, all.personal, all.allAdmins], ['administrator', 'manager', null, true], '«всем» — карточка из тела не берётся')
  assert.deepEqual(s.logs.map((l) => [l.summary, l.employeeName]), [
    ['Nový úkol pro administrátorku: Umýt vitrínu · do 03.10.2026', 'Viktoriia Tsybuliak'],
    ['Nový úkol pro všechny administrátorky: Doplnit kávu', ''],
  ])
  assert.deepEqual(s.pushes.map((p) => [p.kind, p.role, p.personal]), [['created', 'owner', VIKA], ['created', 'manager', null]])
})

test('s262 видимость и путь: исполнитель — администраторка, принимает постановщик, управляющая видит все', async () => {
  fresh()
  const mgr = (await svc.create({ session: owner, body: { title: 'Pro Mariiu', personal: MARIIA }, now })).task
  const one = (await svc.create({ session: owner, body: { title: 'Umýt vitrínu', assignee: 'administrator', personal: VIKA }, now })).task
  const all = (await svc.create({ session: manager, body: { title: 'Doplnit kávu', assignee: 'administrator', allAdmins: true }, now })).task
  const ids = async (session) => (await svc.list({ session, now })).tasks.map((t) => t.title).sort()
  assert.deepEqual(await ids(admin), ['Doplnit kávu', 'Umýt vitrínu'])
  assert.deepEqual(await ids(olga), ['Doplnit kávu'], 'чужая конкретная — не видна')
  assert.deepEqual(await ids(manager), ['Doplnit kávu', 'Pro Mariiu', 'Umýt vitrínu'])
  assert.deepEqual(await ids(anna), ['Doplnit kávu', 'Umýt vitrínu'], 'другая управляющая — задачи админов да, поручение Марии нет')
  await expectErr(svc.act({ session: olga, id: one.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found')
  await expectErr(svc.act({ session: admin, id: mgr.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found')
  // правит только постановщик
  await expectErr(svc.update({ session: admin, id: one.documentId, body: { title: 'Y' }, now }), 403, 'not_creator')
  await expectErr(svc.update({ session: manager, id: one.documentId, body: { title: 'Y' }, now }), 403, 'not_creator')
  // конкретная: průběh → hotovo (ждёт) → снять → hotovo → управляющая не принимает, владелец принимает
  await svc.act({ session: admin, id: one.documentId, body: { action: 'progress', text: 'Půlka hotová' }, now: new Date('2026-10-02T10:05:00Z') })
  let r = (await svc.act({ session: admin, id: one.documentId, body: { action: 'done' }, now })).task
  assert.equal(r.status, 'done', 'ждёт постановщика')
  r = (await svc.act({ session: admin, id: one.documentId, body: { action: 'undone' }, now })).task
  assert.equal(r.status, 'open')
  await svc.act({ session: admin, id: one.documentId, body: { action: 'done' }, now })
  await expectErr(svc.act({ session: manager, id: one.documentId, body: { action: 'accept' }, now }), 403, 'action_not_allowed')
  await svc.act({ session: manager, id: one.documentId, body: { action: 'comment', text: 'Vidím' }, now })
  r = (await svc.act({ session: owner, id: one.documentId, body: { action: 'accept' }, now })).task
  assert.deepEqual([r.status, r.closedBy], ['accepted', 'Dima'])
  // общая: закрывает любая (Olga), принимает управляющая; владелец только комментирует
  r = (await svc.act({ session: olga, id: all.documentId, body: { action: 'done', text: 'Doplněno' }, now })).task
  assert.deepEqual([r.status, r.events.at(-1).by, r.events.at(-1).role], ['done', 'Olga Eremina', 'administrator'])
  await expectErr(svc.act({ session: owner, id: all.documentId, body: { action: 'accept' }, now }), 403, 'action_not_allowed')
  await expectErr(svc.act({ session: admin, id: all.documentId, body: { action: 'accept' }, now }), 403, 'action_not_allowed')
  r = (await svc.act({ session: manager, id: all.documentId, body: { action: 'reopen', text: 'Ještě cukr' }, now })).task
  assert.equal(r.status, 'open')
  // свой průběh администраторка удаляет сама; управляющая — нет (чужой)
  const prog = (await svc.list({ session: admin, now, scope: 'all' })).tasks.find((t) => t.documentId === one.documentId).events.find((e) => e.kind === 'progress')
  await expectErr(svc.removeEvent({ session: manager, id: one.documentId, body: { at: prog.at }, now }), 403, 'not_your_event')
  const after = (await svc.removeEvent({ session: admin, id: one.documentId, body: { at: prog.at }, now })).task
  assert.equal(after.events.some((e) => e.kind === 'progress'), false)
})

test('s262 «Сегодня»: администраторке — её и общие в работе; управляющей — ждут её и просроченные; владельцу — его поручения', async () => {
  fresh()
  const one = (await svc.create({ session: owner, body: { title: 'Vitrína', assignee: 'administrator', personal: VIKA, dueDate: '2026-10-03' }, now })).task
  const all = (await svc.create({ session: manager, body: { title: 'Káva', assignee: 'administrator', allAdmins: true, priority: 'urgent' }, now })).task
  const fromMgr = (await svc.create({ session: manager, body: { title: 'Pro Olgu', assignee: 'administrator', personal: OLGA }, now })).task
  await svc.act({ session: olga, id: fromMgr.documentId, body: { action: 'done' }, now })
  const later = new Date('2026-10-05T10:00:00Z')
  const a = await svc.attention({ session: admin, now: later })
  assert.deepEqual([a.role, a.open, a.overdue.map((x) => x.title), a.urgent.map((x) => x.title), a.next.map((x) => x.title)], ['administrator', 2, ['Vitrína'], ['Káva'], ['Vitrína', 'Káva']])
  assert.equal(a.next[1].allAdmins, true)
  assert.equal(a.forMe, undefined)
  const m = await svc.attention({ session: manager, now: later })
  assert.deepEqual([m.open, m.admins.open, m.admins.waiting.map((x) => x.title), m.admins.overdue.map((x) => x.title)], [0, 2, ['Pro Olgu'], ['Vitrína']])
  const o = await svc.attention({ session: owner, now: later })
  assert.deepEqual([o.open, o.overdue.map((x) => x.title), o.waiting], [1, ['Vitrína'], []], 'задачи управляющей админам — не его поручения')
  await svc.act({ session: admin, id: one.documentId, body: { action: 'done' }, now: later })
  assert.deepEqual((await svc.attention({ session: owner, now: later })).waiting.map((x) => x.title), ['Vitrína'])
  assert.ok(all)
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
  await expectErr(svc.removeEvent({ session: admin, id: t.documentId, body: { at: at1.toISOString() }, now }), 404, 'task_not_found')
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

// ── s265: задачи коллеге и передача ─────────────────────────────────────────
test('s265 стороны задачи коллеге — по людям: автор возвращает/отменяет/правит, исполнительница делает; handover', () => {
  const task = { status: 'open', assignee: 'administrator', createdByRole: 'administrator', createdByAccountId: 12, createdByName: 'Vika', personal: { documentId: OLGA } }
  const vika = { role: 'administrator', personal: { documentId: VIKA }, accountId: 12, login: 'Vika' }
  const olgaW = { role: 'administrator', personal: { documentId: OLGA }, accountId: 16, login: 'Olga Eremina' }
  const keys = (t, role, who) => Object.keys(T.transitionsFor(t, role, who)).sort().join()
  assert.equal(keys(task, 'administrator', vika), 'cancel,comment,reopen', 'автор: вернуть/отменить, не «hotovo»')
  assert.equal(keys(task, 'administrator', olgaW), 'comment,done,handover,progress', 'исполнительница: hotovo, průběh, передать; не undone — принимать некому')
  assert.equal(T.transitionsFor(task, 'administrator', olgaW).done.to, 'accepted', 'закрывается сразу')
  assert.equal(keys(task, 'manager', null), 'comment,handover', 'руководство — комментарий и передача')
  assert.equal(keys(task, 'owner', null), 'comment,handover')
  // старые задачи s262 (от владельца) — исполнительнице добавилась передача, общие — без неё
  const fromOwner = { status: 'open', assignee: 'administrator', createdByRole: 'owner', personal: { documentId: VIKA } }
  assert.equal(keys(fromOwner, 'administrator', vika), 'comment,done,handover,progress,undone')
  assert.equal(keys(fromOwner, 'owner', null), 'accept,cancel,comment,handover,reopen')
  assert.equal(keys({ ...fromOwner, personal: null }, 'administrator', vika), 'comment,done,progress,undone', 'общую не передать')
  assert.equal(keys({ ...fromOwner, status: 'done' }, 'administrator', vika).includes('handover'), true, 'в таблице есть, статус проверит applyTaskAction')
  assert.throws(() => T.applyTaskAction({ ...fromOwner, status: 'done' }, { action: 'handover', role: 'administrator', who: vika, by: 'Vika', at: 'x', to: { documentId: OLGA, name: 'Olga' } }), (e) => e.code === 'bad_transition')
  assert.throws(() => T.applyTaskAction(fromOwner, { action: 'handover', role: 'administrator', who: vika, by: 'Vika', at: 'x', to: { documentId: VIKA, name: 'V' } }), (e) => e.code === 'same_person')
  // автор без учётки в строке — по логину
  assert.equal(T.isAuthor({ createdByName: 'vika' }, vika), true)
  assert.equal(T.isAuthor({ createdByAccountId: 99, createdByName: 'Vika' }, vika), false, 'учётка главнее логина')
})

test('s265 администраторка ставит задачу коллеге: не себе, не «всем»; видят обе; закрывается по hotovo; push автору', async () => {
  const s = fresh()
  await expectErr(svc.create({ session: admin, body: { title: 'X', assignee: 'administrator', personal: VIKA }, now }), 400, 'self_task')
  await expectErr(svc.create({ session: admin, body: { title: 'X', assignee: 'administrator', personal: MARIIA }, now }), 400, 'bad_personal')
  await expectErr(svc.create({ session: admin, body: { title: 'X', assignee: 'owner' }, now }), 400, 'bad_assignee')
  const t = (await svc.create({ session: admin, body: { title: 'Objednat kávu', assignee: 'administrator', personal: OLGA }, now })).task
  assert.deepEqual([t.assignee, t.createdByRole, t.personal, t.createdByName, t.byMe, t.forMe], ['administrator', 'administrator', OLGA, 'Vika', true, false])
  assert.equal(s.rows[TASK][0].createdByAccountId, 12)
  assert.deepEqual(s.logs.map((l) => [l.summary, l.employeeName]), [['Nový úkol pro kolegyni: Objednat kávu', 'Olga Eremina']])
  assert.deepEqual(s.pushes.map((p) => [p.kind, p.role, p.by, p.personal]), [['created', 'administrator', 'Vika', OLGA]])
  // видят: автор, исполнительница, руководство
  const seen = async (session) => (await svc.list({ session, now })).tasks.map((x) => [x.title, x.byMe, x.forMe])
  assert.deepEqual(await seen(admin), [['Objednat kávu', true, false]])
  assert.deepEqual(await seen(olga), [['Objednat kávu', false, true]])
  assert.equal((await svc.list({ session: manager, now })).tasks.length, 1)
  // «Сегодня»: у исполнительницы — в работе, у автора — нет
  assert.deepEqual([(await svc.attention({ session: olga, now })).open, (await svc.attention({ session: admin, now })).open], [1, 0])
  // автор не отмечает «hotovo», исполнительница не правит и не отменяет
  await expectErr(svc.act({ session: admin, id: t.documentId, body: { action: 'done' }, now }), 403, 'action_not_allowed')
  await expectErr(svc.update({ session: olga, id: t.documentId, body: { title: 'Y' }, now }), 403, 'not_creator')
  await expectErr(svc.act({ session: olga, id: t.documentId, body: { action: 'cancel' }, now }), 403, 'action_not_allowed')
  assert.equal((await svc.update({ session: admin, id: t.documentId, body: { dueDate: '2026-10-03' }, now })).task.dueDate, '2026-10-03')
  const r = (await svc.act({ session: olga, id: t.documentId, body: { action: 'done', text: 'Objednáno' }, now })).task
  assert.deepEqual([r.status, r.closedBy], ['accepted', 'Olga Eremina'], 'без принятия')
  assert.deepEqual(s.pushes.at(-1), { id: t.documentId, personal: OLGA, kind: 'done', role: 'administrator', text: 'Objednáno', by: 'Olga Eremina' })
  // вернуть может автор
  assert.equal((await svc.act({ session: admin, id: t.documentId, body: { action: 'reopen', text: 'Ještě mléko' }, now })).task.status, 'open')
  // quiet — без push (передача смены шлёт сводку сама)
  const before = s.pushes.length
  await svc.create({ session: admin, body: { title: 'Tiše', assignee: 'administrator', personal: OLGA }, now, quiet: true })
  assert.equal(s.pushes.length, before)
})

test('s265 передача задачи: исполнительница → коллеге, руководство — в любую сторону; общие и чужие — нет', async () => {
  const s = fresh()
  const one = (await svc.create({ session: owner, body: { title: 'Vitrína', assignee: 'administrator', personal: VIKA }, now })).task
  const all = (await svc.create({ session: manager, body: { title: 'Káva', assignee: 'administrator', allAdmins: true }, now })).task
  s.logs.length = 0
  s.pushes.length = 0
  await expectErr(svc.act({ session: admin, id: one.documentId, body: { action: 'handover', to: MARIIA }, now }), 400, 'bad_personal')
  await expectErr(svc.act({ session: admin, id: one.documentId, body: { action: 'handover', to: VIKA }, now }), 400, 'same_person')
  await expectErr(svc.act({ session: admin, id: all.documentId, body: { action: 'handover', to: OLGA }, now }), 403, 'action_not_allowed')
  await expectErr(svc.act({ session: olga, id: one.documentId, body: { action: 'handover', to: OLGA }, now }), 404, 'task_not_found')
  const r = (await svc.act({ session: admin, id: one.documentId, body: { action: 'handover', to: OLGA, text: 'Chybí jen sklo' }, now, quiet: 'assignee' })).task
  assert.deepEqual([r.status, r.personal, r.personalName], ['open', OLGA, 'Olga Eremina'], 'статус тот же, исполнительница новая')
  assert.deepEqual(r.events.at(-1), { at: now.toISOString(), kind: 'handover', by: 'Vika', role: 'administrator', text: 'Chybí jen sklo', from: 'Viktoriia Tsybuliak', to: 'Olga Eremina', toPersonal: OLGA })
  assert.equal(r.version, 2)
  assert.deepEqual(s.logs.map((l) => [l.action, l.summary, l.employeeName]), [['task_handover', 'Úkol předán: Vitrína · Viktoriia Tsybuliak → Olga Eremina', 'Olga Eremina']])
  assert.deepEqual(s.pushes.map((p) => [p.kind, p.from, p.quiet, p.personal]), [['handover', 'Viktoriia Tsybuliak', 'assignee', OLGA]])
  // у прежней — больше не видна; у новой — её
  await expectErr(svc.act({ session: admin, id: one.documentId, body: { action: 'comment', text: 'x' }, now }), 404, 'task_not_found')
  assert.equal((await svc.list({ session: olga, now })).tasks.find((x) => x.documentId === one.documentId).forMe, true)
  // руководство возвращает (управляющая — и на задаче владельца)
  const back = (await svc.act({ session: manager, id: one.documentId, body: { action: 'handover', to: VIKA }, now })).task
  assert.equal(back.personal, VIKA)
  // сделанную не передать
  await svc.act({ session: admin, id: one.documentId, body: { action: 'done' }, now })
  await expectErr(svc.act({ session: admin, id: one.documentId, body: { action: 'handover', to: OLGA }, now }), 409, 'bad_transition')
})
