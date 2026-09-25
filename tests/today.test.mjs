// Дашборд «Сегодня» (services/today.ts, s214): чистые функции + связка overview().
// SQL сервиса проверен живым прогоном против прод-БД в режиме read-only (скрипт в
// scratchpad s214): сегодня пусто, на 03.08 — 13 визитов без записи и 2 дня
// с черновиками часов. Здесь — формы ответа, окна дат и то, что ключевые предикаты
// запроса на месте.
//
// Запуск: cd strapi && node --test tests/today.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = path.resolve(import.meta.dirname, '../src');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const transpile = (code) =>
  ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } })
    .outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const slotsUrl = dataUrl(transpile(read('api/booking-engine/services/slots-core.ts')));
const SRC = read('api/booking-engine/services/today.ts');
assert.ok(SRC.includes("from './slots-core';"), 'today импортирует slots-core');
const T = await import(dataUrl(transpile(SRC.split("from './slots-core';").join(`from '${slotsUrl}';`))));

test('resolveDate: валидная дата как есть, мусор → пражское сегодня', () => {
  const now = new Date('2026-09-25T22:30:00Z'); // в Праге уже 26.09 00:30
  assert.equal(T.resolveDate('2026-09-10', now), '2026-09-10');
  for (const bad of [undefined, null, '', '2026-9-1', "2026-09-10' or 1=1", '2026-13-45x']) {
    assert.equal(T.resolveDate(bad, now), '2026-09-26', String(bad));
  }
});

test('todayRanges: окна дат включительно, через границу месяца', () => {
  const r = T.todayRanges('2026-10-03');
  assert.deepEqual(r.visits, { from: '2026-09-27', to: '2026-10-03' });
  assert.deepEqual(r.shifts, { from: '2026-09-19', to: '2026-10-02' });
  assert.equal(r.vouchersPaidFrom, '2026-09-27');
  assert.equal(r.vouchersUnpaidFrom, '2026-09-04');
  // сегодняшние черновики — норма до закрытия смены, в «незакрытые смены» не идут
  assert.ok(r.shifts.to < '2026-10-03');
});

test('mapUnclosedVisit: причина по статусу, услуги из json-строки и массива', () => {
  const a = T.mapUnclosedVisit({
    documentId: 'b1', date: '2026-09-24', startsAt: new Date('2026-09-24T08:00:00Z'), status: 'active',
    arrived: null, internal: null, korekce: true, client: 'Anna', master: 'Yana',
    services: JSON.stringify([{ title: 'Gel lak' }, { title: ' ' }, {}]),
  });
  assert.deepEqual(a, {
    documentId: 'b1', date: '2026-09-24', startsAt: '2026-09-24T08:00:00.000Z', status: 'active',
    reason: 'not_closed', arrived: false, internal: false, korekce: true, client: 'Anna', master: 'Yana',
    services: ['Gel lak'],
  });
  const b = T.mapUnclosedVisit({ documentId: 'b2', status: 'checkedOut', arrived: true, services: [{ title: 'Řasy' }] });
  assert.equal(b.reason, 'checked_out_no_record');
  assert.equal(b.arrived, true);
  assert.deepEqual(b.services, ['Řasy']);
  assert.deepEqual(T.mapUnclosedVisit({ status: 'active', services: '{oops' }).services, []);
});

test('mergeOpenShifts: услуги и часы по дням, пустые дни выкинуты, сортировка', () => {
  const out = T.mergeOpenShifts(
    [{ date: '2026-09-22', n: '2' }, { date: '2026-09-20', n: 1 }],
    [{ date: '2026-09-22', n: '1' }, { date: '2026-09-21', n: 0 }],
  );
  assert.deepEqual(out, [
    { date: '2026-09-20', services: 1, hours: 0 },
    { date: '2026-09-22', services: 2, hours: 1 },
  ]);
  assert.deepEqual(T.mergeOpenShifts(null, undefined), []);
});

test('mapKorekcePending: одна строка на документ (черновик приоритетнее), только record+pending', () => {
  const j = (extra) => ({
    mode: 'record', pending: true, clientName: 'Kratochvílová', korekceDate: '2026-09-23', master: 'Zlata',
    originalDate: '2026-09-20', originalMaster: 'Yana', originalBookingDocId: 'orig', korekceBookingDocId: 'kor',
    staffInKc: 576, staffOutKc: '432', ...extra,
  });
  const out = T.mapKorekcePending([
    { document_id: 'sp1', published_at: '2026-09-24', korekce: j({ staffInKc: 1 }) },
    { document_id: 'sp1', published_at: null, korekce: JSON.stringify(j()) },
    { document_id: 'sp2', published_at: null, korekce: j({ pending: false }) },
    { document_id: 'sp3', published_at: null, korekce: j({ mode: 'payroll' }) },
    { document_id: 'sp4', published_at: null, korekce: 'not json' },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    spDocId: 'sp1', clientName: 'Kratochvílová', korekceDate: '2026-09-23', korekceBookingDocId: 'kor',
    master: 'Zlata', originalDate: '2026-09-20', originalBookingDocId: 'orig', originalMaster: 'Yana',
    staffInKc: 576, staffOutKc: 432,
  });
});

test('mapVoucher: сумма числом, «for» из алиаса', () => {
  assert.deepEqual(
    T.mapVoucher({ documentId: 'v', idVoucher: '5416', name: 'Adam', forName: 'Nicol', sum: '1000', dateOrder: '2026-09-24', datePay: null }),
    { documentId: 'v', idVoucher: '5416', name: 'Adam', for: 'Nicol', sum: 1000, dateOrder: '2026-09-24', datePay: null },
  );
});

test('overview: одна дата и одни окна во все четыре блока', async () => {
  const calls = {};
  const svc = {
    ...T.default,
    unclosedVisits: async (range, now) => ((calls.v = { range, now }), []),
    openShifts: async (range) => ((calls.s = range), []),
    korekcePending: async () => ((calls.k = true), []),
    vouchers: async (r) => ((calls.w = r), { paidRecent: [], unpaid: [] }),
  };
  const now = new Date('2026-09-25T10:00:00Z');
  const res = await svc.overview({ date: 'junk', now });
  assert.equal(res.date, '2026-09-25');
  assert.equal(res.now, now.toISOString());
  assert.deepEqual(calls.v.range, { from: '2026-09-19', to: '2026-09-25' });
  assert.equal(calls.v.now, now);
  assert.deepEqual(calls.s, { from: '2026-09-11', to: '2026-09-24' });
  assert.equal(calls.k, true);
  assert.equal(calls.w.vouchersPaidFrom, '2026-09-19');
  assert.deepEqual(Object.keys(res), ['date', 'now', 'unclosedVisits', 'openShifts', 'korekcePending', 'vouchers']);
});

test('предикаты запросов на месте', () => {
  const code = SRC.replace(/\r/g, '');
  // визит без записи: связь из метаданных, а не угаданное имя таблицы
  assert.ok(code.includes("joinTableOf(SP_UID, 'booking')"));
  assert.ok(code.includes('.whereNotExists(knex.select(1).from(`${jt.table} as l`).whereRaw(`l.${jt.targetCol} = b.id`))'));
  // active — только когда время визита вышло; checkedOut — всегда
  assert.ok(code.includes("a.where('b.status', 'active').where('b.ends_at', '<', nowUtc)).orWhere('b.status', 'checkedOut')"));
  // время — строкой UTC в обе стороны, не через часовой пояс процесса
  assert.ok(code.includes('const nowUtc = now.toISOString();'));
  assert.ok(code.includes(`to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt"`));
  // черновик без опубликованной версии, и по услугам, и по часам
  assert.ok(code.includes("whereRaw('p.document_id = t.document_id').whereNotNull('p.published_at')"));
  assert.ok(code.includes("draftsByDay('services_provided'), draftsByDay('work_times')"));
  // ваучеры: только опубликованные и нереализованные
  assert.ok(code.includes(".whereNotNull('published_at')\n        .whereNull('date_realized')"));
  // ничего не пишет
  assert.ok(!/\.(update|insert|del|delete)\(/.test(code), 'сервис только читает');
});
