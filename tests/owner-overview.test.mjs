// «Сейчас» на главной владельца (services/owner-overview.ts, s258):
//   - последняя закрытая смена — свежее shift_close без более позднего shift_revert того же дня;
//     результат (до/после) — только если страница его дописала, иначе null;
//   - касса — черновик последней записи: остаток, приход (строки ≥ 0) и расход (< 0),
//     признак «опубликована закрытием смены»;
//   - ручка GET /engine/admin/overview — только владелец.
// Запуск: cd strapi && node --test tests/owner-overview.test.mjs

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

const O = await import(dataUrl(toJs('src/api/booking-engine/services/owner-overview.ts')));
const svc = O.default;

const log = (action, date, createdAt, details = null, actorName = 'Dima') => ({ action, entityDocId: date, createdAt, details, actorName });

test('последняя закрытая смена: отменённое закрытие пропускается, результат — только дописанный', () => {
  const rows = [
    log('shift_revert', '2026-10-13', '2026-10-14T08:00:00Z'),
    log('shift_close', '2026-10-13', '2026-10-13T20:00:00Z', { zveřejněno: 9, resultBefore: 1000, resultAfter: 4250.5 }),
    log('shift_close', '2026-10-12', '2026-10-12T20:00:00Z', JSON.stringify({ zveřejněno: 7, resultBefore: -200, resultAfter: 1000 })),
    log('shift_close', '2026-10-11', '2026-10-11T20:00:00Z', { zveřejněno: 5 }),
  ];
  assert.deepEqual(O.pickLastClosedShift(rows), {
    date: '2026-10-12',
    closedAt: '2026-10-12T20:00:00.000Z',
    by: 'Dima',
    published: 7,
    result: { before: -200, after: 1000 },
  });
  // без результата (закрытие до s258) — result null, но смена есть
  assert.deepEqual(O.pickLastClosedShift(rows.slice(3)).result, null);
  assert.equal(O.pickLastClosedShift(rows.slice(3)).date, '2026-10-11');
  // закрыли, отменили, закрыли снова — берём новое закрытие
  const again = [log('shift_close', '2026-10-13', '2026-10-14T09:00:00Z', { resultBefore: 1, resultAfter: 2 }), ...rows];
  assert.equal(O.pickLastClosedShift(again).date, '2026-10-13');
  assert.deepEqual(O.pickLastClosedShift(again).result, { before: 1, after: 2 });
  assert.equal(O.pickLastClosedShift([]), null);
  assert.equal(O.pickLastClosedShift([log('shift_revert', '2026-10-13', '2026-10-14T08:00:00Z')]), null);
});

test('касса: остаток, приход и расход из строк потока, автор', () => {
  const doc = { date: '2026-10-13', sum: '12 350', name: '', personal: { name: 'Viktoriia' }, flow: [{ sum: '4200' }, { sum: '-350' }, { sum: '0' }, { sum: '1 100' }] };
  assert.deepEqual(O.cashView(doc, true), { date: '2026-10-13', balance: 12350, income: 5300, outflow: -350, name: 'Viktoriia', closed: true });
  assert.deepEqual(O.cashView({ date: '2026-10-14', sum: '12,5', name: 'Anna', flow: null }, false), {
    date: '2026-10-14',
    balance: 12.5,
    income: 0,
    outflow: 0,
    name: 'Anna',
    closed: false,
  });
  assert.equal(O.cashView(null, false), null);
});

test('сервис: черновик последней записи кассы + «опубликована»; журнал — свежие записи обоих действий', async () => {
  const calls = [];
  globalThis.strapi = {
    documents: (uid) => ({
      async findFirst(q) {
        calls.push(['findFirst', uid, q.status, q.sort]);
        return { documentId: 'c1', date: '2026-10-13', sum: '900', flow: [{ sum: 900 }] };
      },
      async findOne(q) {
        calls.push(['findOne', uid, q.documentId, q.status]);
        return null;
      },
    }),
    db: {
      query: (uid) => ({
        async findMany(q) {
          calls.push(['findMany', uid, q.where, q.orderBy, q.limit]);
          return [log('shift_close', '2026-10-13', '2026-10-13T20:00:00Z', { resultBefore: 0, resultAfter: 900 })];
        },
      }),
    },
  };
  const r = await svc.overview();
  assert.deepEqual(r.cash, { date: '2026-10-13', balance: 900, income: 900, outflow: 0, name: '', closed: false });
  assert.deepEqual(r.lastShift.result, { before: 0, after: 900 });
  assert.deepEqual(calls[0], ['findFirst', 'api::cash.cash', 'draft', { date: 'desc' }]);
  assert.deepEqual(calls[2], ['findOne', 'api::cash.cash', 'c1', 'published']);
  assert.deepEqual(calls[1], [
    'findMany',
    'api::calendar-log.calendar-log',
    { entityType: 'shift_close', action: { $in: ['shift_close', 'shift_revert'] } },
    { createdAt: 'desc' },
    O.LOG_LOOKBACK,
  ]);
});

test('ручки: обзор — только владелец; результат смены — руководство', () => {
  const routes = read('src/api/booking-engine/routes/booking-engine.ts');
  const ctrl = read('src/api/booking-engine/controllers/booking-engine.ts');
  assert.ok(routes.includes("admin('GET', '/engine/admin/overview', 'booking-engine.adminOwnerOverview')"));
  assert.ok(routes.includes("admin('POST', '/engine/admin/shift-close/result', 'booking-engine.adminShiftCloseResult')"));
  const body = (name) => ctrl.slice(ctrl.indexOf(`async ${name}(ctx)`)).split('\n').slice(0, 4).join('\n');
  assert.ok(body('adminOwnerOverview').includes('requireOwner(ctx)'), 'обзор — requireOwner');
  assert.ok(body('adminShiftCloseResult').includes('requireManagement(ctx)'), 'результат — requireManagement');
});
