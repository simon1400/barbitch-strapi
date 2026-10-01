// Бонус-ваучер bitchcard «Dárkový voucher 1000 Kč (od 10 000 Kč)» (s234):
//   - сид не досоздаёт удалённые ступени и сам ваучер не заводит;
//   - шторка календаря не предлагает «Uplatnit slevu» на ваучер и выключенную ступень;
//   - пересчёт наград не выдаёт код по ваучеру, применить его к брони нельзя;
//   - кабинет: bonusReward = null, ручки выдачи ваучера нет.
// Сервис — НАСТОЯЩИЙ loyalty.ts на заглушке document service.
//
// Запуск: cd strapi && node --test tests/loyalty-rewards.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const toJs = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const swap = (js, pairs) => {
  for (const [from, to] of pairs) {
    assert.ok(js.includes(from), `импорт ${from} на месте`);
    js = js.split(from).join(`from '${to}'`);
  }
  return js;
};
const engine = 'src/api/booking-engine/services/';
const svcJs = swap(toJs('src/api/loyalty/services/loyalty.ts'), [
  ["from 'crypto'", 'node:crypto'],
  ["from '../../booking-engine/services/slots-core'", dataUrl(toJs(engine + 'slots-core.ts'))],
  ["from '../../booking-engine/services/booking-kind'", dataUrl(toJs(engine + 'booking-kind.ts'))],
]);
const L = (await import(dataUrl(svcJs))).default;
process.env.LOYALTY_ENABLED = 'true';

const R = {
  p20: { documentId: 'r1', title: 'Sleva 20 %', thresholdKc: 3000, discountType: 'percent', discountValue: 20, active: true },
  f400: { documentId: 'r2', title: 'Sleva 400 Kč', thresholdKc: 5000, discountType: 'fixed', discountValue: 400, active: true },
  p50: { documentId: 'r3', title: 'Sleva 50 %', thresholdKc: 8000, discountType: 'percent', discountValue: 50, active: true },
  v1000: { documentId: 'r4', title: 'Dárkový voucher 1000 Kč', thresholdKc: 10000, discountType: 'voucher', discountValue: 1000, active: true },
};

// заглушка: rewards / redemptions / transactions в памяти; фильтры — только те,
// что использует сервис (active, client, reward, cardYear, status, code, usedInBookingDocId)
const world = ({ rewards = [], redemptions = [], balance = 0, registered = true }) => {
  const created = { reward: [], redemption: [] };
  const val = (f) => (f && typeof f === 'object' && '$eq' in f ? f.$eq : undefined);
  const matchRed = (r, f) => {
    if (!f) return true;
    if (f.$or) return f.$or.some((x) => matchRed(r, x));
    if (val(f.status) !== undefined && r.status !== val(f.status)) return false;
    if (val(f.code) !== undefined && r.code !== val(f.code)) return false;
    if (val(f.usedInBookingDocId) !== undefined && r.usedInBookingDocId !== val(f.usedInBookingDocId)) return false;
    if (f.reward?.documentId && r.reward?.documentId !== val(f.reward.documentId)) return false;
    if (f.cardYear && r.cardYear !== val(f.cardYear)) return false;
    return true;
  };
  const docs = (uid) => ({
    findMany: async ({ filters } = {}) => {
      if (uid === 'api::reward.reward') {
        const a = val(filters?.active);
        return rewards.filter((r) => a === undefined || r.active === a).map((r) => ({ ...r }));
      }
      if (uid === 'api::redemption.redemption') return redemptions.filter((r) => matchRed(r, filters));
      if (uid === 'api::loyalty-transaction.loyalty-transaction') return [{ delta: balance }];
      return [];
    },
    findOne: async () => ({ emailVerifiedAt: registered ? '2026-07-01' : null }),
    count: async ({ filters }) => redemptions.filter((r) => matchRed(r, filters)).length,
    create: async ({ data }) => {
      (uid === 'api::reward.reward' ? created.reward : created.redemption).push(data);
      return { documentId: 'new', ...data };
    },
    delete: async () => {},
    update: async () => {},
  });
  globalThis.strapi = {
    log: { info() {}, warn() {}, error() {} },
    documents: docs,
    db: { connection: () => ({ where: () => ({ update: async () => 0 }) }) },
  };
  return created;
};
const red = (reward, over = {}) => ({
  documentId: 'd-' + reward.documentId + (over.status || 'available'),
  status: 'available',
  code: 'C' + reward.documentId.toUpperCase(),
  cardYear: 2026,
  expiresAt: '2026-12-31T22:59:59.000Z',
  reward,
  ...over,
});

test('сид: наград уже есть (ваучера среди них нет) — ничего не создаёт', async () => {
  const c = world({ rewards: [R.p20, R.f400, R.p50] });
  assert.deepEqual(await L.ensureSeedRewards(), { seeded: 0 });
  assert.equal(c.reward.length, 0);
});

test('сид: удалённая ступень не возвращается', async () => {
  const c = world({ rewards: [R.p20, R.p50] });
  await L.ensureSeedRewards();
  assert.equal(c.reward.length, 0);
});

test('сид на пустой таблице: три ступени, без ваучера', async () => {
  const c = world({ rewards: [] });
  assert.deepEqual(await L.ensureSeedRewards(), { seeded: 3 });
  assert.deepEqual(c.reward.map((r) => r.thresholdKc), [3000, 5000, 8000]);
  assert.ok(c.reward.every((r) => r.discountType !== 'voucher'));
});

test('шторка: ваучер и выключенная ступень не предлагаются, применённая к брони видна', async () => {
  const off = { ...R.f400, active: false };
  world({
    rewards: [R.p20, off, R.p50, R.v1000],
    redemptions: [
      red(R.v1000),
      red(off),
      red(R.p50),
      red(R.p20, { status: 'used', usedInBookingDocId: 'b1', discountKc: 200 }),
    ],
  });
  const rows = await L.redemptionsForAdmin('c1', 'b1');
  assert.deepEqual(
    rows.map((r) => [r.status, r.reward.thresholdKc]),
    [['available', 8000], ['used', 3000]],
  );
});

test('шторка: клиентка с одним лишь ваучером (как Valérie, 16 010 Kč) — предложений нет', async () => {
  world({ rewards: [R.p20, R.f400, R.p50, R.v1000], redemptions: [red(R.v1000)], balance: 16010 });
  assert.deepEqual(await L.redemptionsForAdmin('c1', 'b1'), []);
});

test('пересчёт: баланс 16 010 — код по ваучеру не выдаётся', async () => {
  const c = world({ rewards: [R.p20, R.f400, R.p50, R.v1000], balance: 16010 });
  await L.recomputeClientRewards('c1', 2026);
  assert.deepEqual(c.redemption.map((r) => r.reward.documentId).sort(), ['r1', 'r2', 'r3']);
});

test('применение: ваучер и выключенная ступень — 409, цена не трогается', async () => {
  const off = { ...R.p50, active: false };
  world({ rewards: [R.v1000, off], redemptions: [red(R.v1000), red(off)], balance: 16010 });
  const booking = { documentId: 'b1', status: 'active', totalPrice: 1500 };
  for (const code of ['CR4', 'CR3']) {
    await assert.rejects(L.applyRedemptionToBooking(booking, code, 'c1'), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'redemption_unavailable');
      return true;
    });
  }
  assert.equal(booking.totalPrice, 1500);
});

test('прогресс: следующей наградой ваучер не считается', async () => {
  world({ rewards: [R.p20, R.f400, R.p50, R.v1000], balance: 9000 });
  assert.equal((await L.clientProgress('c1')).nextReward, null);
});

test('кабинет: трек без ваучера, bonusReward = null', async () => {
  world({ rewards: [R.p20, R.f400, R.p50, R.v1000], redemptions: [red(R.v1000)], balance: 16010 });
  const res = await L.loyaltyForClient('c1');
  assert.deepEqual(res.track.map((t) => t.thresholdKc), [3000, 5000, 8000]);
  assert.equal(res.bonusReward, null);
});

test('выдачи бонус-ваучера нет: ни метода сервиса, ни ручки кабинета', () => {
  assert.equal(L.claimVoucherReward, undefined);
  const routes = fs.readFileSync(path.join(root, 'src/api/client-cabinet/routes/client-cabinet.ts'), 'utf8');
  assert.ok(!routes.includes('/cabinet/loyalty/voucher'));
  assert.ok(!routes.includes('claimVoucher'));
});
