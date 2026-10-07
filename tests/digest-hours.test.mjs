// Часы дня в дайджесте (services/digest-hours.ts, s245): салон · відкрито для запису · фактично.
//   - салон — мин/макс окон; окна без времени или с концом раньше начала — не считаются;
//   - «відкрито» — окна минус действующие блоки по активным мастерам; блок на весь день у одного
//     мастера общий интервал не сужает; все заблокированы → «—»; неактивный мастер не считается;
//   - «фактично» — первая–последняя бронь (поверх блока тоже; вне окна салона — не режется);
//   - строка: три интервала; салон закрыт — прежняя фраза; digest.ts подключает модуль.
// Запуск: cd strapi && node --test tests/digest-hours.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'src/api/digest/services/digest-hours.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const H = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

const W = [{ starts_at: '09:00', ends_at: '20:00' }];
const iv = (a, b) => ({ start: a, end: b });
const ext = (o) => H.dayExtents({ windows: W, blocksByEmp: new Map(), bookingsByEmp: new Map(), activeIds: ['a', 'b'], ...o });

test('минуты ↔ HH:MM, вычитание занятого', () => {
  assert.equal(H.hhmmToMin('09:30'), 570);
  assert.equal(H.hhmmToMin(null), 0);
  assert.equal(H.minToHHMM(1200), '20:00');
  assert.deepEqual(H.subtractBusy(540, 1200, [iv(600, 720), iv(700, 800), iv(1300, 1400)]), [iv(540, 600), iv(800, 1200)]);
  assert.deepEqual(H.subtractBusy(540, 1200, [iv(500, 1300)]), [], 'занято целиком');
  assert.deepEqual(H.subtractBusy(540, 1200, []), [iv(540, 1200)]);
});

test('салон: мин/макс окон; битые окна не считаются; нет окон — всё «—»', () => {
  const two = ext({ windows: [{ starts_at: '14:00', ends_at: '20:00' }, { starts_at: '09:00', ends_at: '12:00' }, { starts_at: '10:00', ends_at: null }, { starts_at: '18:00', ends_at: '17:00' }] });
  assert.deepEqual(two.salon, iv(540, 1200));
  assert.deepEqual(two.open, iv(540, 1200), 'обед между окнами интервал не сужает');
  const none = ext({ windows: [] });
  assert.deepEqual(none, { salon: null, open: null, actual: null });
  assert.equal(H.formatWorkdayLine(none), '🕐 Сьогодні немає робочих годин салону');
});

test('відкрито: блоки мастеров; блок на весь день у одного не сужает; все заблокированы → «—»', () => {
  const a = ext({ blocksByEmp: new Map([['a', [iv(540, 1200)]], ['b', [iv(540, 600), iv(1140, 1200)]]]) });
  assert.deepEqual(a.open, iv(600, 1140), 'у b свободно 10:00–19:00, a весь день в блоке');
  const all = ext({ blocksByEmp: new Map([['a', [iv(540, 1200)]], ['b', [iv(500, 1300)]]]) });
  assert.equal(all.open, null);
  const inactive = ext({ activeIds: ['a'], blocksByEmp: new Map([['a', [iv(540, 900)]], ['b', []]]) });
  assert.deepEqual(inactive.open, iv(900, 1200), 'свободный, но неактивный b не считается');
  const pending = ext({ activeIds: [], blocksByEmp: new Map() });
  assert.equal(pending.open, null, 'нет активных мастеров — записаться не к кому');
});

test('фактично: первая–последняя бронь, поверх блока и вне окна тоже; нет броней → «—»', () => {
  const r = ext({
    blocksByEmp: new Map([['a', [iv(540, 720)]]]),
    bookingsByEmp: new Map([['a', [iv(630, 690), iv(1080, 1095)]], ['c', [iv(500, 560)]], ['b', [iv(700, 650)]]]),
  });
  assert.deepEqual(r.actual, iv(500, 1095), 'бронь мастера c (не в activeIds) и до открытия — тоже факт; битая (700→650) нет');
  assert.equal(ext({}).actual, null);
});

test('строка дайджеста', () => {
  assert.equal(
    H.formatWorkdayLine({ salon: iv(540, 1200), open: iv(600, 1140), actual: iv(630, 1095) }),
    '🕐 Робочий день: 09:00–20:00 · відкрито для запису 10:00–19:00 · фактично 10:30–18:15'
  );
  assert.equal(H.formatWorkdayLine({ salon: iv(540, 1200), open: null, actual: null }), '🕐 Робочий день: 09:00–20:00 · відкрито для запису — · фактично —');
});

test('digest.ts: строку дня строит digest-hours, блоки считаются до неё, своих копий helper-ов нет', () => {
  const src = fs.readFileSync(path.join(root, 'src/api/digest/services/digest.ts'), 'utf8');
  assert.ok(src.includes("from './digest-hours'"));
  assert.ok(src.includes('workdayLine = formatWorkdayLine('));
  assert.ok(src.includes('dayExtents({ windows: todayWindows, blocksByEmp: blockIntervalsByEmp, bookingsByEmp: busyTodayByEmp, activeIds })'));
  assert.ok(src.indexOf('const blockIntervalsByEmp = new Map()') < src.indexOf('workdayLine = formatWorkdayLine('), 'блоки раньше строки дня');
  assert.doesNotMatch(src, /const (hhmmToMin|minToHHMM|subtractBusy) =/, 'копий helper-ов в digest.ts нет');
});
