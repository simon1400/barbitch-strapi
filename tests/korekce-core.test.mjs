// Юнит-тесты гейта бесплатной коррекции (korekce-core.ts) — без БД/Strapi.
// korekce-core → upsell-core → slots-core: транспилируем все три и подменяем
// относительные импорты на data-URL уже транспилированных модулей.
//
// Запуск: cd strapi && node --test tests/korekce-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const dir = path.resolve(import.meta.dirname, '../src/api/booking-engine/services');
const transpile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(dir, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const slotsUrl = dataUrl(transpile('slots-core.ts'));
const upsellUrl = dataUrl(transpile('upsell-core.ts').split("from './slots-core'").join(`from '${slotsUrl}'`));
const coreJs = transpile('korekce-core.ts');
assert.ok(coreJs.includes("from './upsell-core'"), 'korekce-core импортирует upsell-core');
const core = await import(dataUrl(coreJs.split("from './upsell-core'").join(`from '${upsellUrl}'`)));

const NOW = Date.parse('2026-09-21T10:00:00Z');
const past = '2026-09-19T12:00:00Z';
const future = '2026-09-22T12:00:00Z';
const NAILS = 'Nehty 💅💅💅';
const LASH_EXT = 'Prodlužování řas 👁️👄👁️';
const LASH_CARE = 'Řasy – barvení a péče ☁️';
const visit = (o) => ({ status: 'checkedOut', startsAt: past, serviceTitle: 'Gel lak manikúra', serviceCategory: NAILS, ...o });

test('isKorekceTitle: обе коррекции каталога, без ложных срабатываний', () => {
  assert.equal(core.isKorekceTitle('Korekce do 5 dnů'), true);
  assert.equal(core.isKorekceTitle('  korekce do 5 dnů '), true);
  // платная «Úprava tvaru, korekce voskem» содержит слово, но не начинается с него
  assert.equal(core.isKorekceTitle('Úprava tvaru, korekce voskem / pinzetou'), false);
  assert.equal(core.isKorekceTitle(''), false);
  assert.equal(core.isKorekceTitle(null), false);
});

test('isFreeKorekceItem: бесплатная — да; платный вариант 150 Kč — нет; другая услуга — нет', () => {
  assert.equal(core.isFreeKorekceItem({ base: 'Korekce do 5 dnů', title: 'Korekce do 5 dnů' }, 0), true);
  assert.equal(core.isFreeKorekceItem({ base: 'Korekce do 5 dnů', title: 'Korekce do 5 dnů' }, '0.00'), true);
  assert.equal(
    core.isFreeKorekceItem({ base: 'Korekce do 5 dnů', title: 'Korekce do 5 dnů + mimo záruční podmínky' }, 150),
    false,
  );
  assert.equal(core.isFreeKorekceItem({ base: 'Gel lak manikúra', title: 'Gel lak manikúra' }, 0), false);
  assert.equal(core.isFreeKorekceItem(null, 0), false);
  // легаси-снапшот без base — по title
  assert.equal(core.isFreeKorekceItem({ title: 'Korekce do 5 dnů' }, 0), true);
});

test('korekceWindowStart: минус 5 календарных дней, через границу месяца и года', () => {
  assert.equal(core.korekceWindowStart('2026-09-21'), '2026-09-16');
  assert.equal(core.korekceWindowStart('2026-10-03'), '2026-09-28');
  assert.equal(core.korekceWindowStart('2027-01-02'), '2026-12-28');
  assert.equal(core.KOREKCE_WINDOW_DAYS, 5);
});

test('isQualifyingVisit: прошедший маникюр той же категории — засчитан', () => {
  assert.equal(core.isQualifyingVisit(visit({}), 'manicure', NOW), true);
  assert.equal(core.isQualifyingVisit(visit({ status: 'active' }), 'manicure', NOW), true);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Prodloužení nehtů' }), 'manicure', NOW), true);
});

test('isQualifyingVisit: отмена, неявка, будущий визит — не засчитаны', () => {
  assert.equal(core.isQualifyingVisit(visit({ status: 'cancelled' }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ status: 'noshow' }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ startsAt: future }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ startsAt: null }), 'manicure', NOW), false);
  // визит ровно «сейчас» — уже начался
  assert.equal(core.isQualifyingVisit(visit({ startsAt: new Date(NOW).toISOString() }), 'manicure', NOW), true);
});

test('isQualifyingVisit: другая категория — нет (ресницы не дают коррекцию ногтей и наоборот)', () => {
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: '2D', serviceCategory: LASH_EXT }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: '2D', serviceCategory: LASH_EXT }), 'lashes', NOW), true);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Doplnění řas', serviceCategory: LASH_EXT }), 'lashes', NOW), true);
  // lash lifting — тоже категория «lashes» (каталог: «Řasy – barvení a péče»)
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Lash lifting', serviceCategory: LASH_CARE }), 'lashes', NOW), true);
  assert.equal(core.isQualifyingVisit(visit({}), 'lashes', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({}), null, NOW), false);
});

test('isQualifyingVisit: сама коррекция, Hygienická manikúra и снятия не дают права', () => {
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Korekce do 5 dnů' }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Hygienická manikúra' }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Sundání nehtů' }), 'manicure', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: 'Sundání řas', serviceCategory: LASH_EXT }), 'lashes', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ serviceTitle: '' }), 'manicure', NOW), false);
});

test('isQualifyingVisit: без категории (легаси-снапшот без serviceDocId) — по названию', () => {
  assert.equal(core.isQualifyingVisit(visit({ serviceCategory: null, serviceTitle: 'Gel lak manikúra' }), 'manicure', NOW), true);
  assert.equal(core.isQualifyingVisit(visit({ serviceCategory: null, serviceTitle: '3D + Anime efekt' }), 'lashes', NOW), false);
  assert.equal(core.isQualifyingVisit(visit({ serviceCategory: null, serviceTitle: 'Prodloužení řas 3D' }), 'lashes', NOW), true);
});
