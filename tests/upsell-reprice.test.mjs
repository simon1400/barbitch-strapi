// Пересчёт комиссии администратора при смене услуги у админской дозаписи (s233).
//   - комиссия = тот же процент от НОВОЙ полной цены; правится черновик add-money и booking.discount;
//   - опубликованная комиссия (смена закрыта) не трогается;
//   - чужие брони (thank-you, снятая скидка, без комиссии) не трогаются.
// Сервис — НАСТОЯЩИЙ upsell.ts на маленькой заглушке knex.
//
// Запуск: cd strapi && node --test tests/upsell-reprice.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const dir = 'src/api/booking-engine/services/';
const toJs = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const slotsUrl = dataUrl(toJs(dir + 'slots-core.ts'));
const swap = (js, pairs) => {
  for (const [from, to] of pairs) {
    assert.ok(js.includes(from), `импорт ${from} на месте`);
    js = js.split(from).join(`from '${to}'`);
  }
  return js;
};
const coreUrl = dataUrl(swap(toJs(dir + 'upsell-core.ts'), [["from './slots-core'", slotsUrl]]));
const svcJs = swap(toJs(dir + 'upsell.ts'), [
  ["from './slots-core'", slotsUrl],
  ["from './upsell-core'", coreUrl],
  ["from './booking-kind'", dataUrl(toJs(dir + 'booking-kind.ts'))],
  ["from './booking-engine'", dataUrl('export class EngineError extends Error {}')],
  ["from '../../../utils/staff-identity'", dataUrl(toJs('src/utils/staff-identity.ts'))],
]);
const U = (await import(dataUrl(svcJs))).default;

// заглушка knex: таблицы в памяти, where по одному полю, select/update
const world = (tables) => {
  const q = (table) => {
    let rows = tables[table];
    const api = {
      select: () => api,
      where: (col, val) => ((rows = rows.filter((r) => r[col] === val)), api),
      update: async (patch) => (rows.forEach((r) => Object.assign(r, patch)), rows.length),
      then: (res, rej) => Promise.resolve(rows.map((r) => ({ ...r }))).then(res, rej),
    };
    return api;
  };
  globalThis.strapi = {
    log: { info() {}, error() {}, warn() {} },
    db: { connection: Object.assign(q, { transaction: async (fn) => fn(q) }) },
  };
  return tables;
};
const discount = (over = {}) => ({
  type: 'rebook', source: 'admin', applied: true, percent: 10, discountKc: 104, originalPrice: 1045,
  commission: { percent: 5, kc: 50, addMoneyDocId: 'am1' },
  ...over,
});
const fresh = (d, money) =>
  world({
    bookings: [{ document_id: 'b1', discount: JSON.stringify(d) }],
    add_moneys: money ?? [{ document_id: 'am1', sum: '50', published_at: null }],
  });

test('комиссия пересчитывается от новой полной цены: черновик и booking.discount', async () => {
  const t = fresh(discount());
  assert.deepEqual(await U.repriceCommissionDraft('b1', 1045), { from: 50, to: 52 });
  assert.equal(t.add_moneys[0].sum, '52');
  const d = JSON.parse(t.bookings[0].discount);
  assert.equal(d.commission.kc, 52);
  assert.equal(d.commission.addMoneyDocId, 'am1');
  assert.equal(d.discountKc, 104); // скидку клиента не трогаем — её считает движок
});

test('цена уменьшилась — комиссия тоже', async () => {
  const t = fresh(discount());
  assert.deepEqual(await U.repriceCommissionDraft('b1', 330), { from: 50, to: 17 });
  assert.equal(t.add_moneys[0].sum, '17');
});

test('та же сумма — ничего не пишется', async () => {
  const t = fresh(discount());
  assert.equal(await U.repriceCommissionDraft('b1', 990), null);
  assert.equal(t.add_moneys[0].updated_at, undefined);
});

test('опубликованная комиссия не трогается', async () => {
  const t = fresh(discount(), [
    { document_id: 'am1', sum: '50', published_at: null },
    { document_id: 'am1', sum: '50', published_at: new Date() },
  ]);
  assert.equal(await U.repriceCommissionDraft('b1', 1045), null);
  assert.deepEqual(t.add_moneys.map((r) => r.sum), ['50', '50']);
  assert.equal(JSON.parse(t.bookings[0].discount).commission.kc, 50);
});

test('чужие записи комиссий не задеваются', async () => {
  const t = fresh(discount(), [
    { document_id: 'am1', sum: '50', published_at: null },
    { document_id: 'am2', sum: '33', published_at: null },
  ]);
  await U.repriceCommissionDraft('b1', 1045);
  assert.equal(t.add_moneys[1].sum, '33');
});

test('не админская дозапись, снятая скидка, без комиссии, без брони — null', async () => {
  for (const d of [
    discount({ source: undefined }),
    discount({ applied: false }),
    discount({ commission: { percent: 5, kc: 50, addMoneyDocId: null } }),
  ]) {
    const t = fresh(d);
    assert.equal(await U.repriceCommissionDraft('b1', 1045), null);
    assert.equal(t.add_moneys[0].sum, '50');
  }
  fresh(discount());
  assert.equal(await U.repriceCommissionDraft('nope', 1045), null);
  assert.equal(await U.repriceCommissionDraft(null, 1045), null);
});

test('движок зовёт пересчёт после смены услуги у админской дозаписи и пишет его в журнал', () => {
  const src = fs.readFileSync(path.join(root, dir + 'booking-engine.ts'), 'utf8');
  assert.match(src, /discountReprice\?\.kind === 'rebook' && booking\.discount\?\.source === 'admin'/);
  assert.match(src, /\.repriceCommissionDraft\(bookingDocId, discountReprice\.fullPrice\)/);
  assert.match(src, /logDetails\['provize'\]/);
});
