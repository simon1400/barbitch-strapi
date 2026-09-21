// Юнит-тесты чистого расчёта списания за интерную услугу (internal-payroll.ts).
// Модуль без импортов → транспилируем в изоляции и импортируем как data-URL;
// `strapi` внутри методов при этом не трогается.
//
// Запуск: cd strapi && node --test tests/internal-payroll.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const srcPath = path.resolve(import.meta.dirname, '../src/api/booking-engine/services/internal-payroll.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

// ── сумма списания ──

test('internalPayrollSum: прод-образец 990 Kč × 40 % = 396', () => {
  assert.equal(core.internalPayrollSum({ price: 990, ratePercent: 40 }), 396);
});

test('internalPayrollSum: округление до кроны (sum — biginteger)', () => {
  // 880 × 45 % = 396 ровно
  assert.equal(core.internalPayrollSum({ price: 880, ratePercent: 45 }), 396);
  // 777 × 40 % = 310,8 → 311
  assert.equal(core.internalPayrollSum({ price: 777, ratePercent: 40 }), 311);
  // 555 × 40 % = 222 ровно
  assert.equal(core.internalPayrollSum({ price: 555, ratePercent: 40 }), 222);
  // половина кроны — вверх, как Math.round
  assert.equal(core.internalPayrollSum({ price: 1005, ratePercent: 50 }), 503);
});

test('internalPayrollSum: строки из Strapi (decimal приходит строкой)', () => {
  assert.equal(core.internalPayrollSum({ price: '990', ratePercent: '40' }), 396);
});

test('internalPayrollSum: мусор и пустые значения → 0, а не NaN', () => {
  for (const args of [
    { price: null, ratePercent: 40 },
    { price: 990, ratePercent: null },
    { price: undefined, ratePercent: undefined },
    { price: 'abc', ratePercent: 40 },
    { price: 990, ratePercent: '' },
  ]) {
    const v = core.internalPayrollSum(args);
    assert.equal(Number.isFinite(v), true, JSON.stringify(args));
    assert.equal(v, 0, JSON.stringify(args));
  }
});

test('internalPayrollSum: нулевой процент (мастер без ставки) → 0', () => {
  assert.equal(core.internalPayrollSum({ price: 990, ratePercent: 0 }), 0);
});

// ── описание ──

test('internalPayrollComment: услуга + мастер + дата по-чешски', () => {
  assert.equal(
    core.internalPayrollComment({
      serviceTitle: 'Lash lifting + Barveni řas',
      masterName: 'Nataliia Hobedashvilu',
      date: '2026-09-21',
    }),
    'Lash lifting + Barveni řas u Nataliia Hobedashvilu (interní rezervace 21. 9.)'
  );
});

test('internalPayrollComment: день/месяц без ведущих нулей', () => {
  const s = core.internalPayrollComment({ serviceTitle: 'X', masterName: 'Y', date: '2026-01-05' });
  assert.ok(s.includes('(interní rezervace 5. 1.)'), s);
});

test('internalPayrollComment: пустые части не оставляют висячих предлогов', () => {
  assert.equal(
    core.internalPayrollComment({ serviceTitle: '', masterName: '', date: '' }),
    'Interní služba (interní rezervace)'
  );
  assert.equal(
    core.internalPayrollComment({ serviceTitle: 'Manikúra', masterName: '', date: '2026-09-21' }),
    'Manikúra (interní rezervace 21. 9.)'
  );
});

test('internalPayrollComment: кривая дата не роняет и не печатает Invalid Date', () => {
  const s = core.internalPayrollComment({ serviceTitle: 'X', masterName: 'Y', date: 'not-a-date' });
  assert.ok(!s.includes('Invalid'), s);
  assert.ok(!s.includes('NaN'), s);
});

// ── метка источника ──

test('INTERNAL_PAYROLL_SOURCE отличает наши черновики от ручных записей владельца', () => {
  assert.equal(core.INTERNAL_PAYROLL_SOURCE, 'internal');
});

test('модуль самодостаточен (0 импортов)', () => {
  assert.ok(!/^\s*import\s/m.test(src), 'internal-payroll.ts обязан быть без импортов');
});
