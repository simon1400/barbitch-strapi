// Журнал «Uzavření směny» и «Uzavřít návštěvu» (s240, «Výkaz práce» §10.4.2):
//   - тело страницы: день не будущий и не старше 62 дней, счётчики — целые ≥ 0;
//   - автор — из сессии, число услуг дня — из базы; entityType shift_close;
//   - отмена закрытия пишется сервером из /shift-revert;
//   - ручка — под requireManagement; закрытие/правка/отмена визита пишут журнал без сумм.
// Запуск: cd strapi && node --test tests/shift-close-log.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const toJs = (file) =>
  ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

let js = toJs('src/api/booking-engine/services/shift-close-log.ts');
const from = "from './slots-core'";
assert.ok(js.includes(from));
js = js.split(from).join(`from '${dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'))}'`);
const L = await import(dataUrl(js));

const expectErr = (fn, code) => assert.throws(fn, (e) => (assert.equal(e.code, code), assert.equal(e.status, 400), true));

test('тело: день в окне, счётчики целые', () => {
  const today = '2026-10-02';
  assert.deepEqual(L.normalizeShiftCloseLog({ date: '2026-10-02', published: 12, failures: 0 }, today), {
    date: '2026-10-02',
    published: 12,
    failures: 0,
    skipped: 0,
  });
  expectErr(() => L.normalizeShiftCloseLog({ date: '2026-10-03' }, today), 'bad_date');
  expectErr(() => L.normalizeShiftCloseLog({ date: '2026-02-30' }, today), 'bad_date');
  expectErr(() => L.normalizeShiftCloseLog({ date: '2026-07-31' }, today), 'bad_date');
  assert.equal(L.normalizeShiftCloseLog({ date: '2026-08-01' }, today).date, '2026-08-01');
  expectErr(() => L.normalizeShiftCloseLog({ date: today, published: -1 }, today), 'bad_counts');
  expectErr(() => L.normalizeShiftCloseLog({ date: today, published: 1.5 }, today), 'bad_counts');
  expectErr(() => L.normalizeShiftCloseLog({ date: today, failures: 'x' }, today), 'bad_counts');
});

test('запись: автор из сессии, услуги дня из базы; отмена — свой текст', async () => {
  const logs = [];
  let counted = null;
  globalThis.strapi = {
    documents: () => ({ count: async (q) => ((counted = q), 9) }),
    service: (uid) => (assert.equal(uid, 'api::calendar-log.calendar-log'), { write: async (e) => void logs.push(e) }),
  };
  const svc = L.default;
  await svc.logClose({
    session: { username: 'Mariia Medvedeva', role: 'manager' },
    body: { date: '2026-10-01', published: 14, failures: 2, actorName: 'Vika' },
    now: new Date('2026-10-01T19:00:00Z'),
  });
  assert.deepEqual(counted, { status: 'published', filters: { date: { $eq: '2026-10-01' } } });
  assert.equal(logs[0].actorName, 'Mariia Medvedeva', 'автор — сессия, не тело');
  assert.equal(logs[0].entityType, 'shift_close');
  assert.equal(logs[0].action, 'shift_close');
  assert.equal(logs[0].summary, 'Směna 01.10.2026 uzavřena: zveřejněno 14 · chyby 2');
  assert.equal(logs[0].details['služeb dne v bázi'], 9);
  await svc.logRevert({ session: { username: 'Dima' }, date: '2026-10-01', result: { unpublished: { cashs: 1, 'services-provided': 5 }, errors: [] } });
  assert.equal(logs[1].action, 'shift_revert');
  assert.equal(logs[1].summary, 'Uzavření směny 01.10.2026 zrušeno: vráceno do konceptu 6');
});

test('ручка под requireManagement; откат и визиты пишут журнал', () => {
  const routes = read('src/api/booking-engine/routes/booking-engine.ts');
  const ctrl = read('src/api/booking-engine/controllers/booking-engine.ts');
  assert.ok(routes.includes("admin('POST', '/engine/admin/shift-close/journal', 'booking-engine.adminShiftCloseJournal')"));
  const body = ctrl.split('async adminShiftCloseJournal(ctx) {')[1]?.split('\n  },')[0] || '';
  assert.ok(body.includes('const session = requireManagement(ctx);'));
  assert.ok(read('src/api/shift-revert/controllers/shift-revert.ts').includes('.logRevert({ session, date, result })'));
  const vc = read('src/api/booking-engine/services/visit-close.ts');
  for (const a of ["this._log('visit_close',", "this._log('visit_close_edit',", "this._log('visit_close_delete',"]) assert.ok(vc.includes(a), a);
  // в журнал визита суммы не уходят
  const logFn = vc.split('_log(action, session, spDocId')[1].split('\n  },')[0];
  assert.ok(logFn.includes("entityType: 'visit'") && logFn.includes('actorName: session.username'), 'entityType visit, автор — сессия');
  assert.doesNotMatch(logFn, /staffSalaries|salonSalaries|tip|sale/);
});
