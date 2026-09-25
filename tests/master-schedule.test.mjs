// Плановый график мастеров (services/master-schedule.ts, s218): эффективный день
// (исключение важнее шаблона, шаблон с даты), день → блоки на окно салона,
// идемпотентный reconcile (прошлое не трогается, окно = часы салона), роли
// (администратор пишет только предложения), согласование, брони в новом
// нерабочем времени, старые серии под замену и журнал. Сервис — НАСТОЯЩИЙ, на
// заглушке document service в памяти; slots-core — настоящий (пражское время, DST).
//
// Запуск: cd strapi && node --test tests/master-schedule.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '../src/api/booking-engine/services');
const transpile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const coreUrl = dataUrl(transpile('slots-core.ts'));
const svcJs = transpile('master-schedule.ts').split("from './slots-core'").join(`from '${coreUrl}'`);
assert.ok(svcJs.includes(coreUrl), 'импорт slots-core подменён');
const M = await import(dataUrl(svcJs));
const svc = M.default;
const core = await import(coreUrl);

const NOW = new Date('2026-09-25T10:00:00Z'); // пятница, Прага 12:00
const MANAGER = { username: 'Mariia Medvedeva', role: 'manager' };
const OWNER = { username: 'Dima', role: 'owner' };
const ADMIN = { username: 'Yuliya Popchanka', role: 'administrator' };

const VERONIKA = 'veronikaaaaaaaaaaaaaaaaa';
const KARINA = 'karinaaaaaaaaaaaaaaaaaaa';
const MARIIA = 'mariiaaaaaaaaaaaaaaaaaaa';
const GONE = 'goneaaaaaaaaaaaaaaaaaaaa';
const PERSONALS = [
  { documentId: KARINA, name: 'Karina Kamaeva', position: 'master', isActive: true, noonaEmployeeId: 'N_KARINA', calendarOrder: 30 },
  { documentId: VERONIKA, name: 'Veronika Simonova', position: 'master', isActive: true, noonaEmployeeId: 'N_VERONIKA', calendarOrder: 50 },
  { documentId: MARIIA, name: 'Mariia Medvedeva', position: 'manager', isActive: true, noonaEmployeeId: 'N_MARIIA', calendarOrder: 10 },
  { documentId: GONE, name: '❌ Daryna', position: 'master', isActive: true, noonaEmployeeId: 'N_GONE', calendarOrder: 90 },
];

// ── заглушка document service ─────────────────────────────────────────────
const matchCond = (val, cond) => {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === '$eq' && val !== arg) return false;
      else if (op === '$gte' && !(val != null && val >= arg)) return false;
      else if (op === '$lte' && !(val != null && val <= arg)) return false;
      else if (op === '$in' && !arg.includes(val)) return false;
      else if (op === '$null' && (val == null) !== arg) return false;
      else if (op === '$notNull' && (val != null) !== arg) return false;
      else if (!op.startsWith('$') && !matchCond(val?.[op], arg)) return false;
    }
    return true;
  }
  return val === cond;
};
const match = (row, filters) => {
  if (!filters) return true;
  for (const [k, v] of Object.entries(filters)) {
    if (k === '$or') {
      if (!v.some((f) => match(row, f))) return false;
    } else if (!matchCond(row[k], v)) return false;
  }
  return true;
};

function makeStrapi({ hoursUntil = '2026-12-24', blocks = [], bookings = [], timeOffs = [], closed = [] } = {}) {
  let seq = 0;
  let clock = Date.parse('2026-09-20T08:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const byId = Object.fromEntries(PERSONALS.map((p) => [p.documentId, p]));
  const hours = [];
  for (let d = '2026-06-16'; d <= hoursUntil; d = M.addDaysYmd(d, 1)) {
    hours.push(closed.includes(d) ? { documentId: `h${d}`, date: d, openMin: null, closeMin: null } : { documentId: `h${d}`, date: d, openMin: 600, closeMin: 1140 });
  }
  const db = {
    'api::personal.personal': PERSONALS.map((p) => ({ ...p })),
    'api::salon-hour.salon-hour': hours,
    'api::time-block.time-block': blocks.map((b, i) => ({
      documentId: `blk${String(i).padStart(21, '0')}`,
      approvalStatus: 'approved',
      ...b,
      employee: b.employee ? { documentId: b.employee } : null,
    })),
    'api::booking.booking': bookings.map((b, i) => ({
      documentId: `bkg${String(i).padStart(21, '0')}`,
      status: 'active',
      ...b,
      employee: b.employee ? { documentId: b.employee } : null,
    })),
    'api::time-off.time-off': timeOffs.map((t, i) => ({
      documentId: `tof${String(i).padStart(21, '0')}`,
      ...t,
      personal: t.personal ? { documentId: t.personal } : null,
    })),
    'api::master-schedule.master-schedule': [],
  };
  const logs = [];
  const telegrams = [];
  const writes = [];
  const withRel = (uid, r, q) => {
    const out = { ...r };
    for (const rel of ['personal', 'employee']) {
      if (r[rel]?.documentId) {
        const p = byId[r[rel].documentId];
        out[rel] = q.populate?.[rel] ? { documentId: r[rel].documentId, ...(p || {}) } : r[rel];
      }
    }
    return structuredClone(out);
  };
  const docs = (uid) => ({
    async findMany(q = {}) {
      let list = db[uid].filter((r) => match(r, q.filters));
      if (uid === 'api::personal.personal' && q.status && q.status !== 'published') list = [];
      const sort = Array.isArray(q.sort) ? q.sort : q.sort ? [q.sort] : [];
      for (const s of [...sort].reverse()) {
        const [f, dir] = s.split(':');
        list = [...list].sort((a, b) => (String(a[f] ?? '') < String(b[f] ?? '') ? -1 : String(a[f] ?? '') > String(b[f] ?? '') ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return list.slice(0, q.limit ?? 25).map((r) => withRel(uid, r, q));
    },
    async findOne(q) {
      const r = db[uid].find((x) => x.documentId === q.documentId);
      return r ? withRel(uid, r, q) : null;
    },
    async create(q) {
      const documentId = `${uid.split('.')[1].slice(0, 4)}${String(++seq).padStart(20, '0')}`;
      const at = tick();
      const row = { documentId, ...structuredClone(q.data), createdAt: at, updatedAt: at };
      db[uid].push(row);
      writes.push(['create', uid, row]);
      return { documentId };
    },
    async update(q) {
      const r = db[uid].find((x) => x.documentId === q.documentId);
      Object.assign(r, structuredClone(q.data), { updatedAt: tick() });
      writes.push(['update', uid, q.documentId]);
      return { documentId: q.documentId };
    },
    async delete(q) {
      const i = db[uid].findIndex((x) => x.documentId === q.documentId);
      if (i >= 0) db[uid].splice(i, 1);
      writes.push(['delete', uid, q.documentId]);
    },
  });
  globalThis.strapi = {
    documents: docs,
    log: { info() {}, error() {}, warn() {} },
    service: (name) => {
      if (name === 'api::calendar-log.calendar-log') return { write: async (e) => logs.push(e) };
      if (name === 'api::booking-engine.booking-notify') return { sendTelegram: async (t) => telegrams.push(t) };
      throw new Error(`unexpected service ${name}`);
    },
  };
  const planBlocks = (pid) =>
    db['api::time-block.time-block']
      .filter((b) => b.noonaKey === M.planKeyOf(pid))
      .map((b) => ({ date: b.date, s: core.utcToPragueMinClamped(b.startsAt, b.date), e: core.utcToPragueMinClamped(b.endsAt, b.date), title: b.title }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
  return { db, logs, telegrams, writes, planBlocks };
}

// шаблон: Veronika не работает Сб/Вс
const WEEKEND_OFF = { 0: { state: 'off' }, 1: { state: 'on' }, 2: { state: 'on' }, 3: { state: 'on' }, 4: { state: 'on' }, 5: { state: 'on' }, 6: { state: 'off' } };
// Karina: Po–St с 12:00 (школа), остальное — весь день
const KARINA_T = { 0: { state: 'on' }, 1: { state: 'hours', from: 720, to: 1140 }, 2: { state: 'hours', from: 720, to: 1140 }, 3: { state: 'hours', from: 720, to: 1140 }, 4: { state: 'on' }, 5: { state: 'on' }, 6: { state: 'on' } };

// ── чистые функции ────────────────────────────────────────────────────────
test('effectiveDay: исключение важнее шаблона, шаблон — с даты, без плана — весь день', () => {
  const sch = {
    templates: [
      { from: '2026-10-05', days: WEEKEND_OFF },
      { from: '2026-09-28', days: { ...WEEKEND_OFF, 5: { state: 'off' } } },
    ],
    overrides: { '2026-10-10': { state: 'on', note: 'svatba' } },
  };
  assert.deepEqual(M.effectiveDay(null, '2026-10-10'), { day: { state: 'on' }, source: 'none' });
  assert.deepEqual(M.effectiveDay(sch, '2026-09-27'), { day: { state: 'on' }, source: 'none' }, 'до первого шаблона');
  assert.equal(M.effectiveDay(sch, '2026-10-02').day.state, 'off', 'пятница по шаблону с 28.09');
  assert.equal(M.effectiveDay(sch, '2026-10-09').day.state, 'on', 'пятница по шаблону с 05.10');
  assert.deepEqual(M.effectiveDay(sch, '2026-10-10'), { day: { state: 'on' }, source: 'override' }, 'суббота-исключение');
  assert.equal(M.effectiveDay(sch, '2026-10-11').day.state, 'off');
});

test('desiredBlocks: выходной, весь день, часы, часы за окном, закрытый день', () => {
  const W = { openMin: 600, closeMin: 1140 };
  assert.deepEqual(M.desiredBlocks({ state: 'on' }, W), []);
  assert.deepEqual(M.desiredBlocks({ state: 'off' }, W), [{ startMin: 600, endMin: 1140, title: 'Volno' }]);
  assert.deepEqual(M.desiredBlocks({ state: 'hours', from: 720, to: 1140 }, W), [{ startMin: 600, endMin: 720, title: 'Mimo směnu' }]);
  assert.deepEqual(M.desiredBlocks({ state: 'hours', from: 660, to: 1020 }, W), [
    { startMin: 600, endMin: 660, title: 'Mimo směnu' },
    { startMin: 1020, endMin: 1140, title: 'Mimo směnu' },
  ]);
  assert.deepEqual(M.desiredBlocks({ state: 'hours', from: 480, to: 1320 }, W), [], 'смена шире окна салона');
  assert.deepEqual(M.desiredBlocks({ state: 'hours', from: 1200, to: 1320 }, W), [{ startMin: 600, endMin: 1140, title: 'Mimo směnu' }]);
  assert.deepEqual(M.desiredBlocks({ state: 'off' }, null), [], 'без часов салона блоков нет');
  assert.equal(M.salonWindow({ openMin: null, closeMin: null }), null);
});

test('normalizeDay / normalizeChanges: шаг 15 минут, порядок часов, прошлое, повторы', () => {
  assert.deepEqual(M.normalizeDay({ state: 'hours', from: 720, to: 1140, junk: 1 }), { state: 'hours', from: 720, to: 1140 });
  for (const bad of [{ state: 'x' }, { state: 'hours', from: 725, to: 1140 }, { state: 'hours', from: 900, to: 900 }, { state: 'hours', from: -15, to: 60 }, { state: 'template' }]) {
    assert.throws(() => M.normalizeDay(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(M.normalizeDay({ state: 'template' }, { allowTemplate: true }), { state: 'template' });
  const today = '2026-09-25';
  assert.throws(() => M.normalizeChanges({ changes: [{ date: '2026-09-24', state: 'off' }] }, today), (e) => e.code === 'date_in_past');
  assert.throws(() => M.normalizeChanges({ changes: [] }, today), (e) => e.code === 'no_changes');
  assert.throws(() => M.normalizeChanges({ changes: [{ date: '2026-10-01', state: 'off' }, { date: '2026-10-01', state: 'on' }] }, today), (e) => e.code === 'duplicate_date');
  assert.throws(() => M.normalizeChanges({ changes: [{ date: '2027-09-27', state: 'off' }] }, today), (e) => e.code === 'date_too_far');
  const ok = M.normalizeChanges({ changes: [{ date: '2026-10-03', state: 'off' }, { date: '2026-09-25', state: 'on' }], note: '  a   b ' }, today);
  assert.deepEqual(ok.changes.map((c) => c.date), ['2026-09-25', '2026-10-03'], 'отсортировано, сегодня можно');
  assert.equal(ok.note, 'a b');
  assert.throws(() => M.normalizeTemplateDays({ 0: { state: 'on' } }), (e) => e.code === 'bad_template');
});

test('diffPlanBlocks: совпадения не трогаются, дубли и лишнее удаляются, даты вне окна не видны', () => {
  const existing = [
    { documentId: 'a', date: '2026-10-03', startMin: 600, endMin: 1140, title: 'Volno' },
    { documentId: 'b', date: '2026-10-03', startMin: 600, endMin: 1140, title: 'Volno' },
    { documentId: 'c', date: '2026-10-05', startMin: 600, endMin: 720, title: 'Mimo směnu' },
    { documentId: 'd', date: '2026-12-31', startMin: 600, endMin: 1140, title: 'Volno' },
  ];
  const want = new Map([
    ['2026-10-03', [{ startMin: 600, endMin: 1140, title: 'Volno' }]],
    ['2026-10-04', [{ startMin: 600, endMin: 1140, title: 'Volno' }]],
    ['2026-10-05', []],
  ]);
  const r = M.diffPlanBlocks(existing, want, ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(r.toDelete.map((b) => b.documentId), ['b', 'c']);
  assert.deepEqual(r.toCreate, [{ date: '2026-10-04', startMin: 600, endMin: 1140, title: 'Volno' }]);
});

test('covers: объединение интервалов', () => {
  const I = [{ startMin: 600, endMin: 720 }, { startMin: 700, endMin: 1140 }];
  assert.equal(M.covers(I, 600, 1140), true);
  assert.equal(M.covers([{ startMin: 600, endMin: 700 }, { startMin: 720, endMin: 1140 }], 600, 1140), false);
  assert.equal(M.covers([], 700, 700), true);
});

// ── сервис ────────────────────────────────────────────────────────────────
test('шаблон: блоки «Volno» на Сб/Вс до последней даты часов салона, прошлое и чужие блоки не тронуты', async () => {
  const st = makeStrapi({
    blocks: [
      { noonaKey: M.planKeyOf(VERONIKA), date: '2026-09-20', startsAt: '2026-09-20T08:00:00.000Z', endsAt: '2026-09-20T17:00:00.000Z', title: 'Volno', noonaEmployeeId: 'N_VERONIKA', employee: VERONIKA },
      { noonaKey: 'own|manual', date: '2026-10-03', startsAt: '2026-10-03T12:00:00.000Z', endsAt: '2026-10-03T14:00:00.000Z', title: 'Врач', noonaEmployeeId: 'N_VERONIKA', employee: VERONIKA },
    ],
  });
  const r = await svc.saveTemplate({ session: MANAGER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF, base: null }, now: NOW });
  const plan = st.planBlocks(VERONIKA);
  const future = plan.filter((b) => b.date >= '2026-09-25');
  // 26.09 – 24.12: суббот и воскресений
  const weekend = M.datesBetween('2026-09-25', '2026-12-24').filter((d) => [0, 6].includes(M.dowOf(d)));
  assert.deepEqual(future.map((b) => b.date), weekend);
  assert.ok(future.every((b) => b.s === 600 && b.e === 1140 && b.title === 'Volno'), 'окно салона в пражском времени (и после DST 25.10)');
  assert.equal(r.reconcile.created, weekend.length);
  assert.ok(plan.some((b) => b.date === '2026-09-20'), 'прошлый блок плана остался');
  assert.ok(st.db['api::time-block.time-block'].some((b) => b.title === 'Врач'), 'ручной блок не тронут');
  const blk = st.db['api::time-block.time-block'].find((b) => b.noonaKey === M.planKeyOf(VERONIKA) && b.date === '2026-10-31');
  assert.equal(blk.approvalStatus, 'approved');
  assert.equal(blk.createdByName, 'Plán směn');
  assert.equal(blk.noonaEmployeeId, 'N_VERONIKA');
  assert.deepEqual(blk.employee, { documentId: VERONIKA });
  assert.equal(blk.startsAt, '2026-10-31T09:00:00.000Z', 'после перехода на зимнее время 10:00 = 09:00 UTC');
  assert.equal(st.planBlocks(VERONIKA).some((b) => b.date > '2026-12-24'), false, 'за окном записи блоков нет');
  // журнал
  const log = st.logs.at(-1);
  assert.equal(log.action, 'schedule_template');
  assert.equal(log.entityType, 'schedule');
  assert.match(log.summary, /^Plán směn — šablona: Veronika Simonova · od 25\.09\.2026 · Po celý den · /);
  assert.match(log.summary, /So volno · Ne volno$/);
});

test('reconcile идемпотентен: второй прогон — ноль записей; новые даты окна и закрытый день доводятся', async () => {
  const st = makeStrapi();
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  const before = st.writes.length;
  const again = await svc.reconcileAll({ now: NOW });
  assert.deepEqual([again.created, again.deleted], [0, 0]);
  assert.equal(st.writes.length, before, 'никаких записей');
  // синк часов дописал дни, а 26.12 салон закрыт
  for (const d of ['2026-12-25', '2026-12-26', '2026-12-27']) {
    st.db['api::salon-hour.salon-hour'].push(d === '2026-12-26' ? { date: d, openMin: null, closeMin: null } : { date: d, openMin: 600, closeMin: 1140 });
  }
  const next = await svc.reconcileAll({ now: NOW });
  assert.equal(next.created, 1, 'только воскресенье 27.12 (26.12 закрыт)');
  assert.ok(st.planBlocks(VERONIKA).some((b) => b.date === '2026-12-27'));
  assert.ok(!st.planBlocks(VERONIKA).some((b) => b.date === '2026-12-26'));
});

test('часы «с–до»: Po–St — «Mimo směnu» до 12:00; смена шаблона с даты — будущее переделано, раньше нет', async () => {
  const st = makeStrapi();
  await svc.saveTemplate({ session: OWNER, personal: KARINA, body: { from: '2026-09-28', days: KARINA_T }, now: NOW });
  const mon = st.planBlocks(KARINA).filter((b) => b.date === '2026-09-28');
  assert.deepEqual(mon, [{ date: '2026-09-28', s: 600, e: 720, title: 'Mimo směnu' }]);
  assert.equal(st.planBlocks(KARINA).filter((b) => b.date === '2026-10-01').length, 0, 'четверг — весь день');
  // с 21.12 школы нет — новый шаблон
  const allOn = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i) => [i, { state: 'on' }]));
  const doc = await svc._scheduleOf(KARINA);
  const r = await svc.saveTemplate({ session: OWNER, personal: KARINA, body: { from: '2026-12-21', days: allOn, base: doc.updatedAt }, now: NOW });
  assert.equal(r.reconcile.deleted, 3, 'Po–St 21–23.12');
  assert.ok(st.planBlocks(KARINA).some((b) => b.date === '2026-12-16'), '16.12 остался');
  // шаблон с более ранней даты перекрывает (удаляет) более поздний
  const doc2 = await svc._scheduleOf(KARINA);
  const r2 = await svc.saveTemplate({ session: OWNER, personal: KARINA, body: { from: '2026-12-01', days: KARINA_T, base: doc2.updatedAt }, now: NOW });
  assert.deepEqual(r2.replacedTemplates, ['2026-12-21']);
  assert.equal((await svc._scheduleOf(KARINA)).templates.length, 2);
});

test('шаблон: только руководство, с сегодняшнего дня, защита от одновременной правки', async () => {
  const st = makeStrapi();
  await assert.rejects(
    svc.saveTemplate({ session: ADMIN, personal: VERONIKA, body: { from: '2026-10-01', days: WEEKEND_OFF }, now: NOW }),
    (e) => e.code === 'management_only' && e.status === 403
  );
  await assert.rejects(
    svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-24', days: WEEKEND_OFF }, now: NOW }),
    (e) => e.code === 'date_in_past'
  );
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-10-01', days: WEEKEND_OFF, base: null }, now: NOW });
  await assert.rejects(
    svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-10-01', days: WEEKEND_OFF, base: null }, now: NOW }),
    (e) => e.code === 'schedule_changed' && e.status === 409
  );
  // не мастер / ушедший / мусорный id
  for (const pid of [MARIIA, GONE, 'Robert"; drop']) {
    await assert.rejects(
      svc.saveTemplate({ session: OWNER, personal: pid, body: { from: '2026-10-01', days: WEEKEND_OFF }, now: NOW }),
      (e) => e.code === 'master_not_found',
      pid
    );
  }
  assert.equal(st.db['api::master-schedule.master-schedule'].length, 1);
});

test('день руководством: исключение сразу, «как в шаблоне» снимает его, предложение на ту же дату снимается', async () => {
  const st = makeStrapi({
    bookings: [
      { date: '2026-10-07', startsAt: '2026-10-07T13:00:00.000Z', endsAt: '2026-10-07T14:00:00.000Z', noonaEmployeeId: 'N_VERONIKA', clientNameRaw: 'Jana' },
      { date: '2026-10-07', startsAt: '2026-10-07T13:00:00.000Z', endsAt: '2026-10-07T14:00:00.000Z', noonaEmployeeId: 'N_KARINA', clientNameRaw: 'Cizí' },
    ],
  });
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  await svc.saveDays({ session: ADMIN, personal: VERONIKA, body: { changes: [{ date: '2026-10-07', state: 'on' }] }, now: NOW });
  const r = await svc.saveDays({
    session: MANAGER,
    personal: VERONIKA,
    body: { changes: [{ date: '2026-10-07', state: 'off' }, { date: '2026-10-10', state: 'on' }], note: 'výměna' },
    now: NOW,
  });
  assert.equal(r.pending, false);
  assert.deepEqual(r.conflicts.map((c) => [c.date, c.time, c.client]), [['2026-10-07', '15:00', 'Jana']], 'только своя бронь');
  assert.ok(st.planBlocks(VERONIKA).some((b) => b.date === '2026-10-07'), 'среда закрыта');
  assert.ok(!st.planBlocks(VERONIKA).some((b) => b.date === '2026-10-10'), 'суббота открыта');
  const sch = await svc._scheduleOf(VERONIKA);
  assert.equal(sch.overrides['2026-10-07'].by, 'Mariia Medvedeva');
  assert.equal(sch.overrides['2026-10-07'].note, 'výměna');
  assert.deepEqual(sch.requests, {}, 'предложение администратора на 07.10 снято решением руководства');
  assert.match(st.logs.at(-1).summary, /^Plán směn — změna dne: Veronika Simonova · 07\.10\.2026 volno · 10\.10\.2026 celý den · výměna$/);
  // вернуть как в шаблоне
  await svc.saveDays({ session: MANAGER, personal: VERONIKA, body: { changes: [{ date: '2026-10-10', state: 'template' }], base: sch.updatedAt }, now: NOW });
  assert.ok(st.planBlocks(VERONIKA).some((b) => b.date === '2026-10-10'), 'суббота снова выходной');
  assert.equal((await svc._scheduleOf(VERONIKA)).overrides['2026-10-10'], undefined);
});

test('администратор: только предложение — блоки не меняются до согласования; согласование и отклонение', async () => {
  const st = makeStrapi();
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  const blocksBefore = JSON.stringify(st.planBlocks(VERONIKA));
  const r = await svc.saveDays({
    session: ADMIN,
    personal: VERONIKA,
    body: { changes: [{ date: '2026-10-10', state: 'on' }, { date: '2026-10-14', state: 'hours', from: 780, to: 1140 }], note: 'zástup' },
    now: NOW,
  });
  assert.equal(r.pending, true);
  assert.equal(JSON.stringify(st.planBlocks(VERONIKA)), blocksBefore, 'блоки не тронуты');
  const sch = await svc._scheduleOf(VERONIKA);
  assert.deepEqual(sch.overrides, {}, 'в исключения администратор не пишет');
  assert.equal(sch.requests['2026-10-10'].by, 'Yuliya Popchanka');
  assert.equal(st.telegrams.length, 1);
  assert.match(st.telegrams[0], /Změna plánu směn čeká na schválení/);
  assert.match(st.telegrams[0], /14\.10\.2026 — 13:00–19:00/);
  assert.equal(st.logs.at(-1).action, 'schedule_request');

  const pend = await svc.pendingRequests({ now: NOW });
  assert.deepEqual(pend.items.map((i) => [i.date, i.label, i.employeeName]), [
    ['2026-10-10', 'celý den', 'Veronika Simonova'],
    ['2026-10-14', '13:00–19:00', 'Veronika Simonova'],
  ]);

  await assert.rejects(
    svc.decide({ session: ADMIN, personal: VERONIKA, date: '2026-10-10', body: { status: 'approved' }, now: NOW }),
    (e) => e.code === 'management_only'
  );
  await svc.decide({ session: MANAGER, personal: VERONIKA, date: '2026-10-10', body: { status: 'approved' }, now: NOW });
  assert.ok(!st.planBlocks(VERONIKA).some((b) => b.date === '2026-10-10'), 'суббота открыта после согласования');
  await svc.decide({ session: MANAGER, personal: VERONIKA, date: '2026-10-14', body: { status: 'rejected' }, now: NOW });
  assert.equal(st.planBlocks(VERONIKA).filter((b) => b.date === '2026-10-14').length, 0, 'отклонено — среда как была');
  const after = await svc._scheduleOf(VERONIKA);
  assert.deepEqual(Object.keys(after.requests), []);
  assert.equal(after.overrides['2026-10-10'].approvedBy, 'Mariia Medvedeva');
  assert.deepEqual(st.logs.slice(-2).map((l) => l.action), ['schedule_approve', 'schedule_reject']);
  await assert.rejects(
    svc.decide({ session: MANAGER, personal: VERONIKA, date: '2026-10-14', body: { status: 'approved' }, now: NOW }),
    (e) => e.code === 'request_not_found'
  );
});

test('сетка месяца: мастера по порядку, источник дня, предложение, отпуск, прочие блоки, брони', async () => {
  const st = makeStrapi({
    blocks: [{ noonaKey: 'own|x', date: '2026-10-06', startsAt: '2026-10-06T12:00:00.000Z', endsAt: '2026-10-06T14:00:00.000Z', title: 'Врач', noonaEmployeeId: 'N_VERONIKA' }],
    bookings: [{ date: '2026-10-06', startsAt: '2026-10-06T08:00:00.000Z', endsAt: '2026-10-06T09:00:00.000Z', engineEmployeeId: VERONIKA }],
    timeOffs: [{ personal: KARINA, type: 'sick', startDate: '2026-10-01', endDate: '2026-10-02' }],
  });
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  await svc.saveDays({ session: ADMIN, personal: VERONIKA, body: { changes: [{ date: '2026-10-11', state: 'on' }] }, now: NOW });
  const g = await svc.grid({ month: '2026-10', session: ADMIN, now: NOW });
  assert.deepEqual(g.masters.map((m) => m.name), ['Karina Kamaeva', 'Veronika Simonova'], 'без управляющей и ушедших');
  assert.equal(g.canManage, false);
  assert.equal(g.horizon, '2026-12-24');
  assert.equal(g.dates.length, 31);
  const v = g.masters[1].days;
  assert.equal(v['2026-10-10'].state, 'off');
  assert.equal(v['2026-10-10'].source, 'template');
  assert.equal(v['2026-10-11'].request.state, 'on');
  assert.equal(v['2026-10-11'].state, 'off', 'предложение не меняет день');
  assert.deepEqual(v['2026-10-06'].blocks, [{ title: 'Врач', startMin: 840, endMin: 960 }], 'блоки плана в «прочих» не повторяются');
  assert.equal(v['2026-10-06'].bookings, 1);
  assert.equal(v['2026-10-10'].blocks.length, 0);
  assert.equal(g.masters[0].days['2026-10-01'].timeOff, 'sick');
  assert.equal(g.masters[0].days['2026-10-01'].source, 'none');
  await assert.rejects(svc.grid({ month: '2026-13', session: ADMIN, now: NOW }), (e) => e.code === 'bad_month');
});

test('старые серии: предлагаются только полностью покрытые планом; time-off, план, разовые — нет; замена удаляет только будущее', async () => {
  const wk = (from, to, dows) => M.datesBetween(from, to).filter((d) => dows.includes(M.dowOf(d)));
  const mirror = wk('2026-09-19', '2026-11-08', [0, 6]).map((d) => ({
    noonaKey: `H8e|${d}`, noonaBlockedId: 'H8e', date: d, noonaEmployeeId: 'N_VERONIKA',
    startsAt: core.pragueMinToUtcIso(d, 600), endsAt: core.pragueMinToUtcIso(d, 1140), title: null,
  }));
  const own = wk('2026-09-25', '2026-12-29', [6]).map((d) => ({
    noonaKey: 'own|evelina', date: d, noonaEmployeeId: 'N_VERONIKA', startsAt: core.pragueMinToUtcIso(d, 600), endsAt: core.pragueMinToUtcIso(d, 1140), title: 'Blokace', createdByName: 'Dima',
  }));
  const partlyWorking = wk('2026-09-25', '2026-10-31', [3]).map((d) => ({
    noonaKey: 'own|wed', date: d, noonaEmployeeId: 'N_VERONIKA', startsAt: core.pragueMinToUtcIso(d, 600), endsAt: core.pragueMinToUtcIso(d, 1140), title: 'Blokace',
  }));
  const timeOff = ['2026-10-03', '2026-10-04', '2026-10-10'].map((d) => ({
    noonaKey: 'own|dovolena', date: d, noonaEmployeeId: 'N_VERONIKA', startsAt: core.pragueMinToUtcIso(d, 600), endsAt: core.pragueMinToUtcIso(d, 1140), title: 'Dovolená',
  }));
  const st = makeStrapi({
    blocks: [...mirror, ...own, ...partlyWorking, ...timeOff],
    timeOffs: [{ personal: VERONIKA, type: 'vacation', startDate: '2026-10-03', endDate: '2026-10-10', blockSeriesKey: 'own|dovolena' }],
  });
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  const { items } = await svc.legacyCandidates({ personal: VERONIKA, now: NOW });
  assert.deepEqual(items.map((i) => [i.key, i.count]), [
    ['mirror|H8e', mirror.filter((b) => b.date >= '2026-09-25').length],
    ['own|evelina', own.filter((b) => b.date <= '2026-12-24').length],
  ]);
  assert.deepEqual(items[0].weekdays, ['So', 'Ne']);
  assert.equal(items[0].time, '10:00–19:00');
  assert.equal(items[1].createdBy, 'Dima');
  assert.equal(items[1].later, own.filter((b) => b.date > '2026-12-24').length, 'за окном записи — отдельно');
  assert.ok(items[1].later > 0);
  await assert.rejects(
    svc.replaceLegacy({ session: OWNER, personal: VERONIKA, body: { keys: ['own|wed'] }, now: NOW }),
    (e) => e.code === 'legacy_not_covered'
  );
  await assert.rejects(
    svc.replaceLegacy({ session: ADMIN, personal: VERONIKA, body: { keys: ['own|evelina'] }, now: NOW }),
    (e) => e.code === 'management_only'
  );
  const r = await svc.replaceLegacy({ session: OWNER, personal: VERONIKA, body: { keys: ['mirror|H8e', 'own|evelina'] }, now: NOW });
  const left = st.db['api::time-block.time-block'];
  assert.equal(r.deleted, items[0].count + items[1].count);
  assert.deepEqual(
    left.filter((b) => b.noonaKey === 'own|evelina').map((b) => b.date),
    own.filter((b) => b.date > '2026-12-24').map((b) => b.date),
    'за окном записи старые блоки остаются, пока план их не перекроет'
  );
  assert.ok(left.some((b) => b.noonaBlockedId === 'H8e' && b.date === '2026-09-20'), 'прошлое зеркало осталось');
  assert.ok(!left.some((b) => b.noonaBlockedId === 'H8e' && b.date >= '2026-09-25'));
  assert.equal(left.filter((b) => b.noonaKey === 'own|wed').length, partlyWorking.length);
  assert.equal(left.filter((b) => b.noonaKey === 'own|dovolena').length, 3, 'серия отпуска не тронута');
  assert.equal(st.logs.at(-1).action, 'schedule_legacy_replace');
});

test('cron: план мастера, ставшего управляющей, снимает свои будущие блоки', async () => {
  const st = makeStrapi();
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  assert.ok(st.planBlocks(VERONIKA).length > 20);
  st.db['api::personal.personal'].find((p) => p.documentId === VERONIKA).position = 'manager';
  const r = await svc.reconcileAll({ now: NOW });
  assert.ok(r.deleted > 20);
  assert.equal(st.planBlocks(VERONIKA).length, 0);
});

test('предпросмотр шаблона: брони в будущих новых выходных, прошедшие и чужие — нет', async () => {
  makeStrapi({
    bookings: [
      { date: '2026-10-03', startsAt: '2026-10-03T10:00:00.000Z', endsAt: '2026-10-03T11:00:00.000Z', noonaEmployeeId: 'N_VERONIKA', clientNameRaw: 'Sobota' },
      { date: '2026-10-05', startsAt: '2026-10-05T10:00:00.000Z', endsAt: '2026-10-05T11:00:00.000Z', noonaEmployeeId: 'N_VERONIKA', clientNameRaw: 'Pondělí' },
      { date: '2026-09-26', startsAt: '2026-09-26T08:00:00.000Z', endsAt: '2026-09-26T09:00:00.000Z', employee: VERONIKA, clientNameRaw: 'Zítra', internal: true },
    ],
  });
  const r = await svc.preview({ personal: VERONIKA, body: { template: { from: '2026-09-25', days: WEEKEND_OFF } }, now: NOW });
  assert.deepEqual(r.conflicts.map((c) => [c.client, c.internal]), [['Zítra', true], ['Sobota', false]]);
});

test('горизонт: часы салона заведены на год вперёд — блоки не дальше сегодня + 400 дней', async () => {
  const st = makeStrapi({ hoursUntil: '2027-12-31' });
  await svc.saveTemplate({ session: OWNER, personal: VERONIKA, body: { from: '2026-09-25', days: WEEKEND_OFF }, now: NOW });
  const dates = st.planBlocks(VERONIKA).map((b) => b.date);
  const cap = M.addDaysYmd('2026-09-25', M.MAX_HORIZON_DAYS);
  assert.ok(dates.at(-1) <= cap, `последний ${dates.at(-1)} > ${cap}`);
  assert.ok(dates.at(-1) > M.addDaysYmd(cap, -7), 'окно доведено до потолка');
});

test('предпросмотр дня: брони, которые уже начались или прошли сегодня, не считаются', async () => {
  makeStrapi({
    bookings: [
      { date: '2026-09-25', startsAt: '2026-09-25T07:00:00.000Z', endsAt: '2026-09-25T08:00:00.000Z', noonaEmployeeId: 'N_VERONIKA', clientNameRaw: 'Ráno' },
      { date: '2026-09-25', startsAt: '2026-09-25T09:30:00.000Z', endsAt: '2026-09-25T11:00:00.000Z', noonaEmployeeId: 'N_VERONIKA', clientNameRaw: 'Právě teď' },
      { date: '2026-09-25', startsAt: '2026-09-25T14:00:00.000Z', endsAt: '2026-09-25T15:00:00.000Z', noonaEmployeeId: 'N_VERONIKA', clientNameRaw: 'Odpoledne' },
    ],
  });
  const r = await svc.preview({ personal: VERONIKA, body: { changes: [{ date: '2026-09-25', state: 'off' }] }, now: NOW });
  assert.deepEqual(r.conflicts.map((c) => [c.client, c.time]), [['Odpoledne', '16:00']]);
});
