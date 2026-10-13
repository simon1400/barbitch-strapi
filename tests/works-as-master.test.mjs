// «Работает как мастер» (s249): предикат и фильтр Strapi дают одно и то же, зеркало в
// админке совпадает с серверным.
//
// Запуск: cd strapi && node --test tests/works-as-master.test.mjs

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
const W = await import(dataUrl(toJs('src/utils/works-as-master.ts')));
const A = await import(dataUrl(toJs('../admin/src/lib/worksAsMaster.ts')));

// минимальный вычислитель фильтров Strapi: $or, $eq, неявный AND; NULL ≠ true
const match = (row, f) =>
  Object.entries(f).every(([k, c]) => (k === '$or' ? c.some((x) => match(row, x)) : row[k] === c.$eq));

const CASES = [];
for (const position of ['master', 'manager', 'administrator', null]) {
  for (const alsoMaster of [true, false, null, undefined]) CASES.push({ position, alsoMaster });
}

test('предикат = фильтр = зеркало админки на всех сочетаниях', () => {
  for (const row of CASES) {
    const want = row.position === 'master' || (row.position === 'manager' && row.alsoMaster === true);
    assert.equal(W.worksAsMaster(row), want, JSON.stringify(row));
    assert.equal(match(row, W.WORKS_AS_MASTER_FILTER), want, `filter ${JSON.stringify(row)}`);
    assert.equal(A.worksAsMaster(row), want, `admin ${JSON.stringify(row)}`);
  }
  assert.equal(W.worksAsMaster(null), false);
  assert.equal(A.worksAsMaster(undefined), false);
});

test('схема: alsoMaster — boolean, не локализуется, по умолчанию false', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'src/api/personal/content-types/personal/schema.json'), 'utf8'));
  const a = schema.attributes.alsoMaster;
  assert.equal(a.type, 'boolean');
  assert.equal(a.default, false);
  assert.equal(a.pluginOptions.i18n.localized, false);
});

test('в коде не осталось прямых проверок «мастер = position master» вне хелпера', () => {
  const files = [
    'src/api/booking-engine/services/booking-engine.ts',
    'src/api/booking-engine/services/rebook.ts',
    'src/api/booking-engine/services/upsell.ts',
    'src/api/booking-engine/services/time-offs.ts',
    'src/api/booking-engine/services/master-schedule.ts',
    'src/api/booking-engine/services/staff.ts',
  ];
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), 'utf8');
    const hits = code
      .split('\n')
      .filter((l) => /position\s*(===|!==)\s*'master'|position:\s*'master'|position:\s*\{\s*\$eq:\s*'master'/.test(l))
      .filter((l) => !/^\s*(\/\/|\*)/.test(l));
    // разрешены: рождение карточки (normalizeCreate/create) и rateReady — там речь о должности, не о «работает как мастер»
    const allowed = hits.filter(
      (l) =>
        !/const master = position === 'master';/.test(l) &&
        !/const master = input\.position === 'master';/.test(l) &&
        !/if \(p\?\.position === 'master'\) return pct;/.test(l) &&
        !/doc\.position !== 'master' && rate/.test(l)
    );
    assert.deepEqual(allowed, [], f);
  }
});
