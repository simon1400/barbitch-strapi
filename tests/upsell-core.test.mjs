// Юнит-тесты общего ядра дозаписи (upsell-core.ts) — без БД/Strapi.
// upsell-core импортирует slots-core → транспилируем оба и подменяем относительный
// импорт на data-URL уже транспилированного slots-core.
//
// Запуск: cd strapi && node --test tests/

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
const coreJs = transpile('upsell-core.ts');
assert.ok(coreJs.includes("from './slots-core'"), 'upsell-core импортирует slots-core');
const core = await import(dataUrl(coreJs.split("from './slots-core'").join(`from '${slotsUrl}'`)));

const iv = (startMin, endMin) => ({ startMin, endMin });
const HOURS = { openMin: 540, closeMin: 1200 }; // 09:00–20:00

// ── каталог прода 16.09.2026: title | category | price | ожидаемый бакет | исключена ──
const CATALOG = [
  ['Hygienická manikúra', 'Nehty 💅💅💅', 650, 'manicure', false],
  ['Gel lak manikúra', 'Nehty 💅💅💅', 990, 'manicure', false],
  ['Prodloužení nehtů', 'Nehty 💅💅💅', 1100, 'manicure', false],
  ['IBX Regenerace nehtů', 'Nehty 💅💅💅', 990, 'manicure', false],
  ['Sundání nehtů', 'Nehty 💅💅💅', 650, 'manicure', true],
  ['Korekce do 5 dnů', 'Nehty 💅💅💅', 0, 'manicure', true],
  ['Úprava tvaru, korekce voskem / pinzetou', 'Obočí🤨🩷', 350, 'brows', false],
  ['Barvení obočí + úprava tvaru', 'Obočí🤨🩷', 660, 'brows', false],
  ['Laminace + úprava tvaru', 'Obočí🤨🩷', 880, 'brows', false],
  ['Lash lifting', 'Řasy – barvení a péče ☁️', 990, 'lashes', false],
  ['Barvení řas', 'Řasy – barvení a péče ☁️', 330, 'lashes', false],
  ['1D (Classic)', 'Prodlužování řas 👁️👄👁️', 970, 'lashes', false],
  ['2D', 'Prodlužování řas 👁️👄👁️', 1090, 'lashes', false],
  ['3D', 'Prodlužování řas 👁️👄👁️', 1210, 'lashes', false],
  ['4D', 'Prodlužování řas 👁️👄👁️', 1430, 'lashes', false],
  ['5D', 'Prodlužování řas 👁️👄👁️', 1650, 'lashes', false],
  ['6D', 'Prodlužování řas 👁️👄👁️', 1870, 'lashes', false],
  ['7D', 'Prodlužování řas 👁️👄👁️', 2090, 'lashes', false],
  ['Doplnění řas', 'Prodlužování řas 👁️👄👁️', 770, 'lashes', true],
  ['Sundání řas', 'Prodlužování řas 👁️👄👁️', 300, 'lashes', true],
  ['Korekce do 5 dnů', 'Prodlužování řas 👁️👄👁️', 0, 'lashes', true],
];

test('classifyTitle: все 21 услуга каталога (категория, затем название — как в движке)', () => {
  for (const [title, category, , bucket] of CATALOG) {
    assert.equal(core.classifyTitle(category) ?? core.classifyTitle(title), bucket, `${category} / ${title}`);
  }
  // по одному названию (категория пустая) — важен порядок веток
  assert.equal(core.classifyTitle('Laminace řas'), 'lashes', 'řas раньше laminace');
  assert.equal(core.classifyTitle('Barvení obočí + úprava tvaru'), 'brows');
  assert.equal(core.classifyTitle('Sundání nehtů'), 'manicure');
  assert.equal(core.classifyTitle(''), null);
  assert.equal(core.classifyTitle(null), null);
});

test('isExcludedOfferService: снятия/доливы и бесплатные — нет, платная коррекция воском — да', () => {
  for (const [title, , price, , excluded] of CATALOG) {
    assert.equal(core.isExcludedOfferService(title, price), excluded, `${title} ${price} Kč`);
  }
  // положительный контроль: без цены платная коррекция тоже отсекается (цены нет → не продаём)
  assert.equal(core.isExcludedOfferService('Úprava tvaru, korekce voskem / pinzetou', undefined), true);
  assert.equal(core.isExcludedOfferService('Úprava tvaru, korekce voskem / pinzetou', '350'), false);
  assert.equal(core.NON_BASE_KEYWORDS.includes('korekce'), false);
});

// ── windowAfter ──

test('windowAfter: окно сразу после конца, допуск 15 мин включительно', () => {
  const anchorEnd = 720; // 12:00
  // мастер свободен с 12:00
  assert.deepEqual(core.windowAfter(HOURS, [iv(540, 720)], anchorEnd, false, 0), { startMin: 720, availMin: 480 });
  // свободна с 12:15 — ровно граница
  assert.deepEqual(core.windowAfter(HOURS, [iv(540, 735)], anchorEnd, false, 0), { startMin: 735, availMin: 465 });
  // с 12:16 — поздно
  assert.equal(core.windowAfter(HOURS, [iv(540, 736)], anchorEnd, false, 0), null);
  // свободна раньше конца визита и дальше — старт = конец визита, окно до следующей брони
  assert.deepEqual(core.windowAfter(HOURS, [iv(800, 900)], anchorEnd, false, 0), { startMin: 720, availMin: 80 });
  // окно кончается ровно в конце визита — пропуск, следующее окно далеко
  assert.equal(core.windowAfter(HOURS, [iv(720, 900)], anchorEnd, false, 0), null);
});

test('windowAfter: сегодня — старт в прошлом не предлагается; нет часов салона — null', () => {
  assert.equal(core.windowAfter(HOURS, [], 720, true, 721), null);
  assert.deepEqual(core.windowAfter(HOURS, [], 720, true, 720), { startMin: 720, availMin: 480 });
  // для другого дня nowMin игнорируется
  assert.deepEqual(core.windowAfter(HOURS, [], 720, false, 900), { startMin: 720, availMin: 480 });
  assert.equal(core.windowAfter(null, [], 720, false, 0), null);
  assert.equal(core.windowAfter({ openMin: 600, closeMin: 600 }, [], 720, false, 0), null);
});

// ── windowBefore ──

test('windowBefore: услуга встаёт вплотную к началу визита', () => {
  const anchorStart = 900; // 15:00
  assert.deepEqual(core.windowBefore(HOURS, [], anchorStart, 45, null), { startMin: 855, endMin: 900 });
  // мастер занят до 14:00, услуга 60 мин влезает ровно
  assert.deepEqual(core.windowBefore(HOURS, [iv(540, 840)], anchorStart, 60, null), { startMin: 840, endMin: 900 });
  // 61 мин не влезает
  assert.equal(core.windowBefore(HOURS, [iv(540, 840)], anchorStart, 61, null), null);
});

test('windowBefore: зазор до визита 0 / 15 / 16 мин', () => {
  const anchorStart = 900;
  // мастер занят с 14:45 → окно кончается за 15 мин до визита — допустимо
  assert.deepEqual(core.windowBefore(HOURS, [iv(885, 1000)], anchorStart, 30, null), { startMin: 855, endMin: 885 });
  // занят с 14:44 → 16 мин — нельзя
  assert.equal(core.windowBefore(HOURS, [iv(884, 1000)], anchorStart, 30, null), null);
  // занят с 15:00 (стык) → 0 мин
  assert.deepEqual(core.windowBefore(HOURS, [iv(900, 1000)], anchorStart, 30, null), { startMin: 870, endMin: 900 });
});

test('windowBefore: самый ранний старт (сейчас + дорога) и граница открытия салона', () => {
  const anchorStart = 900;
  // старт 14:15 при minStart 14:15 — можно; при 14:16 — нельзя
  assert.deepEqual(core.windowBefore(HOURS, [], anchorStart, 45, 855), { startMin: 855, endMin: 900 });
  assert.equal(core.windowBefore(HOURS, [], anchorStart, 45, 856), null);
  // визит в 09:30, услуга 45 мин — раньше открытия салона не влезает
  assert.equal(core.windowBefore(HOURS, [], 570, 45, null), null);
  assert.deepEqual(core.windowBefore(HOURS, [], 570, 30, null), { startMin: 540, endMin: 570 });
  // визит после закрытия/мусорная длительность
  assert.equal(core.windowBefore(HOURS, [], 900, 0, null), null);
  assert.equal(core.windowBefore(null, [], 900, 30, null), null);
});

test('windowBefore: несколько окон — берётся то, что у визита, а не первое по времени', () => {
  // свободно 09:00–10:00 и 13:30–14:50; визит в 15:00
  const busy = [iv(600, 810), iv(890, 1200)];
  assert.deepEqual(core.windowBefore(HOURS, busy, 900, 60, null), { startMin: 830, endMin: 890 });
});
