// Юнит-тесты чистых функций движка бронирования (slots-core.ts) — без БД/Strapi.
// Модуль самодостаточен (0 импортов) → транспилируем его в изоляции через
// typescript.transpileModule и импортируем как data-URL.
//
// Запуск: cd strapi && node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const srcPath = path.resolve(import.meta.dirname, '../src/api/booking-engine/services/slots-core.ts');
const js = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

const iv = (startMin, endMin) => ({ startMin, endMin });

// ── интервальная математика ──

test('mergeIntervals: пересечения, смежность, мусор', () => {
  assert.deepEqual(core.mergeIntervals([]), []);
  assert.deepEqual(core.mergeIntervals([iv(60, 120), iv(100, 180)]), [iv(60, 180)]);
  // смежные сливаются (полуоткрытая семантика — [60,120)+[120,180) = [60,180))
  assert.deepEqual(core.mergeIntervals([iv(120, 180), iv(60, 120)]), [iv(60, 180)]);
  assert.deepEqual(core.mergeIntervals([iv(60, 120), iv(200, 260)]), [iv(60, 120), iv(200, 260)]);
  // мусор (end<=start) отбрасывается
  assert.deepEqual(core.mergeIntervals([iv(100, 100), iv(200, 150)]), []);
});

test('subtractIntervals: busy внутри окна, по краям, стык блоков', () => {
  const window = iv(600, 1140); // 10:00–19:00
  assert.deepEqual(core.subtractIntervals(window, []), [window]);
  assert.deepEqual(core.subtractIntervals(window, [iv(660, 720)]), [iv(600, 660), iv(720, 1140)]);
  // busy вылезает за края окна
  assert.deepEqual(core.subtractIntervals(window, [iv(0, 630), iv(1100, 2000)]), [iv(630, 1100)]);
  // стык: два блока впритык не оставляют щели между собой
  assert.deepEqual(core.subtractIntervals(window, [iv(600, 660), iv(660, 720)]), [iv(720, 1140)]);
  // busy закрывает всё окно
  assert.deepEqual(core.subtractIntervals(window, [iv(500, 1200)]), []);
});

test('слот ровно в стык между бронями (полуоткрытые интервалы)', () => {
  // брони 10:00–11:00 и 12:00–13:00, услуга 60 мин → окно 11:00 доступно
  const free = core.subtractIntervals(iv(600, 1140), [iv(600, 660), iv(720, 780)]);
  const starts = core.slotStarts(free, 60);
  assert.ok(starts.includes(660), '11:00 должен быть доступен');
  assert.ok(!starts.includes(645), '10:45 пересекает бронь до 11:00');
});

test('slotStarts: выравнивание к сетке, влезание длительности, minStart', () => {
  // свободно 10:20–12:00 → первый слот по сетке 15 мин = 10:30
  assert.deepEqual(core.slotStarts([iv(620, 720)], 30), [630, 645, 660, 675, 690]);
  // длиннее интервала → пусто
  assert.deepEqual(core.slotStarts([iv(600, 650)], 60), []);
  // minStartMin (лид «сегодня»): не раньше 11:00
  assert.deepEqual(core.slotStarts([iv(600, 750)], 60, 15, 660), [660, 675, 690]);
  assert.deepEqual(core.slotStarts([iv(600, 700)], 0), []);
});

test('dayAvailability: закрытый день и полный расчёт', () => {
  assert.deepEqual(core.dayAvailability({ openMin: null, closeMin: null, busy: [], durationMin: 60 }), []);
  const starts = core.dayAvailability({
    openMin: 600,
    closeMin: 1140,
    busy: [iv(660, 720), iv(1080, 1140)],
    durationMin: 90,
  });
  // 10:00+90=11:30 пересекает 11:00–12:00 → нет; 12:00..16:30 ок (16:30+90=18:00)
  assert.equal(starts[0], 720);
  assert.equal(starts[starts.length - 1], 990);
  assert.ok(!starts.includes(600));
});

// ── Прага ↔ UTC (DST) ──

test('DST: зима, весенний перевод (29.03.2026), осенний (25.10.2026)', () => {
  // зима: +1 → 10:00 Праги = 09:00Z
  assert.equal(core.pragueMinToUtcIso('2026-03-28', 600), '2026-03-28T09:00:00.000Z');
  // после весеннего скачка: +2 → 10:00 Праги = 08:00Z
  assert.equal(core.pragueMinToUtcIso('2026-03-29', 600), '2026-03-29T08:00:00.000Z');
  // осенью вернулись на +1
  assert.equal(core.pragueMinToUtcIso('2026-10-25', 600), '2026-10-25T09:00:00.000Z');
  assert.equal(core.pragueMinToUtcIso('2026-10-24', 600), '2026-10-24T08:00:00.000Z');
});

test('DST: round-trip UTC → пражские минуты', () => {
  assert.equal(core.utcToPragueMinClamped('2026-03-29T08:00:00.000Z', '2026-03-29'), 600);
  assert.equal(core.pragueDateOf('2026-03-29T08:00:00.000Z'), '2026-03-29');
  // 23:30Z 28-го = 01:30 Праги 29-го (переход в 02:00→03:00 ещё не наступил)
  assert.equal(core.pragueDateOf('2026-03-28T23:30:00.000Z'), '2026-03-29');
});

test('кламп busy-интервалов, цепляющих полночь', () => {
  // блок стартовал накануне вечером → для текущих суток кламп в 0
  assert.equal(core.utcToPragueMinClamped('2026-07-10T22:00:00.000Z', '2026-07-11'), 0);
  // момент следующих суток → 1440
  assert.equal(core.utcToPragueMinClamped('2026-07-12T05:00:00.000Z', '2026-07-11'), 1440);
  // внутри суток: 08:00Z лета = 10:00 Праги
  assert.equal(core.utcToPragueMinClamped('2026-07-11T08:00:00.000Z', '2026-07-11'), 600);
});

test('minToHHMM / hhmmToMin', () => {
  assert.equal(core.minToHHMM(600), '10:00');
  assert.equal(core.minToHHMM(645), '10:45');
  assert.equal(core.hhmmToMin('19:30'), 1170);
});

// ── прайсинг ──

test('computePricing: base + variant + modifiers, junior −20%', () => {
  // чистая база senior
  assert.deepEqual(core.computePricing({ basePrice: 1112, baseDurationMin: 90, tier: 'senior' }), {
    price: 1112,
    seniorPrice: 1112,
    durationMin: 90,
  });
  // junior: 1112×0.8 = 889.6 → 890; длительность НЕ меняется (s95)
  assert.deepEqual(core.computePricing({ basePrice: 1112, baseDurationMin: 90, tier: 'junior' }), {
    price: 890,
    seniorPrice: 1112,
    durationMin: 90,
  });
  // вариант + допы складываются в цену и длительность
  const r = core.computePricing({
    basePrice: 650,
    baseDurationMin: 60,
    variant: { priceDiff: 100, durationDiff: 20 },
    modifiers: [{ priceDiff: 120, durationDiff: 20 }, { priceDiff: 0, durationDiff: 0 }],
    tier: 'senior',
  });
  assert.deepEqual(r, { price: 870, seniorPrice: 870, durationMin: 100 });
  // тот же набор junior: 870×0.8 = 696
  const j = core.computePricing({
    basePrice: 650,
    baseDurationMin: 60,
    variant: { priceDiff: 100, durationDiff: 20 },
    modifiers: [{ priceDiff: 120, durationDiff: 20 }],
    tier: 'junior',
  });
  assert.equal(j.price, 696);
  assert.equal(j.durationMin, 100);
});

test('calcJuniorPrice синхронен с client/lib/junior.ts', () => {
  assert.equal(core.calcJuniorPrice(1000), 800);
  assert.equal(core.calcJuniorPrice(1237), 990); // 989.6 → 990
});

test('buildComboTitle: «+»-части клеятся пробелом, остальные через « + »', () => {
  assert.equal(core.buildComboTitle('Gel lak manikúra', []), 'Gel lak manikúra');
  assert.equal(
    core.buildComboTitle('Gel lak manikúra', ['+ Design basic', 'Posílení nehtů']),
    'Gel lak manikúra + Design basic + Posílení nehtů'
  );
  assert.equal(core.buildComboTitle('Hygienická manikúra', ['Extra masáž 10 min']), 'Hygienická manikúra + Extra masáž 10 min');
});

// ── балансировка «Kdokoliv» ──

test('selectEmployee: наименее загруженный выигрывает', () => {
  const rand = () => 0;
  assert.equal(
    core.selectEmployee(
      [
        { id: 'A', load: 5, boost: 0 },
        { id: 'B', load: 2, boost: 0 },
      ],
      rand
    ),
    'B'
  );
});

test('selectEmployee: буст приоритета перебивает загрузку (вес 2)', () => {
  const rand = () => 0;
  // A: 4 − 2×2 = 0; B: 1 − 0 = 1 → A
  assert.equal(
    core.selectEmployee(
      [
        { id: 'A', load: 4, boost: 2 },
        { id: 'B', load: 1, boost: 0 },
      ],
      rand
    ),
    'A'
  );
});

test('selectEmployee: равные score → выбор по rand, края', () => {
  const cands = [
    { id: 'A', load: 1, boost: 0 },
    { id: 'B', load: 1, boost: 0 },
  ];
  assert.equal(core.selectEmployee(cands, () => 0), 'A');
  assert.equal(core.selectEmployee(cands, () => 0.99), 'B');
  assert.equal(core.selectEmployee([], () => 0), null);
  assert.equal(core.selectEmployee([{ id: 'X', load: 99, boost: 0 }], () => 0), 'X');
});
