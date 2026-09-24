// Юнит-тесты общего модуля verify-флагов (utils/verify-flags.ts) — без БД/Strapi.
// Модуль самодостаточен (0 импортов) → транспилируем и импортируем как data-URL.
//
// Фикстуры — РЕАЛЬНЫЕ строки прода (сентябрь 2026, read-only SELECT s203):
//   4754  Gel lak 1300 (снапшот) → оплачено 650 (бумажная карта −50 %), мастер 45 %
//   4771  Prodloužení 1040 → 300 (модель у Yany), rate 30, мастер 100 / салон 200
//   4877  Prodloužení 880 → 748, дозапись −15 % (rebook applied, 132 Kč), rate 30
//   4681  цена 1180 = снапшот 1180 при priceOverride=true (ручная = каталожная)
//
// Запуск: cd strapi && node --test tests/verify-flags.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/utils/verify-flags.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const vf = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

const snap = (price, extra = {}) => [{ title: 'x', price, seniorPrice: price, ...extra }];
const B4754 = { services: snap(1300), totalPrice: '650.00', priceOverride: true, discount: null };
const B4771 = { services: snap(1040), totalPrice: '300.00', priceOverride: true, discount: null };
const B4877 = {
  services: snap(880),
  totalPrice: '748.00',
  priceOverride: true,
  discount: { type: 'rebook', applied: true, discountKc: 132 },
};
const B4681 = { services: snap(1180), totalPrice: '1180.00', priceOverride: true, discount: null };
const SITE = { services: snap(990), totalPrice: '990.00', priceOverride: false, discount: null };

test('bookingPricing: полная цена = Σ снапшота ВСЕГДА (вариант «а»), дельта = ручная разница', () => {
  const p = vf.bookingPricing(B4754);
  assert.equal(p.fullPrice, 1300);
  assert.equal(p.catalogPrice, 1300);
  assert.equal(p.paidExpected, 650);
  assert.equal(p.manualDeltaKc, -650);
  assert.equal(p.systemDiscountKc, 0);
  // без изменений — дельта 0
  assert.equal(vf.bookingPricing(SITE).manualDeltaKc, 0);
  assert.equal(vf.bookingPricing(B4681).manualDeltaKc, 0);
  // завышение — положительная дельта
  assert.equal(vf.bookingPricing({ ...SITE, totalPrice: '1190' }).manualDeltaKc, 200);
});

test('bookingPricing: системные скидки (rebook / bitchcard) НЕ считаются ручными', () => {
  const p = vf.bookingPricing(B4877);
  assert.equal(p.fullPrice, 880);
  assert.equal(p.manualDeltaKc, 0);
  assert.equal(p.systemDiscountKc, 132);
  // bitchcard: redemptionKc передаёт вызывающий
  const bc = vf.bookingPricing({ ...SITE, totalPrice: '790', priceOverride: true }, null, { redemptionKc: 200 });
  assert.equal(bc.manualDeltaKc, 0);
  assert.equal(bc.systemDiscountKc, 200);
  // дозапись −15 % И ещё админ снизил руками → обе части видны отдельно
  const both = vf.bookingPricing({ ...B4877, totalPrice: '648' });
  assert.equal(both.systemDiscountKc, 132);
  assert.equal(both.manualDeltaKc, -100);
});

test('bookingPricing: легаси-снапшот без цен → полная цена = оплачено + системные, дельты нет', () => {
  const p = vf.bookingPricing({ services: [{ title: 'x' }], totalPrice: '500', priceOverride: true });
  assert.equal(p.fullPrice, 500);
  assert.equal(p.manualDeltaKc, 0);
  const s = vf.bookingPricing({ services: '[{"price":700}]', totalPrice: '350' });
  assert.equal(s.fullPrice, 700);
  assert.equal(s.manualDeltaKc, -350);
});

test('computeBookingFlags: бумажная карта −50 % (4754) → 💰 cena_rucne, мастер от каталожной = ok', () => {
  const flags = vf.computeBookingFlags({
    booking: B4754, ratePercent: 45, staffSalaries: 585, salonSalaries: 65, sale: null, internal: false,
  });
  assert.deepEqual(flags, ['cena_rucne']);
  // раньше эта строка получала 🟦 sleva — системной скидки тут нет, 🟦 больше не ставится
  assert.ok(!flags.includes('sleva'));
});

test('computeBookingFlags: модель Yany 300 Kč (4771) → мастер получил меньше нормы от каталожной + 💰', () => {
  const flags = vf.computeBookingFlags({
    booking: B4771, ratePercent: 30, staffSalaries: 100, salonSalaries: 200, sale: null, internal: false,
  });
  // mustStaff = 312 → 100 < 312; mustSalon = 300 − 312 < 0 → салон 200 > → salon_up
  assert.ok(flags.includes('mistr_down'));
  assert.ok(flags.includes('cena_rucne'));
  assert.ok(!flags.includes('mistr_up'));
});

test('computeBookingFlags: дозапись −15 % (4877) → 🟦 sleva без 💰', () => {
  const flags = vf.computeBookingFlags({
    booking: B4877, ratePercent: 30, staffSalaries: 264, salonSalaries: 484, sale: null, internal: false,
  });
  assert.deepEqual(flags, ['sleva']);
});

test('computeBookingFlags: без изменений → ok; ручная цена = каталожной (4681) → ok', () => {
  assert.deepEqual(
    vf.computeBookingFlags({ booking: SITE, ratePercent: 40, staffSalaries: 396, salonSalaries: 594, sale: null, internal: false }),
    ['ok'],
  );
  assert.deepEqual(
    vf.computeBookingFlags({ booking: B4681, ratePercent: 45, staffSalaries: 531, salonSalaries: 649, sale: null, internal: false }),
    ['ok'],
  );
});

test('computeBookingFlags: 💰 ставится и у интерной услуги, и при завышении', () => {
  const up = vf.computeBookingFlags({
    booking: { ...SITE, totalPrice: '1190' }, ratePercent: 40, staffSalaries: 396, salonSalaries: 794, sale: null, internal: false,
  });
  assert.deepEqual(up, ['cena_rucne']);
  const internal = vf.computeBookingFlags({
    booking: B4754, ratePercent: 45, staffSalaries: 585, salonSalaries: 0, sale: null, internal: true,
  });
  assert.deepEqual(internal, ['internal', 'cena_rucne']);
});

test('computeOfferFlags (легаси-путь) не тронут: те же флаги, 💰 не ставится', () => {
  assert.deepEqual(vf.computeOfferFlags(1000, 30, 300, 700, null, false), ['ok']);
  assert.deepEqual(vf.computeOfferFlags(1000, 30, 300, 500, '20%', false), ['sleva']);
  assert.deepEqual(vf.computeOfferFlags(1000, 30, 350, 700, null, false), ['mistr_up']);
});

// ── s210: перенос доли при бесплатной коррекции ─────────────────────────────
// Прод-случай Kratochvílové: 20.09 Yana 30 % 1440 Kč → коррекция 23.09 у Zlaty 40 %.
const ORIG = { services: snap(1440), totalPrice: '1440.00', priceOverride: false, discount: null };
const KOR = { services: snap(1100), totalPrice: '0.00', priceOverride: true, discount: null };
const OUT = { korekceStaffOutKc: '432.00', korekceSalonAdjKc: '-144.00' };
const JSON_IN = { mode: 'record', staffInKc: 576, baseKc: 1440 };

test('korekceFlagInput: нет переноса → null; аккумуляторы и json читаются, json-строка тоже', () => {
  assert.equal(vf.korekceFlagInput({}), null);
  assert.equal(vf.korekceFlagInput(null), null);
  assert.equal(vf.korekceFlagInput({ korekce: { mode: 'weird' } }), null);
  assert.deepEqual(vf.korekceFlagInput(OUT), { staffInKc: null, staffOutKc: 432, salonAdjKc: -144 });
  assert.deepEqual(vf.korekceFlagInput({ korekce: JSON_IN }), { staffInKc: 576, staffOutKc: 0, salonAdjKc: 0 });
  assert.deepEqual(vf.korekceFlagInput({ korekce: JSON.stringify(JSON_IN) }), { staffInKc: 576, staffOutKc: 0, salonAdjKc: 0 });
  assert.equal(vf.korekceFlagInput({ korekce: { mode: 'same_master', staffInKc: 999 } }).staffInKc, 0);
  assert.equal(vf.korekceFlagInput({ korekce: { mode: 'payroll', staffInKc: 576 } }).staffInKc, 576);
});

test('исходная запись после переноса (0 / 864) → только 🔁, без 🟨↓ и 🟥', () => {
  const k = vf.korekceFlagInput(OUT);
  assert.deepEqual(
    vf.computeBookingFlags({ booking: ORIG, ratePercent: 30, staffSalaries: 0, salonSalaries: 864, sale: null, internal: false, korekce: k }),
    ['korekce'],
  );
  // без учёта аккумуляторов та же запись выглядела бы ошибкой — ровно ложный минус s209
  assert.deepEqual(
    vf.computeBookingFlags({ booking: ORIG, ratePercent: 30, staffSalaries: 0, salonSalaries: 864, sale: null, internal: false }),
    ['mistr_down', 'ztrata'],
  );
  // админ ввёл старые 432 / 1008 поверх переноса → видно, что мастер получил лишнее
  assert.deepEqual(
    vf.computeBookingFlags({ booking: ORIG, ratePercent: 30, staffSalaries: 432, salonSalaries: 1008, sale: null, internal: false, korekce: k }),
    ['mistr_up', 'salon_up', 'korekce'],
  );
});

test('запись коррекции: норма = доля исправителя, салон 0; ни 🟦, ни 💰 за 0 Kč', () => {
  const k = vf.korekceFlagInput({ korekce: JSON_IN });
  const f = (staff, salon = 0) =>
    vf.computeBookingFlags({ booking: KOR, ratePercent: 40, staffSalaries: staff, salonSalaries: salon, sale: null, internal: false, korekce: k });
  assert.deepEqual(f(576), ['korekce']);
  assert.deepEqual(f(732), ['mistr_up', 'korekce']);
  assert.deepEqual(f(500), ['mistr_down', 'korekce']);
  assert.deepEqual(f(576, 100), ['salon_up', 'korekce']);
  // без переноса та же бронь за 0 Kč — 💰 и 🟨↑ (как было на проде до модуля)
  assert.deepEqual(
    vf.computeBookingFlags({ booking: KOR, ratePercent: 40, staffSalaries: 576, salonSalaries: 0, sale: null, internal: false }),
    ['mistr_up', 'salon_up', 'cena_rucne'],
  );
});

test('частичная коррекция 144 Kč: исходная 388,8 / 993,6 → 🔁', () => {
  const k = vf.korekceFlagInput({ korekceStaffOutKc: 43.2, korekceSalonAdjKc: -14.4 });
  assert.deepEqual(
    vf.computeBookingFlags({ booking: ORIG, ratePercent: 30, staffSalaries: 388.8, salonSalaries: 993.6, sale: null, internal: false, korekce: k }),
    ['korekce'],
  );
});

test('тот же мастер: норма 0 / 0, 🔁 всегда', () => {
  const k = vf.korekceFlagInput({ korekce: { mode: 'same_master' } });
  const f = (staff) =>
    vf.computeBookingFlags({ booking: KOR, ratePercent: 40, staffSalaries: staff, salonSalaries: 0, sale: null, internal: false, korekce: k });
  assert.deepEqual(f(0), ['korekce']);
  assert.deepEqual(f(100), ['mistr_up', 'korekce']);
});

test('легаси-путь тоже понимает аккумуляторы (пересохранение исходной записи в CM)', () => {
  assert.deepEqual(vf.computeOfferFlags(1440, 30, 0, 864, null, false, vf.korekceFlagInput(OUT)), ['korekce']);
});

test('реестр: 🔁 информационный — ниже 💰, выше 🤝', () => {
  assert.equal(vf.FLAG_EMOJI.korekce, '🔁');
  const pr = vf.FLAG_PRIORITY;
  assert.equal(pr.indexOf('korekce'), pr.indexOf('cena_rucne') + 1);
  assert.ok(pr.indexOf('korekce') < pr.indexOf('internal'));
  assert.equal(vf.dominantEmoji(['korekce']), '🔁');
  assert.equal(vf.dominantEmoji(['mistr_up', 'korekce']), '🟨');
});

test('реестр флагов: 💰 в эмодзи и приоритете (выше информационных, ниже денежных ошибок)', () => {
  assert.equal(vf.FLAG_EMOJI.cena_rucne, '💰');
  const pr = vf.FLAG_PRIORITY;
  assert.ok(pr.indexOf('cena_rucne') > pr.indexOf('mistr_up'));
  assert.ok(pr.indexOf('cena_rucne') < pr.indexOf('sleva'));
  assert.equal(vf.dominantEmoji(['sleva', 'cena_rucne']), '💰');
  assert.equal(vf.dominantEmoji(['ztrata', 'cena_rucne']), '🟥');
});
