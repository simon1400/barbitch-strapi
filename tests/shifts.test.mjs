// Редактор смен администраторов (services/shifts.ts, s217): проверка недели и
// дней, окно недель + подсказки имён, создание/обновление с публикацией,
// защита от одновременной правки, удаление и журнал. Сервис — НАСТОЯЩИЙ, на
// заглушке document service с двумя версиями документа (черновик + публикация).
//
// Запуск: cd strapi && node --test tests/shifts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const file = path.resolve(import.meta.dirname, '../src/api/booking-engine/services/shifts.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const S = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const svc = S.default;

const NOW = new Date('2026-09-25T10:00:00Z'); // пятница, Прага 12:00
const SESSION = { username: 'Mariia Medvedeva', role: 'manager' };
const WEEK = { monday: 'Вика', tuesday: 'Вика', wednesday: 'Юля', thursday: 'Вика', friday: 'Вика', saturday: 'Юля', sunday: 'Юля' };

// ── заглушка document service: строки {documentId, published, from, to, week, days, updatedAt} ──
function makeStrapi(seed = []) {
  let seq = 0;
  let clock = Date.parse('2026-09-20T08:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const rows = [];
  for (const s of seed) {
    const base = { documentId: s.documentId, from: s.from, to: s.to ?? s.from, week: s.week ?? 'x', updatedAt: s.updatedAt ?? tick() };
    rows.push({ ...base, published: false, days: { ...(s.days ?? WEEK) } });
    if (s.published !== false) rows.push({ ...base, published: true, days: { ...(s.pubDays ?? s.days ?? WEEK) } });
  }
  const logs = [];
  const calls = [];
  const cond = (v, c) =>
    typeof c === 'object' && c
      ? Object.entries(c).every(([op, a]) => (op === '$eq' ? v === a : op === '$gte' ? v >= a : op === '$lte' ? v <= a : false))
      : v === c;
  const pick = (r, q) => {
    const out = { documentId: r.documentId };
    for (const f of q.fields || Object.keys(r)) if (f in r) out[f] = r[f];
    if (q.populate?.days) out.days = { id: 1, ...r.days };
    return out;
  };
  const find = (status, filters = {}) =>
    rows.filter((r) => r.published === (status === 'published') && Object.entries(filters).every(([k, c]) => cond(r[k], c)));
  const docs = {
    async findMany(q) {
      calls.push(['findMany', q.status, q.filters]);
      let list = find(q.status ?? 'draft', q.filters);
      if (q.sort === 'from:asc') list = [...list].sort((a, b) => a.from.localeCompare(b.from));
      return list.slice(0, q.limit ?? 10).map((r) => pick(r, q));
    },
    async findOne(q) {
      const r = rows.find((x) => x.documentId === q.documentId && x.published === ((q.status ?? 'draft') === 'published'));
      return r ? pick(r, q) : null;
    },
    async create(q) {
      calls.push(['create', q.status, q.data]);
      const documentId = `shift${String(++seq).padStart(19, '0')}`;
      const at = tick();
      const row = { documentId, ...q.data, days: { ...q.data.days }, updatedAt: at };
      rows.push({ ...row, published: false });
      if (q.status === 'published') rows.push({ ...row, days: { ...q.data.days }, published: true });
      return { documentId };
    },
    async update(q) {
      calls.push(['update', q.documentId, q.data]);
      const r = rows.find((x) => x.documentId === q.documentId && !x.published);
      Object.assign(r, q.data, { days: { ...q.data.days }, updatedAt: tick() });
      return { documentId: q.documentId };
    },
    async publish(q) {
      calls.push(['publish', q.documentId]);
      const d = rows.find((x) => x.documentId === q.documentId && !x.published);
      const i = rows.findIndex((x) => x.documentId === q.documentId && x.published);
      if (i >= 0) rows.splice(i, 1);
      rows.push({ ...d, days: { ...d.days }, published: true });
      return { documentId: q.documentId };
    },
    async delete(q) {
      calls.push(['delete', q.documentId]);
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].documentId === q.documentId) rows.splice(i, 1);
      return { documentId: q.documentId };
    },
  };
  globalThis.strapi = {
    documents: (uid) => {
      assert.equal(uid, 'api::shift.shift');
      return docs;
    },
    service: (uid) => {
      assert.equal(uid, 'api::calendar-log.calendar-log');
      return { write: async (entry) => logs.push(entry) };
    },
    log: { error() {}, info() {} },
  };
  return { rows, logs, calls };
}

const expectErr = async (fn, status, code) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `status ${e.status} (${e.code})`);
    assert.equal(e.code, code);
    return true;
  });
};

// ── чистые функции ─────────────────────────────────────────────────────────
test('parseMonday: понедельник, границы, мусор', () => {
  assert.equal(S.parseMonday('2026-09-28', '2026-09-25'), '2026-09-28');
  for (const bad of ['', '2026-09-29', '2026-02-30', '28.09.2026', 'constructor', null]) {
    assert.throws(() => S.parseMonday(bad, '2026-09-25'), (e) => e.code === 'bad_monday', String(bad));
  }
  assert.throws(() => S.parseMonday('2024-12-30', '2026-09-25'), (e) => e.code === 'date_too_old');
  assert.equal(S.parseMonday('2027-09-20', '2026-09-25'), '2027-09-20'); // ровно ≤ год
  assert.throws(() => S.parseMonday('2027-09-27', '2026-09-25'), (e) => e.code === 'date_too_far');
});

test('parseWeeks: по умолчанию 5, 1…12', () => {
  assert.equal(S.parseWeeks(undefined), 5);
  assert.equal(S.parseWeeks('12'), 12);
  for (const bad of ['0', '13', '2.5', 'abc']) assert.throws(() => S.parseWeeks(bad), (e) => e.code === 'bad_weeks', bad);
});

test('normalizeDays: все 7 обязательны, пробелы схлопнуты, длина, типы', () => {
  const d = S.normalizeDays({ ...WEEK, monday: '  Кристина  ', friday: 'Маша  и   Настя' });
  assert.equal(d.monday, 'Кристина');
  assert.equal(d.friday, 'Маша и Настя');
  assert.deepEqual(Object.keys(d), S.DAY_KEYS);
  assert.throws(() => S.normalizeDays({ ...WEEK, sunday: '   ' }), (e) => e.code === 'day_required' && /Ne/.test(e.message));
  assert.throws(() => S.normalizeDays({ ...WEEK, sunday: undefined }), (e) => e.code === 'day_required');
  assert.throws(() => S.normalizeDays({ ...WEEK, monday: 'x'.repeat(61) }), (e) => e.code === 'name_too_long');
  assert.equal(S.normalizeDays({ ...WEEK, monday: 'x'.repeat(60) }).monday.length, 60);
  assert.throws(() => S.normalizeDays({ ...WEEK, monday: 5 }), (e) => e.code === 'bad_days');
  for (const bad of [null, 'Вика', ['Вика']]) assert.throws(() => S.normalizeDays(bad), (e) => e.code === 'bad_days');
  // лишние ключи не попадают в запись
  assert.equal('hack' in S.normalizeDays({ ...WEEK, hack: 'x' }), false);
});

test('weekLabel / weekRange / diffDays / logSummary', () => {
  assert.equal(S.weekLabel('2026-09-28'), '28.09-04.10');
  assert.equal(S.weekRange('2026-12-28'), '28.12–03.01.2027');
  assert.deepEqual(S.diffDays(WEEK, { ...WEEK, wednesday: 'Оля' }), [{ day: 'wednesday', from: 'Юля', to: 'Оля' }]);
  assert.equal(S.diffDays(null, WEEK).length, 7);
  assert.deepEqual(S.diffDays({ ...WEEK, monday: 'Вика ' }, WEEK), [], 'хвостовой пробел — не изменение');
  assert.equal(S.logSummary('update', '2026-09-28', WEEK, [{ day: 'wednesday', from: 'Юля', to: 'Оля' }]), 'Změna rozpisu směn: 28.09–04.10.2026 · St Юля → Оля');
  assert.equal(S.logSummary('update', '2026-09-28', WEEK, []), 'Rozpis směn uložen: 28.09–04.10.2026 · beze změny dnů');
  assert.match(S.logSummary('create', '2026-09-28', WEEK), /^Nový rozpis směn: 28\.09–04\.10\.2026 · Po Вика · Út Вика · St Юля/);
});

test('suggestNames: частые сверху, «-» и пустые не предлагаются, пробелы не плодят дубли', () => {
  const names = S.suggestNames([WEEK, { ...WEEK, monday: 'Кристина ', tuesday: 'Кристина', wednesday: '-', thursday: '' }]);
  assert.deepEqual(names.slice(0, 2), ['Вика', 'Юля']);
  assert.ok(names.includes('Кристина'));
  assert.equal(names.filter((n) => n.startsWith('Кристина')).length, 1);
  assert.ok(!names.includes('-') && !names.includes(''));
});

test('assertBase: undefined — без проверки, null — недели не было, время сравнивается как момент', () => {
  S.assertBase(undefined, { updatedAt: '2026-09-20T08:00:00.000Z' });
  S.assertBase(null, null);
  S.assertBase('2026-09-20T08:00:00Z', { updatedAt: '2026-09-20T08:00:00.000Z' });
  assert.throws(() => S.assertBase(null, { updatedAt: '2026-09-20T08:00:00.000Z' }), (e) => e.code === 'shift_changed' && e.status === 409);
  assert.throws(() => S.assertBase('2026-09-20T08:00:00.000Z', null), (e) => e.code === 'shift_changed');
  assert.throws(() => S.assertBase('2026-09-20T08:00:01.000Z', { updatedAt: '2026-09-20T08:00:00.000Z' }), (e) => e.code === 'shift_changed');
});

// ── сервис ─────────────────────────────────────────────────────────────────
test('list: окно недель по понедельникам, дыры = null, published, подсказки из прошлых недель', async () => {
  makeStrapi([
    { documentId: 'old', from: '2026-08-03', days: { ...WEEK, monday: 'Оля' } }, // вне окна — только для подсказок
    { documentId: 'w1', from: '2026-09-21', to: '2026-09-27' },
    { documentId: 'w2', from: '2026-09-28', published: false, days: { ...WEEK, sunday: 'Кристина' } },
    { documentId: 'odd', from: '2026-10-08' }, // не понедельник (как старые записи 2025) — в окно не попадает
  ]);
  const res = await svc.list({ from: '2026-09-21', weeks: '3', now: NOW });
  assert.equal(res.from, '2026-09-21');
  assert.deepEqual(res.weeks.map((w) => w.monday), ['2026-09-21', '2026-09-28', '2026-10-05']);
  assert.equal(res.weeks[0].documentId, 'w1');
  assert.equal(res.weeks[0].published, true);
  assert.equal(res.weeks[0].sunday, '2026-09-27');
  assert.deepEqual(res.weeks[0].days, WEEK);
  assert.equal(res.weeks[1].published, false, 'черновик без публикации');
  assert.equal(res.weeks[1].days.sunday, 'Кристина');
  assert.equal(res.weeks[2].documentId, null);
  assert.equal(res.weeks[2].days, null);
  assert.ok(res.names.includes('Оля'), 'подсказки берутся и из недель до окна');
  assert.ok(res.names.includes('Кристина'));
  await expectErr(() => svc.list({ from: '2026-09-22', now: NOW }), 400, 'bad_monday');
});

test('list: две записи на понедельник → duplicate', async () => {
  makeStrapi([{ documentId: 'a', from: '2026-09-28' }, { documentId: 'b', from: '2026-09-28' }]);
  const res = await svc.list({ from: '2026-09-28', weeks: 1, now: NOW });
  assert.equal(res.weeks[0].duplicate, true);
});

test('save: новая неделя — одна запись, обе версии, to = воскресенье, подпись, журнал shift_create', async () => {
  const st = makeStrapi();
  const res = await svc.save({ session: SESSION, monday: '2026-10-05', body: { days: { ...WEEK, monday: ' Вика ' }, base: null }, now: NOW });
  assert.equal(res.unchanged, false);
  assert.equal(res.week.monday, '2026-10-05');
  assert.equal(res.week.published, true);
  assert.ok(res.week.updatedAt);
  const versions = st.rows.filter((r) => r.from === '2026-10-05');
  assert.deepEqual(versions.map((r) => r.published).sort(), [false, true]);
  for (const v of versions) {
    assert.equal(v.to, '2026-10-11');
    assert.equal(v.week, '05.10-11.10');
    assert.equal(v.days.monday, 'Вика');
  }
  assert.equal(st.logs.length, 1);
  assert.equal(st.logs[0].action, 'shift_create');
  assert.equal(st.logs[0].entityType, 'shift');
  assert.equal(st.logs[0].actorName, 'Mariia Medvedeva');
  assert.equal(st.logs[0].details.Po, 'Вика');
});

test('save: правка — черновик обновлён и опубликован, «было → стало» в журнале, опечатка в to исправлена', async () => {
  const st = makeStrapi([{ documentId: 'w', from: '2026-09-28', to: '2026-09-28', week: '28.09-4.10' }]);
  const base = st.rows[0].updatedAt;
  const res = await svc.save({ session: SESSION, monday: '2026-09-28', body: { days: { ...WEEK, wednesday: 'Оля' }, base }, now: NOW });
  assert.equal(res.week.documentId, 'w');
  assert.notEqual(res.week.updatedAt, base, 'updatedAt сдвинулся');
  const [draft, pub] = [st.rows.find((r) => !r.published), st.rows.find((r) => r.published)];
  assert.equal(draft.days.wednesday, 'Оля');
  assert.equal(pub.days.wednesday, 'Оля', 'опубликованная версия = черновик');
  assert.equal(draft.to, '2026-10-04');
  assert.equal(st.rows.length, 2, 'документ не размножился');
  assert.deepEqual(st.calls.filter((c) => c[0] === 'update' || c[0] === 'publish').map((c) => c[0]), ['update', 'publish']);
  assert.equal(st.logs[0].action, 'shift_update');
  assert.equal(st.logs[0].summary, 'Změna rozpisu směn: 28.09–04.10.2026 · St Юля → Оля');
  assert.equal(st.logs[0].details.St, 'Юля → Оля');
  assert.equal(st.logs[0].details.Po, 'Вика');
});

test('save: без изменений и уже опубликовано — ничего не пишется', async () => {
  const st = makeStrapi([{ documentId: 'w', from: '2026-09-28', to: '2026-10-04', week: '28.09-04.10' }]);
  const res = await svc.save({ session: SESSION, monday: '2026-09-28', body: { days: WEEK, base: st.rows[0].updatedAt }, now: NOW });
  assert.equal(res.unchanged, true);
  assert.equal(st.calls.filter((c) => ['update', 'publish', 'create'].includes(c[0])).length, 0);
  assert.equal(st.logs.length, 0);
});

test('save: те же дни, но черновик не опубликован — публикуется', async () => {
  const st = makeStrapi([{ documentId: 'w', from: '2026-09-28', to: '2026-10-04', week: '28.09-04.10', published: false }]);
  const res = await svc.save({ session: SESSION, monday: '2026-09-28', body: { days: WEEK }, now: NOW });
  assert.equal(res.unchanged, false);
  assert.equal(st.rows.filter((r) => r.published).length, 1);
});

test('save: чужая правка между загрузкой и сохранением → 409, данные не тронуты', async () => {
  const st = makeStrapi([{ documentId: 'w', from: '2026-09-28' }]);
  await expectErr(
    () => svc.save({ session: SESSION, monday: '2026-09-28', body: { days: { ...WEEK, monday: 'Оля' }, base: '2026-01-01T00:00:00.000Z' }, now: NOW }),
    409,
    'shift_changed'
  );
  // «недели не было», а её уже кто-то создал
  await expectErr(
    () => svc.save({ session: SESSION, monday: '2026-09-28', body: { days: WEEK, base: null }, now: NOW }),
    409,
    'shift_changed'
  );
  assert.equal(st.rows.find((r) => !r.published).days.monday, 'Вика');
  assert.equal(st.logs.length, 0);
});

test('save: две записи на неделю → 409 shift_duplicate, ничего не пишется', async () => {
  const st = makeStrapi([{ documentId: 'a', from: '2026-09-28' }, { documentId: 'b', from: '2026-09-28' }]);
  await expectErr(() => svc.save({ session: SESSION, monday: '2026-09-28', body: { days: WEEK }, now: NOW }), 409, 'shift_duplicate');
  assert.equal(st.calls.filter((c) => c[0] !== 'findMany').length, 0);
});

test('save: проверки формы до обращения к базе', async () => {
  const st = makeStrapi();
  await expectErr(() => svc.save({ session: SESSION, monday: '2026-09-29', body: { days: WEEK }, now: NOW }), 400, 'bad_monday');
  await expectErr(() => svc.save({ session: SESSION, monday: '2026-09-28', body: { days: { ...WEEK, friday: '' } }, now: NOW }), 400, 'day_required');
  await expectErr(() => svc.save({ session: SESSION, monday: '2026-09-28', body: null, now: NOW }), 400, 'bad_days');
  assert.equal(st.calls.length, 0);
});

test('remove: обе версии удалены, журнал со списком дней; нет недели → 404; устаревшая base → 409', async () => {
  const st = makeStrapi([{ documentId: 'w', from: '2026-09-28' }, { documentId: 'z', from: '2026-10-05' }]);
  await expectErr(() => svc.remove({ session: SESSION, monday: '2026-10-05', base: '2020-01-01T00:00:00Z', now: NOW }), 409, 'shift_changed');
  assert.equal(st.rows.filter((r) => r.documentId === 'z').length, 2);
  const res = await svc.remove({ session: SESSION, monday: '2026-09-28', now: NOW });
  assert.deepEqual(res, { deleted: '2026-09-28' });
  assert.equal(st.rows.filter((r) => r.documentId === 'w').length, 0);
  assert.equal(st.logs[0].action, 'shift_delete');
  assert.match(st.logs[0].summary, /^Smazán rozpis směn: 28\.09–04\.10\.2026 · Po Вика/);
  await expectErr(() => svc.remove({ session: SESSION, monday: '2026-09-28', now: NOW }), 404, 'shift_not_found');
});
