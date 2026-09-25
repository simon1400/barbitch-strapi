// Отпуска / больничные из админки + автоблоки (services/time-offs.ts, s216):
// проверка формы, серия блоков мастеру на часы салона, доводка серии при
// правке (ручные правки блока сохраняются), удаление, пересечения, брони на
// эти дни и журнал. Сервис гоняется НАСТОЯЩИЙ, на заглушке document service
// в памяти; slots-core — настоящий (пражское время).
//
// Запуск: cd strapi && node --test tests/time-offs.test.mjs

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
const svcJs = transpile('time-offs.ts').split("from './slots-core'").join(`from '${coreUrl}'`);
assert.ok(svcJs.includes(coreUrl), 'импорт slots-core подменён');
const T = await import(dataUrl(svcJs.split("from 'crypto'").join("from 'node:crypto'")));
const svc = T.default;

const MASTER = 'yanaaaaaaaaaaaaaaaaaaaaa';
const MASTER2 = 'zlataaaaaaaaaaaaaaaaaaaa';
const ADMIN = 'adminaaaaaaaaaaaaaaaaaaa';
const MANAGER = 'mariiaaaaaaaaaaaaaaaaaaa';
const GONE = 'goneaaaaaaaaaaaaaaaaaaaa';
const PERSONALS = {
  [MASTER]: { documentId: MASTER, name: 'Yana Ivanova', position: 'master', isActive: true, noonaEmployeeId: 'NOONA_YANA' },
  [MASTER2]: { documentId: MASTER2, name: 'Zlata Korunskay', position: 'master', isActive: true, noonaEmployeeId: 'NOONA_ZLATA' },
  [ADMIN]: { documentId: ADMIN, name: 'Yuliya Popchanka', position: 'administrator', isActive: true, noonaEmployeeId: null },
  [MANAGER]: { documentId: MANAGER, name: 'Mariia Medvedeva', position: 'manager', isActive: true, noonaEmployeeId: 'NOONA_MARIIA' },
  [GONE]: { documentId: GONE, name: '❌ Karina', position: 'master', isActive: false, noonaEmployeeId: 'NOONA_K' },
};

// ── заглушка document service ─────────────────────────────────────────────
const getPath = (obj, key) => obj?.[key];
const matchCond = (val, cond) => {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === '$eq' && val !== arg) return false;
      else if (op === '$gte' && !(val >= arg)) return false;
      else if (op === '$lte' && !(val <= arg)) return false;
      else if (!op.startsWith('$') && !matchCond(getPath(val, op), arg)) return false;
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

function makeStrapi({ hours = {}, bookings = [], timeOffs = [], blocks = [], failBlockCreateAt = null } = {}) {
  let seq = 0;
  const store = {
    'api::time-off.time-off': timeOffs.map((r) => ({ ...r })),
    'api::time-block.time-block': blocks.map((r) => ({ ...r })),
    'api::salon-hour.salon-hour': Object.entries(hours).map(([date, h]) => ({ documentId: `h${date}`, date, ...h })),
    'api::booking.booking': bookings.map((r) => ({ ...r })),
  };
  const logs = [];
  const calls = [];
  let blockCreates = 0;
  const withRel = (uid, r) => {
    const out = { ...r };
    if (uid === 'api::time-off.time-off' && r.personal) out.personal = { ...PERSONALS[r.personal.documentId] };
    if (uid === 'api::time-block.time-block' && r.employee) out.employee = { documentId: r.employee.documentId, name: PERSONALS[r.employee.documentId]?.name };
    return out;
  };
  const documents = (uid) => {
    if (uid === 'api::personal.personal') {
      return { findOne: async ({ documentId }) => (PERSONALS[documentId] ? { ...PERSONALS[documentId] } : null) };
    }
    const rows = store[uid];
    return {
      findMany: async (q) => {
        calls.push({ uid, op: 'findMany', q });
        let out = rows.filter((r) => match(withRel(uid, r), q.filters)).map((r) => withRel(uid, r));
        if (q.sort) out = out.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
        return out;
      },
      findOne: async (q) => {
        const r = rows.find((x) => x.documentId === q.documentId);
        return r ? withRel(uid, r) : null;
      },
      create: async (q) => {
        calls.push({ uid, op: 'create', q });
        if (uid === 'api::time-block.time-block') {
          blockCreates += 1;
          if (failBlockCreateAt && blockCreates === failBlockCreateAt) throw new Error('db down');
        }
        const documentId = `new${String(++seq).padStart(21, '0')}`;
        const row = { documentId, ...q.data };
        rows.push(row);
        return withRel(uid, row);
      },
      update: async (q) => {
        calls.push({ uid, op: 'update', q });
        const r = rows.find((x) => x.documentId === q.documentId);
        Object.assign(r, q.data);
        return withRel(uid, r);
      },
      delete: async ({ documentId }) => {
        calls.push({ uid, op: 'delete', documentId });
        const i = rows.findIndex((x) => x.documentId === documentId);
        if (i >= 0) rows.splice(i, 1);
      },
    };
  };
  globalThis.strapi = {
    documents,
    service: () => ({ write: async (e) => { logs.push(e); } }),
    log: { error() {}, warn() {}, info() {} },
  };
  return { store, logs, calls, blocks: () => store['api::time-block.time-block'], offs: () => store['api::time-off.time-off'] };
}

const SESSION = { username: 'Mariia Medvedeva', role: 'manager' };
const NOW = new Date('2026-10-05T08:00:00Z'); // 10:00 Праги, понедельник
const flush = () => new Promise((r) => setImmediate(r));
const expectErr = async (fn, status, code) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `status ${e.status} ≠ ${status} (${e.code})`);
    assert.equal(e.code, code);
    return true;
  });
};
const H = (openMin, closeMin) => ({ openMin, closeMin });

// ── чистые функции ─────────────────────────────────────────────────────────
test('normalizeTimeOffInput: валидная форма и значения по умолчанию', () => {
  assert.deepEqual(
    T.normalizeTimeOffInput({ personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-12', comment: '  moře ' }, '2026-10-05'),
    { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-12', paid: true, comment: 'moře' }
  );
  assert.equal(T.normalizeTimeOffInput({ personal: MASTER, type: 'sick', startDate: '2026-10-10', endDate: '2026-10-10', paid: false }, '2026-10-05').paid, false);
  // правка: отсутствующие поля — из текущей записи
  const base = { personal: MASTER, type: 'sick', startDate: '2026-10-01', endDate: '2026-10-03', paid: false, comment: 'x' };
  assert.deepEqual(T.normalizeTimeOffInput({ endDate: '2026-10-04' }, '2026-10-05', base), { ...base, endDate: '2026-10-04' });
});

test('normalizeTimeOffInput: коды ошибок', () => {
  const ok = { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-12' };
  const cases = [
    [{ personal: '' }, 'personal_required'],
    [{ personal: "x' or 1=1" }, 'personal_not_found'],
    [{ type: 'unpaid' }, 'bad_type'],
    [{ type: 'constructor' }, 'bad_type'],
    [{ type: '__proto__' }, 'bad_type'],
    [{ startDate: '2026-02-30' }, 'bad_date'],
    [{ endDate: '12.10.2026' }, 'bad_date'],
    [{ endDate: '2026-10-09' }, 'bad_range'],
    [{ endDate: '2027-01-10' }, 'range_too_long'],
    [{ startDate: '2027-10-10', endDate: '2027-10-11' }, 'date_too_far'],
    [{ paid: 'maybe' }, 'bad_paid'],
    [{ comment: 'x'.repeat(T.MAX_COMMENT + 1) }, 'comment_too_long'],
  ];
  for (const [patch, code] of cases) {
    assert.throws(
      () => T.normalizeTimeOffInput({ ...ok, ...patch }, '2026-10-05'),
      (e) => e.code === code && e.status === 400,
      `${JSON.stringify(patch)} → ${code}`
    );
  }
  // ровно MAX_SPAN_DAYS — проходит
  assert.equal(T.normalizeTimeOffInput({ ...ok, startDate: '2026-10-01', endDate: T.addDaysYmd('2026-10-01', T.MAX_SPAN_DAYS - 1) }, '2026-10-05').startDate, '2026-10-01');
});

test('needsBlocks: только активный мастер с Noona-id', () => {
  assert.equal(T.needsBlocks(PERSONALS[MASTER]), true);
  assert.equal(T.needsBlocks(PERSONALS[ADMIN]), false);
  assert.equal(T.needsBlocks(PERSONALS[MANAGER]), false, 'у управляющей колонки нет, хотя Noona-id остался');
  assert.equal(T.needsBlocks(PERSONALS[GONE]), false);
  assert.equal(T.needsBlocks({ ...PERSONALS[MASTER], noonaEmployeeId: '  ' }), false);
});

test('blockWindow: часы салона, без строки/закрыто — 10:00–19:00', () => {
  assert.deepEqual(T.blockWindow(H(540, 1200)), { startMin: 540, endMin: 1200 });
  assert.deepEqual(T.blockWindow(undefined), { startMin: 600, endMin: 1140 });
  assert.deepEqual(T.blockWindow(H(null, null)), { startMin: 600, endMin: 1140 });
  assert.deepEqual(T.blockWindow(H(600, 600)), { startMin: 600, endMin: 1140 });
});

test('planBlockSync: лишние даты и дубли — удалить, недостающие — создать', () => {
  const plan = T.planBlockSync(
    [{ documentId: 'a', date: '2026-10-01' }, { documentId: 'b', date: '2026-10-02' }, { documentId: 'c', date: '2026-10-02' }, { documentId: 'd', date: '2026-10-09' }],
    ['2026-10-02', '2026-10-03']
  );
  assert.deepEqual(plan.toDelete.map((b) => b.documentId), ['a', 'c', 'd']);
  assert.deepEqual(plan.toCreate, ['2026-10-03']);
  assert.equal(plan.kept, 1);
});

test('datesBetween / spanDays: включительно, через смену месяца и DST', () => {
  assert.deepEqual(T.datesBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(T.spanDays('2026-10-24', '2026-10-26'), 3); // через переход на зимнее время
});

// ── сервис ─────────────────────────────────────────────────────────────────
test('create: мастеру — запись + блок на каждый день по часам салона, approved, журнал', async () => {
  const s = makeStrapi({ hours: { '2026-10-10': H(600, 1140), '2026-10-11': H(540, 1080) } });
  const res = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-12', comment: 'moře' }, now: NOW });
  assert.equal(res.blocks, 3);
  assert.deepEqual(res.conflicts, []);
  const off = s.offs()[0];
  assert.equal(off.type, 'vacation');
  assert.deepEqual(off.personal, { documentId: MASTER });
  assert.match(off.blockSeriesKey, /^own\|[0-9a-f-]{36}$/, 'серия — own-ключ движка');
  assert.equal(res.row.blockSeriesKey, off.blockSeriesKey);

  const bl = s.blocks().sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(bl.map((b) => b.date), ['2026-10-10', '2026-10-11', '2026-10-12']);
  for (const b of bl) {
    assert.equal(b.noonaKey, off.blockSeriesKey);
    assert.equal(b.noonaEmployeeId, 'NOONA_YANA', 'календарь раскладывает блоки по noonaEmployeeId');
    assert.deepEqual(b.employee, { documentId: MASTER });
    assert.equal(b.employeeNameRaw, 'Yana Ivanova');
    assert.equal(b.title, 'Dovolená');
    assert.equal(b.approvalStatus, 'approved');
    assert.equal(b.approvedByName, 'Mariia Medvedeva');
    assert.equal(b.createdByName, 'Mariia Medvedeva');
  }
  // 10.10: 10:00–19:00 Праги = 08:00–17:00 UTC (летнее время)
  assert.equal(bl[0].startsAt, '2026-10-10T08:00:00.000Z');
  assert.equal(bl[0].endsAt, '2026-10-10T17:00:00.000Z');
  // 11.10: свои часы салона 9:00–18:00
  assert.equal(bl[1].startsAt, '2026-10-11T07:00:00.000Z');
  assert.equal(bl[1].endsAt, '2026-10-11T16:00:00.000Z');
  // 12.10: строки часов нет — окно по умолчанию
  assert.equal(bl[2].startsAt, '2026-10-12T08:00:00.000Z');

  await flush();
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].action, 'timeoff_create');
  assert.equal(s.logs[0].entityType, 'timeoff');
  assert.equal(s.logs[0].actorName, 'Mariia Medvedeva');
  assert.equal(s.logs[0].employeeName, 'Yana Ivanova');
  assert.equal(s.logs[0].summary, 'Dovolená: Yana Ivanova 10.10.2026 – 12.10.2026 (3 dny) · 3 bloky');
});

test('create: блоки после перехода на зимнее время — тоже 10:00 Праги', async () => {
  const s = makeStrapi();
  await svc.create({ session: SESSION, body: { personal: MASTER, type: 'sick', startDate: '2026-10-26', endDate: '2026-10-26' }, now: NOW });
  assert.equal(s.blocks()[0].startsAt, '2026-10-26T09:00:00.000Z');
  assert.equal(s.blocks()[0].title, 'Nemoc');
});

test('create: администратору и управляющей — только запись, блоков нет', async () => {
  const s = makeStrapi();
  for (const p of [ADMIN, MANAGER]) {
    const res = await svc.create({ session: SESSION, body: { personal: p, type: 'sick', startDate: '2026-10-10', endDate: '2026-10-11' }, now: NOW });
    assert.equal(res.blocks, 0);
    assert.equal(res.row.blockSeriesKey, null);
  }
  assert.equal(s.blocks().length, 0);
  assert.equal(s.offs().length, 2);
  assert.ok(s.offs().every((o) => o.blockSeriesKey === null));
});

test('create: ушедший/несуществующий сотрудник → 404, ничего не записано', async () => {
  const s = makeStrapi();
  await expectErr(() => svc.create({ session: SESSION, body: { personal: GONE, type: 'sick', startDate: '2026-10-10', endDate: '2026-10-10' }, now: NOW }), 404, 'personal_not_found');
  await expectErr(() => svc.create({ session: SESSION, body: { personal: 'nobodyaaaaaaaaaaaaaaaaaa', type: 'sick', startDate: '2026-10-10', endDate: '2026-10-10' }, now: NOW }), 404, 'personal_not_found');
  assert.equal(s.offs().length, 0);
  assert.equal(s.blocks().length, 0);
});

test('create: пересечение с другой записью того же сотрудника → 409; у другого — можно', async () => {
  const s = makeStrapi({ timeOffs: [{ documentId: 'offaaaaaaaaaaaaaaaaaaaaa', personal: { documentId: MASTER }, type: 'sick', startDate: '2026-10-08', endDate: '2026-10-10' }] });
  await expectErr(() => svc.create({ session: SESSION, body: { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-12' }, now: NOW }), 409, 'timeoff_overlap');
  assert.equal(s.blocks().length, 0);
  // впритык — можно
  await svc.create({ session: SESSION, body: { personal: MASTER, type: 'vacation', startDate: '2026-10-11', endDate: '2026-10-12' }, now: NOW });
  await svc.create({ session: SESSION, body: { personal: MASTER2, type: 'vacation', startDate: '2026-10-09', endDate: '2026-10-09' }, now: NOW });
  assert.equal(s.offs().length, 3);
});

test('create: сбой на середине серии — ни записи, ни блоков', async () => {
  const s = makeStrapi({ failBlockCreateAt: 3 });
  await assert.rejects(() => svc.create({ session: SESSION, body: { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-14' }, now: NOW }), /db down/);
  assert.equal(s.offs().length, 0);
  assert.equal(s.blocks().length, 0, 'уже созданные блоки серии удалены');
});

test('create/conflicts: активные будущие брони мастера на эти дни (прошедшие, отменённые, чужие — нет)', async () => {
  const bookings = [
    { documentId: 'b1', status: 'active', date: '2026-10-05', startsAt: '2026-10-05T07:00:00.000Z', employee: { documentId: MASTER }, clientNameRaw: 'Past' }, // 9:00 — уже прошла
    { documentId: 'b2', status: 'active', date: '2026-10-05', startsAt: '2026-10-05T12:00:00.000Z', employee: { documentId: MASTER }, clientNameRaw: 'Anna' },
    { documentId: 'b3', status: 'cancelled', date: '2026-10-06', startsAt: '2026-10-06T12:00:00.000Z', employee: { documentId: MASTER }, clientNameRaw: 'Zrušeno' },
    { documentId: 'b4', status: 'active', date: '2026-10-06', startsAt: '2026-10-06T08:30:00.000Z', noonaEmployeeId: 'NOONA_YANA', clientNameRaw: 'Mirror' },
    { documentId: 'b5', status: 'active', date: '2026-10-06', startsAt: '2026-10-06T09:00:00.000Z', employee: { documentId: MASTER2 }, clientNameRaw: 'Cizí' },
    { documentId: 'b6', status: 'active', date: '2026-10-09', startsAt: '2026-10-09T09:00:00.000Z', employee: { documentId: MASTER }, clientNameRaw: 'Mimo' },
    { documentId: 'b7', status: 'active', date: '2026-10-06', startsAt: '2026-10-06T14:00:00.000Z', engineEmployeeId: MASTER, clientNameRaw: 'Kolegyně', internal: true },
  ];
  makeStrapi({ bookings });
  const { rows } = await svc.conflicts({ personal: MASTER, startDate: '2026-10-01', endDate: '2026-10-06', now: NOW });
  assert.deepEqual(rows.map((r) => r.documentId), ['b2', 'b4', 'b7']);
  assert.deepEqual(rows[0], { documentId: 'b2', date: '2026-10-05', time: '14:00', client: 'Anna', internal: false });
  assert.equal(rows[2].internal, true);
  // сама запись создаётся, брони возвращаются в ответе
  const s = makeStrapi({ bookings });
  const res = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'sick', startDate: '2026-10-05', endDate: '2026-10-06' }, now: NOW });
  assert.deepEqual(res.conflicts.map((r) => r.documentId), ['b2', 'b4', 'b7']);
  assert.equal(s.blocks().length, 2);
  // администратору броней не бывает
  assert.deepEqual((await svc.conflicts({ personal: ADMIN, startDate: '2026-10-01', endDate: '2026-10-06', now: NOW })).rows, []);
  await expectErr(() => svc.conflicts({ personal: MASTER, startDate: '2026-10-06', endDate: '2026-10-01', now: NOW }), 400, 'bad_date');
});

test('update: продление/сокращение доводит серию, ручная правка блока внутри периода сохраняется', async () => {
  const s = makeStrapi();
  const { row } = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'sick', startDate: '2026-10-10', endDate: '2026-10-12' }, now: NOW });
  // администратор укоротил блок 11.10 в календаре (мастер пришла после обеда)
  const b11 = s.blocks().find((b) => b.date === '2026-10-11');
  b11.endsAt = '2026-10-11T11:00:00.000Z';
  const ids11 = b11.documentId;

  const res = await svc.update({ session: SESSION, documentId: row.documentId, body: { startDate: '2026-10-11', endDate: '2026-10-14' }, now: NOW });
  assert.equal(res.blocks, 4);
  const bl = s.blocks().sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(bl.map((b) => b.date), ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(bl[0].documentId, ids11, 'блок 11.10 не пересоздан');
  assert.equal(bl[0].endsAt, '2026-10-11T11:00:00.000Z', 'ручная правка цела');
  assert.ok(bl.every((b) => b.noonaKey === row.blockSeriesKey));
  assert.equal(s.offs()[0].startDate, '2026-10-11');
  assert.equal(s.offs()[0].blockSeriesKey, row.blockSeriesKey, 'ключ серии прежний');
  await flush();
  const upd = s.logs.find((l) => l.action === 'timeoff_update');
  assert.equal(upd.details['bloky přidáno'], '2');
  assert.equal(upd.details['bloky smazáno'], '1');
  assert.match(upd.details.změny, /období: 10\.10\.2026 – 12\.10\.2026 → 11\.10\.2026 – 14\.10\.2026/);
});

test('update: смена типа переименовывает автоблоки, ручное название не трогает', async () => {
  const s = makeStrapi();
  const { row } = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'sick', startDate: '2026-10-10', endDate: '2026-10-11' }, now: NOW });
  s.blocks().find((b) => b.date === '2026-10-11').title = 'Lékař 10–12';
  await svc.update({ session: SESSION, documentId: row.documentId, body: { type: 'vacation' }, now: NOW });
  const t = Object.fromEntries(s.blocks().map((b) => [b.date, b.title]));
  assert.deepEqual(t, { '2026-10-10': 'Dovolená', '2026-10-11': 'Lékař 10–12' });
  assert.equal(s.offs()[0].type, 'vacation');
});

test('update: смена сотрудника — серия переезжает к новому мастеру; на администратора — блоки убираются', async () => {
  const s = makeStrapi();
  const { row } = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-11' }, now: NOW });
  await svc.update({ session: SESSION, documentId: row.documentId, body: { personal: MASTER2 }, now: NOW });
  assert.equal(s.blocks().length, 2);
  assert.ok(s.blocks().every((b) => b.employee.documentId === MASTER2 && b.noonaEmployeeId === 'NOONA_ZLATA'));
  assert.deepEqual(s.offs()[0].personal, { documentId: MASTER2 });

  await svc.update({ session: SESSION, documentId: row.documentId, body: { personal: ADMIN }, now: NOW });
  assert.equal(s.blocks().length, 0);
  assert.equal(s.offs()[0].blockSeriesKey, null);
});

test('update: старая запись из CM без блоков получает серию; пересечение с собой не мешает', async () => {
  const s = makeStrapi({ timeOffs: [{ documentId: 'cmaaaaaaaaaaaaaaaaaaaaaa', personal: { documentId: MASTER }, type: 'vacation', startDate: '2026-10-20', endDate: '2026-10-21', paid: true }] });
  const res = await svc.update({ session: SESSION, documentId: 'cmaaaaaaaaaaaaaaaaaaaaaa', body: { comment: 'doplněno' }, now: NOW });
  assert.equal(res.blocks, 2);
  assert.match(s.offs()[0].blockSeriesKey, /^own\|/);
  assert.equal(s.offs()[0].comment, 'doplněno');
});

test('update/remove: неизвестная запись → 404', async () => {
  makeStrapi();
  await expectErr(() => svc.update({ session: SESSION, documentId: 'nopeaaaaaaaaaaaaaaaaaaaa', body: {}, now: NOW }), 404, 'timeoff_not_found');
  await expectErr(() => svc.remove({ session: SESSION, documentId: "x' or 1=1" }), 404, 'timeoff_not_found');
});

test('remove: запись и вся её серия (в т.ч. ручные правки), чужие блоки целы, журнал', async () => {
  const other = { documentId: 'otherblockaaaaaaaaaaaaaa', noonaKey: 'own|someone-else', date: '2026-10-10', employee: { documentId: MASTER } };
  const s = makeStrapi({ blocks: [other] });
  const { row } = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'vacation', startDate: '2026-10-10', endDate: '2026-10-12' }, now: NOW });
  const res = await svc.remove({ session: SESSION, documentId: row.documentId });
  assert.deepEqual(res, { deleted: row.documentId, blocks: 3 });
  assert.equal(s.offs().length, 0);
  assert.deepEqual(s.blocks().map((b) => b.documentId), [other.documentId]);
  await flush();
  const del = s.logs.find((l) => l.action === 'timeoff_delete');
  assert.equal(del.summary, 'Smazáno — dovolená: Yana Ivanova 10.10.2026 – 12.10.2026 (3 dny) · 3 bloky');
});

// ── s216: блоки только с сегодняшнего дня, прошлое не трогаем ───────────────
test('blockDates: период, но не раньше сегодня', () => {
  assert.deepEqual(T.blockDates('2026-10-03', '2026-10-06', '2026-10-05'), ['2026-10-05', '2026-10-06']);
  assert.deepEqual(T.blockDates('2026-10-01', '2026-10-04', '2026-10-05'), []);
  assert.deepEqual(T.blockDates('2026-10-05', '2026-10-05', '2026-10-05'), ['2026-10-05']);
  assert.deepEqual(T.blockDates('2026-10-07', '2026-10-08', '2026-10-05'), ['2026-10-07', '2026-10-08']);
});

test('create: начало в прошлом — блоки с сегодняшнего дня; целиком в прошлом — ни блоков, ни ключа', async () => {
  const s = makeStrapi();
  const r1 = await svc.create({ session: SESSION, body: { personal: MASTER, type: 'sick', startDate: '2026-10-02', endDate: '2026-10-07' }, now: NOW });
  assert.equal(r1.blocks, 3);
  assert.deepEqual(s.blocks().map((b) => b.date).sort(), ['2026-10-05', '2026-10-06', '2026-10-07']);
  const r2 = await svc.create({ session: SESSION, body: { personal: MASTER2, type: 'sick', startDate: '2026-09-28', endDate: '2026-10-04' }, now: NOW });
  assert.equal(r2.blocks, 0);
  assert.equal(r2.row.blockSeriesKey, null);
  assert.equal(s.offs().find((o) => o.documentId === r2.row.documentId).blockSeriesKey, null, 'без блоков ключ не пишется — бейдж не врёт');
  assert.equal(s.blocks().length, 3);
});

const KEY = 'own|past-series';
const seedSeries = (dates, personal = MASTER, title = 'Nemoc') =>
  dates.map((date, i) => ({ documentId: `blk${i}aaaaaaaaaaaaaaaaaaaa`, noonaKey: KEY, date, title, employee: { documentId: personal }, noonaEmployeeId: PERSONALS[personal].noonaEmployeeId }));
const PAST_OFF = { documentId: 'pastoffaaaaaaaaaaaaaaaaa', personal: { documentId: MASTER }, type: 'sick', startDate: '2026-10-01', endDate: '2026-10-07', paid: true, blockSeriesKey: KEY };
const SERIES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];

test('update: прошлые блоки серии не удаляются, даже если период их больше не покрывает', async () => {
  const s = makeStrapi({ timeOffs: [PAST_OFF], blocks: seedSeries(SERIES) });
  const res = await svc.update({ session: SESSION, documentId: PAST_OFF.documentId, body: { startDate: '2026-10-03', endDate: '2026-10-05' }, now: NOW });
  assert.deepEqual(s.blocks().map((b) => b.date).sort(), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'],
    'прошлые 01–04 целы (01–02 уже вне периода), будущие 06–07 удалены');
  assert.equal(res.blocks, 5);
  assert.equal(s.offs()[0].blockSeriesKey, KEY);
  // период целиком ушёл в прошлое — будущих блоков нет, прошлые на месте, ключ остаётся (удаление записи их уберёт)
  const res2 = await svc.update({ session: SESSION, documentId: PAST_OFF.documentId, body: { startDate: '2026-10-01', endDate: '2026-10-02' }, now: NOW });
  assert.deepEqual(s.blocks().map((b) => b.date).sort(), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(res2.blocks, 4);
  assert.equal(s.offs()[0].blockSeriesKey, KEY);
});

test('update: смена типа не переименовывает прошлые блоки', async () => {
  const s = makeStrapi({ timeOffs: [PAST_OFF], blocks: seedSeries(SERIES) });
  await svc.update({ session: SESSION, documentId: PAST_OFF.documentId, body: { type: 'vacation' }, now: NOW });
  const t = Object.fromEntries(s.blocks().map((b) => [b.date, b.title]));
  assert.equal(t['2026-10-04'], 'Nemoc');
  assert.equal(t['2026-10-05'], 'Dovolená');
  assert.equal(t['2026-10-07'], 'Dovolená');
});

test('update: смена сотрудника переносит только сегодня и дальше; на администратора — прошлое остаётся', async () => {
  const s = makeStrapi({ timeOffs: [PAST_OFF], blocks: seedSeries(SERIES) });
  await svc.update({ session: SESSION, documentId: PAST_OFF.documentId, body: { personal: MASTER2 }, now: NOW });
  const by = (who) => s.blocks().filter((b) => b.employee.documentId === who).map((b) => b.date).sort();
  assert.deepEqual(by(MASTER), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(by(MASTER2), ['2026-10-05', '2026-10-06', '2026-10-07']);
  await svc.update({ session: SESSION, documentId: PAST_OFF.documentId, body: { personal: ADMIN }, now: NOW });
  assert.deepEqual(s.blocks().map((b) => b.date).sort(), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(s.offs()[0].blockSeriesKey, KEY, 'прошлые блоки остались — ключ нужен, чтобы удаление записи их убрало');
});

test('update: старая запись из CM в прошлом — пересохранение ничего не ставит', async () => {
  const s = makeStrapi({ timeOffs: [{ documentId: 'cmpastaaaaaaaaaaaaaaaaaa', personal: { documentId: MASTER }, type: 'sick', startDate: '2026-09-22', endDate: '2026-09-25', paid: true }] });
  const res = await svc.update({ session: SESSION, documentId: 'cmpastaaaaaaaaaaaaaaaaaa', body: { comment: 'x' }, now: NOW });
  assert.equal(res.blocks, 0);
  assert.equal(s.blocks().length, 0);
  assert.equal(s.offs()[0].blockSeriesKey ?? null, null);
});

test('remove: удаление записи убирает и прошлые блоки серии', async () => {
  const s = makeStrapi({ timeOffs: [PAST_OFF], blocks: seedSeries(SERIES) });
  const res = await svc.remove({ session: SESSION, documentId: PAST_OFF.documentId });
  assert.equal(res.blocks, 7);
  assert.equal(s.blocks().length, 0);
});
