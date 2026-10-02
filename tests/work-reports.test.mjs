// «Výkaz práce» (services/work-reports.ts, s239): ежедневный отчёт управляющей владельцу.
//   - правила: часы 0,5–16 по полчаса, хотя бы один пункт и «co je hotovo», volno — только причина;
//   - день: не будущий, не раньше 01.10.2026 и не дальше 7 дней назад;
//   - вовремя — до 10:00 следующего дня (Прага, и летом, и зимой), позже — «pozdě»;
//   - ожидаемые дни — пн–пт без отпуска и volno; сегодня (и вчера до 10:00) без отчёта — «open», не «missing»;
//   - автор — только роль manager по СВОЕЙ карточке; владельцу 404, администратору и мастеру 403;
//   - правка после прочтения — снимок в history + бейдж, повторное прочтение бейдж снимает;
//   - запись условная по version (устаревшая — 409), двойная подача дня оставляет одну запись;
//   - журнал — entityType report, без текста отчёта;
//   - ручки владельца — под requireOwner, не requireManagement;
//   - Фаза 2 (s240): «Systém zaznamenal» — журналы по логину учётки за пражский день, действия
//     с výkazem не считаются, чужие логины не попадают; снимок в systemFacts при подаче;
//     сбой журналов не гасит отчёты; итог месяца по категориям пунктов.
// Сервис — НАСТОЯЩИЙ work-reports.ts (+ slots-core, staff-identity) на заглушке базы в памяти.
//
// Запуск: cd strapi && node --test tests/work-reports.test.mjs

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

const slotsUrl = dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'));
const identityUrl = dataUrl(toJs('src/utils/staff-identity.ts'));
const link = (file, pairs) => {
  let js = toJs(file);
  for (const [from, to] of pairs) {
    assert.ok(js.includes(from), `импорт ${from} не найден в ${file}`);
    js = js.split(from).join(to);
  }
  return js;
};
// поручения (s240) — настоящий owner-tasks.ts (+ private-files, диск в этих тестах не трогается)
const tasksUrl = dataUrl(
  link('src/api/booking-engine/services/owner-tasks.ts', [
    ["from './slots-core'", `from '${slotsUrl}'`],
    ["from '../../../utils/staff-identity'", `from '${identityUrl}'`],
    ["from '../../../utils/private-files'", `from '${dataUrl(toJs('src/utils/private-files.ts'))}'`],
  ])
);
const T = await import(tasksUrl);
const W = await import(
  dataUrl(
    link('src/api/booking-engine/services/work-reports.ts', [
      ["from './slots-core'", `from '${slotsUrl}'`],
      ["from '../../../utils/staff-identity'", `from '${identityUrl}'`],
      ["from './owner-tasks'", `from '${tasksUrl}'`],
    ])
  )
);
const svc = W.default;


const REPORT = 'api::work-report.work-report';
const PERSONAL = 'api::personal.personal';
const TIME_OFF = 'api::time-off.time-off';
const ADMIN = 'api::admin-user.admin-user';
const LOG = 'api::calendar-log.calendar-log';
const UPSELL = 'api::upsell-attempt.upsell-attempt';
const MERGE = 'api::client-merge-log.client-merge-log';
const TASK = 'api::owner-task.owner-task';
const TASK_FILE = 'api::owner-task-file.owner-task-file';

const MARIIA = 'mariia000000000000000001';
const KARINA = 'karina000000000000000002';
const OLD_MANAGER = 'oldmgr000000000000000003';

// ── заглушка базы ─────────────────────────────────────────────────────────────

const get = (row, key) => (key === 'personal' ? (row.personalDocId ? { documentId: row.personalDocId } : null) : row[key]);

const matchCond = (val, cond) => {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return val === cond;
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$eq') return val === arg;
    if (op === '$eqi') return String(val ?? '').toLowerCase() === String(arg).toLowerCase();
    if (op === '$gte') return val != null && val >= arg;
    if (op === '$lte') return val != null && val <= arg;
    if (op === '$in') return arg.includes(val);
    if (op === '$null') return arg ? val == null : val != null;
    // вложенное поле связи: personal: { documentId: {...} }
    return val != null && matchCond(val[op], arg);
  });
};
const matches = (row, filters = {}) => Object.entries(filters).every(([k, cond]) => matchCond(get(row, k), cond));

let idSeq = 1;
let docSeq = 1;
const tick = () => new Promise((r) => setImmediate(r));

function makeStrapi() {
  const db = {
    [PERSONAL]: [
      { id: 1, documentId: MARIIA, name: 'Mariia Medvedeva', position: 'manager', isActive: true },
      { id: 2, documentId: KARINA, name: 'Karina', position: 'master', isActive: true },
      { id: 3, documentId: OLD_MANAGER, name: 'Anna Stará', position: 'manager', isActive: false },
    ],
    [REPORT]: [],
    [TIME_OFF]: [],
    [ADMIN]: [
      { id: 1, username: 'Dima', personalDocId: null },
      { id: 11, username: 'Mariia Medvedeva', personalDocId: MARIIA },
      { id: 12, username: 'Vika', personalDocId: null },
      // несвязанная учётка с тем же именем — не её (связь важнее имени)
      { id: 14, username: 'mariia medvedeva', personalDocId: null },
    ],
    [LOG]: [],
    [UPSELL]: [],
    [MERGE]: [],
    [TASK]: [],
    [TASK_FILE]: [],
  };
  const logs = [];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const documents = (uid) => ({
    async findMany({ filters = {}, sort, limit } = {}) {
      await tick();
      let rows = db[uid].filter((r) => matches(r, filters));
      if (uid === REPORT) rows = rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
      if (uid === PERSONAL && sort) rows = rows.sort((a, b) => a.name.localeCompare(b.name));
      return clone(rows.slice(0, limit ?? 1000));
    },
    async findOne({ documentId, populate }) {
      await tick();
      const r = db[uid].find((x) => x.documentId === documentId);
      if (!r) return null;
      const out = clone(r);
      if (populate?.personal) out.personal = r.personalDocId ? { documentId: r.personalDocId, name: db[PERSONAL].find((p) => p.documentId === r.personalDocId)?.name } : null;
      return out;
    },
    async create({ data }) {
      await tick();
      const { personal, ...rest } = data;
      const row = {
        id: idSeq++,
        documentId: `report${String(docSeq++).padStart(17, '0')}`,
        personalDocId: personal,
        version: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...clone(rest),
      };
      db[uid].push(row);
      return clone(row);
    },
    async delete({ documentId }) {
      await tick();
      db[uid] = db[uid].filter((r) => r.documentId !== documentId);
    },
  });
  const strapi = {
    logs,
    documents,
    db: {
      query: (uid) => ({
        async findMany({ where = {}, limit }) {
          await tick();
          if (strapi.failFacts && uid !== ADMIN) throw new Error('journal down');
          // Date в условиях → ISO (в базе datetime, в заглушке строки)
          const iso = (v) => (v instanceof Date ? v.toISOString() : v);
          const ok = (val, cond) =>
            Object.entries(cond).every(([op, arg]) =>
              op === '$in' ? arg.includes(val) : op === '$gte' ? val >= iso(arg) : op === '$lt' ? val < iso(arg) : val === arg,
            );
          return clone(db[uid].filter((r) => Object.entries(where).every(([k, c]) => ok(r[k], c))).slice(0, limit ?? 1000));
        },
        async updateMany({ where, data }) {
          await tick();
          const rows = db[uid].filter((r) => matches(r, where));
          for (const r of rows) Object.assign(r, clone({ ...data, updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : data.updatedAt }));
          return { count: rows.length };
        },
      }),
    },
    service: (uid) => {
      if (uid === 'api::booking-engine.owner-tasks') return T.default;
      assert.equal(uid, 'api::calendar-log.calendar-log');
      return { write: async (e) => void logs.push(e) };
    },
    log: { error() {} },
  };
  strapi.rows = db;
  return strapi;
}

const manager = { id: 11, role: 'manager', username: 'Mariia Medvedeva', personalDocId: MARIIA };
const owner = { id: 1, role: 'owner', username: 'Dima' };
const admin = { id: 12, role: 'administrator', username: 'Vika' };
const master = { id: 13, role: 'master', username: 'Karina', personalDocId: KARINA };

/** Москва ни при чём: «сейчас» задаётся UTC, Прага в октябре — UTC+2, с 25.10 — UTC+1. */
const at = (iso) => new Date(iso);

const BODY = {
  hours: '7,5',
  items: [
    { category: 'staff', text: 'Pohovor s novou mistryní SECRET-ITEM' },
    { category: 'supplies', text: '   ' },
    { category: 'clients', text: 'Reklamace paní N.' },
  ],
  done: 'Objednávka u dodavatele odeslána SECRET-DONE',
  needsOwner: 'Schválit nákup křesla?',
  planTomorrow: 'Inventura',
};

const fresh = () => {
  globalThis.strapi = makeStrapi();
  return globalThis.strapi;
};
const reports = () => globalThis.strapi.rows[REPORT];

const expectErr = async (p, status, code) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.status, status, `status ${e.status} ${e.code}`);
    if (code) assert.equal(e.code, code);
    return true;
  });
};

// ── чистые функции ────────────────────────────────────────────────────────────

test('часы: 0,5–16 по полчаса, запятая допустима', () => {
  assert.equal(W.normalizeHours('7,5'), 7.5);
  assert.equal(W.normalizeHours(8), 8);
  assert.equal(W.normalizeHours('0.5'), 0.5);
  assert.equal(W.normalizeHours(16), 16);
  for (const bad of ['', null, undefined, 0, 0.25, 7.3, 16.5, 'abc', -1]) {
    assert.throws(() => W.normalizeHours(bad), (e) => e.code === 'bad_hours', String(bad));
  }
});

test('тело: пустые пункты выкидываются; без пунктов / без «hotovo» / чужая категория — 400', () => {
  const r = W.normalizeReportInput(BODY);
  assert.equal(r.status, 'submitted');
  assert.equal(r.hours, 7.5);
  assert.equal(r.items.length, 2);
  assert.equal(r.carried, '');
  assert.throws(() => W.normalizeReportInput({ ...BODY, items: [{ category: 'staff', text: ' ' }] }), (e) => e.code === 'items_required');
  assert.throws(() => W.normalizeReportInput({ ...BODY, done: '  ' }), (e) => e.code === 'done_required');
  assert.throws(() => W.normalizeReportInput({ ...BODY, items: [{ category: 'hacking', text: 'x' }] }), (e) => e.code === 'bad_category');
  assert.throws(() => W.normalizeReportInput({ ...BODY, done: 'x'.repeat(W.MAX_TEXT + 1) }), (e) => e.code === 'text_too_long');
  assert.throws(() => W.normalizeReportInput({ ...BODY, items: Array.from({ length: 21 }, () => ({ category: 'other', text: 'a' })) }), (e) => e.code === 'too_many_items');
  assert.throws(() => W.normalizeReportInput({ ...BODY, status: 'approved' }), (e) => e.code === 'bad_status');
  const off = W.normalizeReportInput({ status: 'day_off', dayOffReason: 'sick', hours: 8, done: 'ignored' });
  assert.deepEqual(off, { status: 'day_off', dayOffReason: 'sick', hours: null, items: [], done: '', carried: '', needsOwner: '', planTomorrow: '', taskNotes: [] });
  assert.throws(() => W.normalizeReportInput({ status: 'day_off', dayOffReason: 'party' }), (e) => e.code === 'bad_reason');
});

test('день отчёта: не будущий, не раньше 01.10.2026, не дальше 7 дней назад', () => {
  assert.equal(W.BACKFILL_DAYS, 7);
  assert.equal(W.checkReportDate('2026-10-12', '2026-10-12'), '2026-10-12');
  assert.equal(W.checkReportDate('2026-10-05', '2026-10-12'), '2026-10-05'); // ровно 7 дней — можно
  assert.throws(() => W.checkReportDate('2026-10-04', '2026-10-12'), (e) => e.code === 'too_old');
  assert.throws(() => W.checkReportDate('2026-10-13', '2026-10-12'), (e) => e.code === 'future_date');
  assert.throws(() => W.checkReportDate('2026-09-30', '2026-10-03'), (e) => e.code === 'too_old');
  assert.throws(() => W.checkReportDate('2026-02-30', '2026-10-03'), (e) => e.code === 'bad_date');
});

test('опоздание: до 10:00 следующего дня — вовремя, позже — поздно (летом и зимой)', () => {
  assert.equal(W.lateness('2026-10-01', at('2026-10-01T09:00:00Z')), 'on_time'); // в тот же день
  assert.equal(W.lateness('2026-10-01', at('2026-10-01T22:00:00Z')), 'on_time'); // 00:00 следующего
  assert.equal(W.lateness('2026-10-01', at('2026-10-02T07:59:00Z')), 'on_time'); // 09:59
  assert.equal(W.lateness('2026-10-01', at('2026-10-02T08:00:00Z')), 'late'); // 10:00
  assert.equal(W.lateness('2026-10-01', at('2026-10-05T08:00:00Z')), 'late');
  // зима (CET, UTC+1)
  assert.equal(W.lateness('2026-11-02', at('2026-11-03T08:59:00Z')), 'on_time');
  assert.equal(W.lateness('2026-11-02', at('2026-11-03T09:00:00Z')), 'late');
});

test('дни: выходные, отпуск, volno, «сегодня ещё можно», пропуск, до начала отсчёта', () => {
  const days = W.dayStates({
    from: '2026-09-29',
    to: '2026-10-09',
    today: '2026-10-07',
    reports: [
      { date: '2026-10-01', status: 'submitted', late: 'on_time', documentId: 'a' },
      { date: '2026-10-02', status: 'submitted', late: 'late', documentId: 'b' },
      { date: '2026-10-03', status: 'submitted', late: 'on_time', documentId: 'c' }, // суббота — можно
      { date: '2026-10-06', status: 'day_off', dayOffReason: 'other', documentId: 'd' },
    ],
    timeOffs: [{ startDate: '2026-10-05', endDate: '2026-10-05' }],
  });
  const s = Object.fromEntries(days.map((d) => [d.date, d.state]));
  assert.deepEqual(s, {
    '2026-09-29': 'before',
    '2026-09-30': 'before',
    '2026-10-01': 'on_time',
    '2026-10-02': 'late',
    '2026-10-03': 'on_time',
    '2026-10-04': 'weekend',
    '2026-10-05': 'time_off',
    '2026-10-06': 'day_off',
    '2026-10-07': 'open',
    '2026-10-08': 'future',
    '2026-10-09': 'future',
  });
  const before10 = W.dayStates({ from: '2026-10-07', to: '2026-10-08', today: '2026-10-08', reports: [], timeOffs: [], nowMin: 9 * 60 + 59 });
  assert.deepEqual(before10.map((d) => d.state), ['open', 'open'], 'вчера до 10:00 — ещё можно вовремя');
  const after10 = W.dayStates({ from: '2026-10-07', to: '2026-10-08', today: '2026-10-08', reports: [], timeOffs: [], nowMin: 10 * 60 });
  assert.deepEqual(after10.map((d) => d.state), ['missing', 'open']);
  const exp = days.filter((d) => d.expected).map((d) => d.date);
  assert.deepEqual(exp, ['2026-10-01', '2026-10-02', '2026-10-07']);
  const sum = W.summarize(days, [
    { date: '2026-10-01', status: 'submitted', hours: 8, rating: 4 },
    { date: '2026-10-02', status: 'submitted', hours: '7.5', rating: 5, reviewedAt: '2026-10-03T08:00:00Z' },
    { date: '2026-10-03', status: 'submitted', hours: 2 },
    { date: '2026-10-06', status: 'day_off' },
  ]);
  assert.equal(sum.expected, 2); // сегодня без отчёта не считается
  assert.equal(sum.submitted, 3);
  assert.equal(sum.late, 1);
  assert.equal(sum.dayOff, 1);
  assert.equal(sum.timeOff, 1);
  assert.equal(sum.hours, 17.5);
  assert.equal(sum.avgRating, 4.5);
  assert.equal(sum.unread, 2);
});

test('правка: до прочтения — без истории; после — снимок, бейдж; одинаковое содержимое — ничего', () => {
  const input = W.normalizeReportInput(BODY);
  const now = at('2026-10-01T18:00:00Z');
  const first = W.applyEdit(null, input, now, '2026-10-01');
  assert.equal(first.data.late, 'on_time');
  assert.equal(first.data.submittedAt, now.toISOString());
  const row = { ...first.data, date: '2026-10-01' };
  assert.equal(W.applyEdit(row, input, now, '2026-10-01').changed, false);
  const e1 = W.applyEdit(row, { ...input, hours: 8 }, at('2026-10-02T09:00:00Z'), '2026-10-01');
  assert.equal(e1.data.history, undefined);
  assert.equal(e1.data.submittedAt, undefined, 'время подачи и опоздание — один раз');
  const reviewed = { ...row, reviewedAt: '2026-10-02T07:00:00Z' };
  const e2 = W.applyEdit(reviewed, { ...input, hours: 8 }, at('2026-10-02T09:00:00Z'), '2026-10-01');
  assert.equal(e2.data.history.length, 1);
  assert.equal(e2.data.history[0].snapshot.hours, 7.5);
  assert.equal(W.editedAfterReview({ ...reviewed, ...e2.data }), true);
  assert.equal(W.editedAfterReview({ ...reviewed, ...e2.data, reviewedAt: '2026-10-02T10:00:00Z' }), false);
});

test('оценка 1–5 или null; комментарий обрезается; лишнее — 400', () => {
  assert.deepEqual(W.normalizeReview({ seen: true }), {});
  assert.deepEqual(W.normalizeReview({ rating: 3, comment: '  ok ' }), { rating: 3, comment: 'ok' });
  assert.deepEqual(W.normalizeReview({ rating: null }), { rating: null });
  for (const bad of [0, 6, 2.5, '5x']) assert.throws(() => W.normalizeReview({ rating: bad }), (e) => e.code === 'bad_rating');
  assert.throws(() => W.normalizeReview({ comment: 'x'.repeat(W.MAX_COMMENT + 1) }), (e) => e.code === 'comment_too_long');
});

test('сводка дня: пражские сутки, первое/последнее время, группы и действия; výkaz не считается', () => {
  const ev = W.factEventsOf({
    logs: [
      { entityType: 'booking', action: 'booking_create', createdAt: '2026-10-01T22:30:00Z' }, // 02.10 00:30
      { entityType: 'booking', action: 'booking_move', createdAt: '2026-10-02T15:10:00Z' },
      { entityType: 'booking', action: 'booking_create', createdAt: '2026-10-02T07:05:00Z' },
      { entityType: 'cost', action: 'cost_create', createdAt: '2026-10-02T09:00:00Z' },
      { entityType: 'report', action: 'report_submit', createdAt: '2026-10-02T16:00:00Z' },
      { entityType: 'mystery', action: 'x_y', createdAt: '2026-10-02T10:00:00Z' },
      { entityType: 'booking', action: 'booking_edit', createdAt: '2026-10-01T21:59:00Z' }, // 01.10 23:59
      { entityType: 'booking', action: 'booking_edit', createdAt: 'nonsense' },
    ],
    attempts: [{ outcome: 'declined', createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-02T11:00:00Z' }],
    merges: [{ action: 'merge', createdAt: '2026-10-02T12:00:00Z' }],
  });
  const by = W.factsByDay(ev);
  assert.deepEqual(Object.keys(by), ['2026-10-01', '2026-10-02']);
  assert.equal(by['2026-10-01'].total, 1);
  assert.equal(by['2026-10-01'].first, '23:59');
  const d = by['2026-10-02'];
  assert.equal(d.total, 7, 'отчёт и битая дата не считаются');
  assert.equal(d.first, '00:30');
  assert.equal(d.last, '17:10');
  assert.equal(d.groups[0].key, 'booking');
  assert.equal(d.groups[0].count, 3);
  assert.deepEqual(d.groups[0].actions, [
    { key: 'booking_create', label: 'nová rezervace', count: 2 },
    { key: 'booking_move', label: 'přesun', count: 1 },
  ]);
  const keys = d.groups.map((g) => g.key);
  for (const k of ['cost', 'upsell', 'dedupe', 'other']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('report') && !keys.includes('mystery'));
  assert.equal(d.groups.find((g) => g.key === 'upsell').actions[0].label, 'klient odmítl');
  assert.equal(d.groups.find((g) => g.key === 'other').actions[0].label, 'x_y', 'неизвестное — ключом');
  assert.deepEqual(W.buildFacts([]), { total: 0, first: null, last: null, groups: [] });
  // зимой (UTC+1) граница суток сдвигается
  assert.deepEqual(Object.keys(W.factsByDay([{ group: 'booking', action: 'a', at: '2026-11-01T23:30:00Z' }])), ['2026-11-02']);
});

test('логины человека: связанная учётка важнее имени; без связи — по имени; логины отчётов добавляются', () => {
  const accounts = [
    { username: 'Mariia Medvedeva', personalDocId: MARIIA },
    { username: 'mariia medvedeva', personalDocId: null },
    { username: 'Karina', personalDocId: null },
  ];
  assert.deepEqual(W.actorNamesFor({ documentId: MARIIA, name: 'Mariia Medvedeva' }, accounts), ['Mariia Medvedeva']);
  assert.deepEqual(W.actorNamesFor({ documentId: KARINA, name: 'karina' }, accounts), ['Karina']);
  assert.deepEqual(W.actorNamesFor({ documentId: MARIIA, name: 'X' }, accounts, ['Masha', '', null, 'Mariia Medvedeva']), [
    'Mariia Medvedeva',
    'Masha',
  ]);
  assert.deepEqual(W.actorNamesFor({ documentId: OLD_MANAGER, name: '' }, accounts), [], 'пустое имя не совпадает с пустым логином');
});

test('итог по категориям: пункты поданных отчётов, по убыванию', () => {
  const sub = (items) => ({ status: 'submitted', items });
  const t = W.categoryTotals([
    sub([{ category: 'staff', text: 'a' }, { category: 'clients', text: 'b' }, { category: 'staff', text: 'c' }]),
    sub([{ category: 'finance', text: 'd' }, { category: 'clients', text: 'e' }, { category: 'staff', text: 'f' }]),
  ]);
  assert.equal(t.items, 6);
  assert.deepEqual(t.categories.map((c) => [c.key, c.count]), [['staff', 3], ['clients', 2], ['finance', 1]]);
  assert.equal(t.categories[0].label, 'Personál');
});

// ── сервис ────────────────────────────────────────────────────────────────────

test('автор — только управляющая по своей карточке: владельцу 404, администратору и мастеру 403', async () => {
  fresh();
  const now = at('2026-10-01T18:00:00Z');
  await expectErr(svc.mine({ session: owner, now }), 404, 'no_card');
  await expectErr(svc.mine({ session: admin, now }), 403, 'not_allowed');
  await expectErr(svc.mine({ session: master, now }), 403, 'not_allowed');
  await expectErr(svc.saveMine({ session: admin, date: '2026-10-01', body: BODY, now }), 403, 'not_allowed');
  await expectErr(svc.mine({ session: { ...manager, personalDocId: 'nobody00000000000000000' }, now }), 404, 'no_card');
  const res = await svc.mine({ session: manager, now });
  assert.equal(res.name, 'Mariia Medvedeva');
  assert.equal(res.today, '2026-10-01');
  assert.equal(res.earliest, '2026-10-01');
  assert.equal(res.categories.length, 9);
});

test('подача: запись своей карточки, вовремя, журнал без текста; повтор того же — без записи', async () => {
  const s = fresh();
  const now = at('2026-10-01T18:00:00Z');
  const res = await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now });
  assert.equal(reports().length, 1);
  const r = reports()[0];
  assert.equal(r.personalDocId, MARIIA);
  assert.equal(r.kind, 'day');
  assert.equal(r.late, 'on_time');
  assert.equal(r.authorName, 'Mariia Medvedeva');
  assert.equal(res.saved.hours, 7.5);
  assert.equal(res.saved.items.length, 2);
  assert.equal(res.days.find((d) => d.date === '2026-10-01').state, 'on_time');
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].action, 'report_submit');
  assert.equal(s.logs[0].entityType, 'report');
  assert.equal(s.logs[0].employeeName, 'Mariia Medvedeva');
  assert.match(s.logs[0].summary, /01\.10\.2026: 7,5 h · bodů 2/);
  const v = r.version;
  await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now });
  assert.equal(reports()[0].version, v, 'то же содержимое — без записи');
  assert.equal(s.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(s.logs), /SECRET|Schválit|Inventura/, 'текст отчёта в журнал не попадает');
});

test('вовремя/поздно — по моменту первой подачи; правка этого не меняет', async () => {
  fresh();
  await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now: at('2026-10-02T07:30:00Z') }); // 09:30 след. дня
  await svc.saveMine({ session: manager, date: '2026-10-02', body: BODY, now: at('2026-10-03T08:30:00Z') }); // 10:30 след. дня
  const [a, b] = reports();
  assert.equal(a.late, 'on_time');
  assert.equal(b.late, 'late');
  await svc.saveMine({ session: manager, date: '2026-10-01', body: { ...BODY, hours: 6 }, now: at('2026-10-06T12:00:00Z') });
  assert.equal(reports()[0].late, 'on_time');
  assert.equal(reports()[0].hours, 6);
});

test('окно: будущее и старше 7 дней — 409, раньше 01.10.2026 — 409', async () => {
  fresh();
  const now = at('2026-10-20T10:00:00Z');
  await expectErr(svc.saveMine({ session: manager, date: '2026-10-21', body: BODY, now }), 409, 'future_date');
  await expectErr(svc.saveMine({ session: manager, date: '2026-10-12', body: BODY, now }), 409, 'too_old');
  await svc.saveMine({ session: manager, date: '2026-10-13', body: BODY, now });
  await expectErr(svc.saveMine({ session: manager, date: '2026-09-30', body: BODY, now: at('2026-10-01T10:00:00Z') }), 409, 'too_old');
  assert.equal(reports().length, 1);
});

test('volno: только причина, день не ждётся; потом можно подать отчёт', async () => {
  const s = fresh();
  const now = at('2026-10-02T18:00:00Z');
  const res = await svc.saveMine({ session: manager, date: '2026-10-02', body: { status: 'day_off', dayOffReason: 'vacation' }, now });
  assert.equal(res.days.find((d) => d.date === '2026-10-02').state, 'day_off');
  assert.equal(res.days.find((d) => d.date === '2026-10-02').expected, false);
  assert.equal(reports()[0].submittedAt, undefined);
  assert.equal(s.logs[0].action, 'report_day_off');
  const r2 = await svc.saveMine({ session: manager, date: '2026-10-02', body: BODY, now: at('2026-10-02T19:00:00Z') });
  assert.equal(r2.saved.status, 'submitted');
  assert.equal(r2.saved.late, 'on_time');
  assert.equal(s.logs[1].action, 'report_edit');
});

test('прочтение, оценка, комментарии; правка после прочтения → история и бейдж; новое прочтение снимает', async () => {
  const s = fresh();
  await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now: at('2026-10-01T18:00:00Z') });
  const id = reports()[0].documentId;
  let att = await svc.attention({ now: at('2026-10-02T06:00:00Z') });
  assert.equal(att.unread.length, 1);
  assert.equal(att.questions.length, 1);
  assert.equal(att.questions[0].text, 'Schválit nákup křesla?');

  const rv = await svc.review({ session: owner, id, body: { rating: 4, comment: 'Díky, křeslo ano' }, now: at('2026-10-02T06:30:00Z') });
  assert.equal(rv.saved.rating, 4);
  assert.equal(rv.saved.reviewedBy, 'Dima');
  assert.equal(rv.saved.comments.length, 1);
  assert.equal(rv.saved.comments[0].role, 'owner');
  att = await svc.attention({ now: at('2026-10-02T07:00:00Z') });
  assert.equal(att.unread.length, 0);
  assert.equal(att.questions.length, 0);

  const c = await svc.commentMine({ session: manager, date: '2026-10-01', body: { text: 'Objednám zítra' }, now: at('2026-10-02T07:10:00Z') });
  assert.equal(c.saved.comments.length, 2);
  assert.equal(c.saved.comments[1].role, 'manager');
  assert.equal(c.saved.reviewedAt !== null, true, 'ответ автора прочтение не снимает');

  const ed = await svc.saveMine({ session: manager, date: '2026-10-01', body: { ...BODY, hours: 9 }, now: at('2026-10-02T08:00:00Z') });
  assert.equal(ed.saved.history.length, 1);
  assert.equal(ed.saved.history[0].snapshot.hours, 7.5);
  assert.equal(ed.saved.editedAfterReview, true);
  assert.equal(ed.saved.rating, 4, 'оценка остаётся');
  att = await svc.attention({ now: at('2026-10-02T08:10:00Z') });
  assert.equal(att.unread.length, 1);
  assert.equal(att.unread[0].editedAfterReview, true);
  assert.match(s.logs.at(-1).summary, /upraveno po přečtení/);

  const rv2 = await svc.review({ session: owner, id, body: { seen: true }, now: at('2026-10-02T09:00:00Z') });
  assert.equal(rv2.saved.editedAfterReview, false);
  assert.equal(rv2.saved.history.length, 1);
  assert.equal(rv2.saved.rating, 4, 'просто «přečteno» оценку не трогает');
  const rv3 = await svc.review({ session: owner, id, body: { rating: null }, now: at('2026-10-02T09:05:00Z') });
  assert.equal(rv3.saved.rating, null);

  await expectErr(svc.review({ session: owner, id: 'nope', body: {}, now: at('2026-10-02T09:00:00Z') }), 404, 'report_not_found');
  await expectErr(svc.commentMine({ session: manager, date: '2026-10-05', body: { text: 'x' }, now: at('2026-10-05T09:00:00Z') }), 404, 'report_not_found');
  await expectErr(svc.commentMine({ session: manager, date: '2026-10-01', body: { text: '  ' }, now: at('2026-10-05T09:00:00Z') }), 400, 'comment_required');
  assert.doesNotMatch(JSON.stringify(s.logs), /SECRET|Díky|Objednám/, 'ни отчёт, ни комментарии в журнал не попадают');
});

test('запись условная: устаревшая версия — 409; двойная подача дня — одна запись', async () => {
  fresh();
  await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now: at('2026-10-01T18:00:00Z') });
  const stale = { ...reports()[0] };
  await svc.review({ session: owner, id: stale.documentId, body: { seen: true }, now: at('2026-10-02T06:00:00Z') });
  await expectErr(svc._write(stale, { comments: [] }, at('2026-10-02T06:01:00Z')), 409, 'report_changed');

  fresh();
  const now = at('2026-10-02T18:00:00Z');
  const res = await Promise.allSettled([
    svc.saveMine({ session: manager, date: '2026-10-02', body: BODY, now }),
    svc.saveMine({ session: manager, date: '2026-10-02', body: { ...BODY, hours: 5 }, now }),
  ]);
  assert.equal(reports().length, 1);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(res.find((r) => r.status === 'rejected').reason.code, 'report_changed');
});

test('владелец: список управляющих, месяц выбранной, итог; чужой id — первая работающая', async () => {
  const s = fresh();
  await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now: at('2026-10-01T18:00:00Z') });
  s.rows[TIME_OFF].push({ id: 1, documentId: 'to00000000000000000001', personalDocId: MARIIA, type: 'vacation', startDate: '2026-10-05', endDate: '2026-10-06' });
  const now = at('2026-10-08T12:00:00Z');
  const res = await svc.list({ month: '2026-10', now });
  assert.deepEqual(res.people.map((p) => p.name), ['Anna Stará', 'Mariia Medvedeva']);
  assert.equal(res.personal, MARIIA);
  assert.equal(res.reports.length, 1);
  const st = Object.fromEntries(res.days.map((d) => [d.date, d.state]));
  assert.equal(st['2026-10-02'], 'missing');
  assert.equal(st['2026-10-05'], 'time_off');
  assert.equal(st['2026-10-07'], 'missing');
  assert.equal(st['2026-10-08'], 'open');
  assert.equal(res.summary.expected, 3); // 1, 2, 7 (5–6 — отпуск, 8 — сегодня, ещё можно)
  assert.equal(res.summary.missing, 2);
  assert.equal(res.summary.timeOff, 2);
  const other = await svc.list({ month: '2026-10', personal: KARINA, now });
  assert.equal(other.personal, MARIIA, 'карточка не управляющей — не открывается');
  const old = await svc.list({ month: '2026-10', personal: OLD_MANAGER, now });
  assert.equal(old.personal, OLD_MANAGER);
  assert.equal(old.reports.length, 0);
  await expectErr(svc.list({ month: '2026-13', now }), 400, 'bad_month');

  const att = await svc.attention({ now });
  assert.deepEqual(att.missing.map((m) => m.date), ['2026-10-07', '2026-10-02']);
  assert.equal(att.todayState[0].state, 'open');
  assert.ok(att.missing.every((m) => m.personal === MARIIA), 'ушедшая управляющая — не в «Сегодня»');
  // до 10:00 вчерашний день ещё «можно вовремя» — не пропуск
  const early = await svc.attention({ now: at('2026-10-08T07:59:00Z') });
  assert.deepEqual(early.missing.map((m) => m.date), ['2026-10-02']);
  const earlyList = await svc.list({ month: '2026-10', now: at('2026-10-08T07:59:00Z') });
  assert.equal(earlyList.days.find((d) => d.date === '2026-10-07').state, 'open');
  assert.equal(earlyList.summary.expected, 2);
});

test('Systém zaznamenal: месяц по её логинам (и старому из отчёта), чужое не попадает; снимок при подаче', async () => {
  const s = fresh();
  const log = (actorName, action, entityType, createdAt) => s.rows[LOG].push({ actorName, action, entityType, createdAt });
  log('Mariia Medvedeva', 'booking_create', 'booking', '2026-10-01T08:00:00Z');
  log('Mariia Medvedeva', 'cost_create', 'cost', '2026-10-01T14:30:00Z');
  log('Mariia Medvedeva', 'block_create', 'block', '2026-10-02T09:00:00Z');
  log('Masha', 'staff_update', 'staff', '2026-10-01T10:00:00Z'); // прежний логин — виден по отчёту ниже
  log('mariia medvedeva', 'booking_delete', 'booking', '2026-10-01T09:00:00Z'); // чужая несвязанная учётка
  log('Vika', 'booking_create', 'booking', '2026-10-01T09:00:00Z');
  log('Mariia Medvedeva', 'booking_create', 'booking', '2026-09-30T12:00:00Z'); // прошлый месяц
  s.rows[UPSELL].push({ adminUsername: 'Mariia Medvedeva', outcome: 'not_offered', createdAt: '2026-10-01T15:00:00Z', updatedAt: '2026-10-01T15:00:00Z' });
  s.rows[MERGE].push({ actorName: 'Mariia Medvedeva', action: 'merge', createdAt: '2026-10-01T16:00:00Z' });
  s.rows[MERGE].push({ actorName: 'Dima', action: 'merge', createdAt: '2026-10-01T16:00:00Z' });
  // отчёт 30.09 (вне месяца) подан под старым логином
  s.rows[REPORT].push({ id: 99, documentId: 'oldrep00000000000000001', personalDocId: MARIIA, date: '2026-09-30', kind: 'day', status: 'day_off', dayOffReason: 'other', authorName: 'Masha', version: 1 });

  const now = at('2026-10-01T18:00:00Z');
  const res = await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now });
  const snap = reports().find((r) => r.date === '2026-10-01').systemFacts;
  assert.equal(snap.total, 5, 'бронь, затрата, карточка (старый логин), отметка дозаписи, дубли');
  assert.equal(snap.first, '10:00');
  assert.equal(snap.last, '18:00');
  assert.equal(snap.at, now.toISOString());
  assert.deepEqual(res.saved.systemFacts, snap);
  assert.equal(res.facts['2026-10-01'].total, 5);
  assert.equal(res.facts['2026-10-02'], undefined, 'будущее (относительно now) не читается');
  assert.equal(res.summary.system.days, 1);
  assert.equal(res.summary.items, 2);
  assert.deepEqual(res.summary.categories.map((c) => c.key), ['clients', 'staff']);

  // владелец видит ту же сводку
  const later = at('2026-10-03T12:00:00Z');
  const own = await svc.list({ month: '2026-10', now: later });
  assert.equal(own.facts['2026-10-01'].total, 5);
  assert.equal(own.facts['2026-10-02'].total, 1, 'день без отчёта — тоже');
  assert.equal(own.summary.system.actions, 6);
  const mine = await svc.mine({ session: manager, now: later });
  assert.deepEqual(mine.facts, own.facts);

  // повтор того же — без записи, снимок прежний; правка — снимок обновляется
  log('Mariia Medvedeva', 'booking_move', 'booking', '2026-10-01T19:00:00Z');
  await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now: at('2026-10-01T20:00:00Z') });
  assert.equal(reports().find((r) => r.date === '2026-10-01').systemFacts.total, 5);
  await svc.saveMine({ session: manager, date: '2026-10-01', body: { ...BODY, hours: 8 }, now: at('2026-10-01T20:00:00Z') });
  assert.equal(reports().find((r) => r.date === '2026-10-01').systemFacts.total, 6);
});

test('Systém zaznamenal: сбой журналов не гасит отчёты — facts null, подача без снимка', async () => {
  const s = fresh();
  s.failFacts = true;
  const now = at('2026-10-01T18:00:00Z');
  const res = await svc.saveMine({ session: manager, date: '2026-10-01', body: BODY, now });
  assert.equal(reports().length, 1);
  assert.equal(res.saved.systemFacts, null);
  assert.equal(res.facts, null);
  assert.equal(res.summary.system, null);
  assert.equal(res.summary.submitted, 1);
  const own = await svc.list({ month: '2026-10', now });
  assert.equal(own.facts, null);
  assert.equal(own.reports.length, 1);
});

test('поручения в отчёте: открытые в /mine, заметки и «hotovo» уходят в ленту поручения один раз; чужое — 400', async () => {
  const s = fresh();
  const at0 = '2026-09-30T10:00:00.000Z';
  const mk = (documentId, personalDocId, title, extra = {}) =>
    s.rows[TASK].push({ id: s.rows[TASK].length + 1, documentId, personalDocId, title, status: 'open', priority: 'normal', events: [], version: 1, createdAt: at0, ...extra });
  mk('task0000000000000000001', MARIIA, 'Objednat křeslo', { dueDate: '2026-10-05', priority: 'urgent' });
  mk('task0000000000000000002', MARIIA, 'Inventura');
  mk('task0000000000000000003', KARINA, 'Cizí úkol');
  mk('task0000000000000000004', MARIIA, 'Hotové dřív', { status: 'accepted' });
  const now = at('2026-10-01T18:00:00Z');
  const mine = await svc.mine({ session: manager, now });
  assert.deepEqual(mine.openTasks.map((t) => t.documentId), ['task0000000000000000001', 'task0000000000000000002'], 'срочное первым, принятые и чужие не видны');

  await expectErr(svc.saveMine({ session: manager, date: '2026-10-01', body: { ...BODY, tasks: [{ id: 'task0000000000000000003', done: true }] }, now }), 400, 'bad_tasks');
  assert.equal(reports().length, 0, 'чужое поручение — отчёт не записан');

  const body = { ...BODY, tasks: [{ id: 'task0000000000000000001', done: true, note: 'Objednáno u dodavatele' }, { id: 'task0000000000000000002', note: 'Začala jsem' }, { id: 'task0000000000000000002', note: 'dup' }] };
  const res = await svc.saveMine({ session: manager, date: '2026-10-01', body, now });
  assert.deepEqual(res.saved.taskNotes, [
    { taskId: 'task0000000000000000001', title: 'Objednat křeslo', note: 'Objednáno u dodavatele', done: true },
    { taskId: 'task0000000000000000002', title: 'Inventura', note: 'Začala jsem', done: false },
  ]);
  const t1 = s.rows[TASK][0];
  const t2 = s.rows[TASK][1];
  assert.equal(t1.status, 'done');
  assert.deepEqual(t1.events.map((e) => [e.kind, e.reportDate, e.text]), [['done', '2026-10-01', 'Objednáno u dodavatele']]);
  assert.deepEqual(t2.events.map((e) => e.kind), ['progress']);
  assert.ok(s.logs.some((l) => l.action === 'task_done' && l.entityType === 'task'));
  assert.equal(res.openTasks.find((t) => t.documentId === 'task0000000000000000001').status, 'done');

  // правка отчёта без изменения заметок — лента не дублируется; новая заметка — ещё одно событие
  await svc.saveMine({ session: manager, date: '2026-10-01', body: { ...body, hours: 8 }, now: at('2026-10-01T19:00:00Z') });
  assert.equal(t1.events.length, 1);
  assert.equal(t2.events.length, 1);
  await svc.saveMine({
    session: manager,
    date: '2026-10-01',
    body: { ...body, hours: 8, tasks: [body.tasks[0], { id: 'task0000000000000000002', note: 'Polovina hotová' }] },
    now: at('2026-10-01T19:30:00Z'),
  });
  assert.deepEqual(t2.events.map((e) => e.text), ['Začala jsem', 'Polovina hotová']);
  assert.equal(t1.events.length, 1);
  // поручение уже «hotovo» (ждёт владельца) — новая заметка из отчёта уходит комментарием, не теряется
  await svc.saveMine({
    session: manager,
    date: '2026-10-01',
    body: { ...body, hours: 8, tasks: [{ ...body.tasks[0], note: 'Doplnění: faktura' }, { id: 'task0000000000000000002', note: 'Polovina hotová' }] },
    now: at('2026-10-01T20:00:00Z'),
  });
  assert.deepEqual(t1.events.map((e) => [e.kind, e.text]), [['done', 'Objednáno u dodavatele'], ['comment', 'Doplnění: faktura']]);
  assert.equal(t1.status, 'done');
  // volno — без заметок
  const off = await svc.saveMine({ session: manager, date: '2026-10-02', body: { status: 'day_off', dayOffReason: 'sick', tasks: body.tasks }, now: at('2026-10-02T18:00:00Z') });
  assert.deepEqual(off.saved.taskNotes, []);
});

test('ручки: шесть роутов; чтение всех, прочтение и «Сегодня» — только владелец', () => {
  const routes = read('src/api/booking-engine/routes/booking-engine.ts');
  const ctrl = read('src/api/booking-engine/controllers/booking-engine.ts');
  const want = {
    adminWorkReportsMine: ['GET', '/engine/admin/work-reports/mine', 'requireStaff'],
    adminWorkReportSave: ['PUT', '/engine/admin/work-reports/mine/:date', 'requireStaff'],
    adminWorkReportComment: ['POST', '/engine/admin/work-reports/mine/:date/comments', 'requireStaff'],
    adminWorkReportsAttention: ['GET', '/engine/admin/work-reports/attention', 'requireOwner'],
    adminWorkReportsList: ['GET', '/engine/admin/work-reports', 'requireOwner'],
    adminWorkReportReview: ['POST', '/engine/admin/work-reports/:id/review', 'requireOwner'],
  };
  for (const [handler, [method, p, gate]] of Object.entries(want)) {
    assert.ok(routes.includes(`admin('${method}', '${p}', 'booking-engine.${handler}')`), `роут ${handler}`);
    const body = ctrl.split(`async ${handler}(ctx) {`)[1]?.split('\n  },')[0] || '';
    assert.ok(body.includes(`const session = ${gate}(ctx);`), `гейт ${handler} — ${gate}`);
  }
  // у коллекции нет REST-роутов и контроллера
  assert.equal(fs.existsSync(path.join(root, 'src/api/work-report/routes')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/api/work-report/controllers')), false);
  const schema = JSON.parse(read('src/api/work-report/content-types/work-report/schema.json'));
  assert.equal(schema.options.draftAndPublish, false);
  for (const f of ['personal', 'date', 'status', 'hours', 'items', 'done', 'late', 'history', 'reviewedAt', 'rating', 'comments', 'version']) {
    assert.ok(schema.attributes[f], `поле ${f}`);
  }
});
