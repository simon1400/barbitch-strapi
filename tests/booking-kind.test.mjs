// Юнит-тесты вида брони и фильтра занятости (booking-kind.ts) — без БД/Strapi.
// Модуль самодостаточен (0 импортов) → транспилируем его в изоляции через
// typescript.transpileModule и импортируем как data-URL.
//
// Запуск: cd strapi && node --test tests/booking-kind.test.mjs
// (⚠️ `node --test tests/` на Node 24 падает — перечислять файлы)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const srcPath = path.resolve(import.meta.dirname, '../src/api/booking-engine/services/booking-kind.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

// ── isInternal ──

test('isInternal: только явный true', () => {
  assert.equal(core.isInternal({ internal: true }), true);
  assert.equal(core.isInternal({ internal: false }), false);
  // старые строки: колонку завели после них → NULL/undefined = обычная бронь
  assert.equal(core.isInternal({ internal: null }), false);
  assert.equal(core.isInternal({}), false);
  assert.equal(core.isInternal(null), false);
  assert.equal(core.isInternal(undefined), false);
});

// ── isOccupying ──

test('isOccupying: активная клиентская бронь занимает время', () => {
  assert.equal(core.isOccupying({ status: 'active', internal: false }), true);
  // 🟥 старая бронь с NULL обязана ОСТАТЬСЯ занятостью — иначе после деплоя,
  // до миграции, все 4854 строки прода перестали бы блокировать слоты
  assert.equal(core.isOccupying({ status: 'active', internal: null }), true);
  assert.equal(core.isOccupying({ status: 'active' }), true);
});

test('isOccupying: интерная бронь время НЕ занимает', () => {
  assert.equal(core.isOccupying({ status: 'active', internal: true }), false);
});

test('isOccupying: неактивные статусы не занимают время', () => {
  for (const status of ['cancelled', 'noshow', 'checkedOut']) {
    assert.equal(core.isOccupying({ status, internal: false }), false, status);
    assert.equal(core.isOccupying({ status, internal: true }), false, status);
  }
  assert.equal(core.isOccupying(null), false);
  assert.equal(core.isOccupying({}), false);
});

// ── NULL-безопасность фильтра ──

test('NOT_INTERNAL_OR ловит и NULL, и false — и НЕ через $ne', () => {
  assert.deepEqual(core.NOT_INTERNAL_OR, [{ internal: { $null: true } }, { internal: { $eq: false } }]);
  // страховка от регресса: Strapi компилирует $ne в `col <> value`, и NULL выпадает
  const s = JSON.stringify(core.NOT_INTERNAL_OR);
  assert.ok(!s.includes('$ne'), '$ne в фильтре занятости недопустим — NULL-строки выпадут');
});

test('NOT_INTERNAL_SQL — coalesce, а не сравнение с NULL', () => {
  assert.equal(core.NOT_INTERNAL_SQL, 'coalesce(internal, false) = false');
});

// ── occupancyFilters / withoutInternal ──

test('occupancyFilters: статус active + не интерная, extra сохраняется', () => {
  const f = core.occupancyFilters({ date: { $gte: '2026-09-01', $lte: '2026-09-30' } });
  assert.deepEqual(f, {
    date: { $gte: '2026-09-01', $lte: '2026-09-30' },
    status: 'active',
    $or: core.NOT_INTERNAL_OR,
  });
});

test('occupancyFilters не мутирует переданный объект', () => {
  const extra = { date: '2026-09-21' };
  core.occupancyFilters(extra);
  assert.deepEqual(extra, { date: '2026-09-21' }, 'extra изменился — вызывающий получит чужой фильтр');
});

test('withoutInternal: чужой $or не затирается, а уезжает в $and', () => {
  const f = core.withoutInternal({
    date: '2026-09-21',
    $or: [{ a: 1 }, { b: 2 }],
  });
  assert.deepEqual(f, {
    date: '2026-09-21',
    $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { $or: core.NOT_INTERNAL_OR }],
  });
  assert.ok(!('$or' in f), 'верхнеуровневый $or остался — одно из условий потеряно');
});

test('withoutInternal: без чужого $or кладёт условие прямо в $or', () => {
  const f = core.withoutInternal({ date: '2026-09-21', status: 'active' });
  assert.deepEqual(f, { date: '2026-09-21', status: 'active', $or: core.NOT_INTERNAL_OR });
});

// ── инвариант модуля ──

test('модуль самодостаточен (0 импортов) — иначе тест не транспилируется', () => {
  assert.ok(!/^\s*import\s/m.test(src), 'booking-kind.ts обязан быть без импортов');
});
