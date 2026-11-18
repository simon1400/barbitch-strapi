// Выбор ваучера при закрытии визита (s297): возврат, срок 6 месяцев, повторное использование.
// Настоящий visit-close.ts на заглушке document service.
// Запуск: cd strapi && node --test tests/visit-close-voucher.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '../src');
const transpile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const swap = (js, from, url) => js.split(`from '${from}'`).join(`from '${url}'`);

const vfUrl = dataUrl(transpile('utils/verify-flags.ts'));
const ktUrl = dataUrl(swap(transpile('api/booking-engine/services/korekce-transfer.ts'), '../../../utils/verify-flags', vfUrl));
const engineUrl = dataUrl(
  'export class EngineError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }'
);
const coreUrl = dataUrl(transpile('api/booking-engine/services/voucher-payments-core.ts'));
let js = transpile('api/booking-engine/services/visit-close.ts');
js = swap(js, './slots-core', dataUrl(transpile('api/booking-engine/services/slots-core.ts')));
js = swap(js, './booking-engine', engineUrl);
js = swap(js, './voucher-payments-core', coreUrl);
js = swap(js, '../../../utils/verify-flags', vfUrl);
js = swap(js, './korekce-transfer', ktUrl);
const vc = (await import(dataUrl(js))).default;
const core = await import(coreUrl);

const stub = (voucher, links = []) => {
  globalThis.strapi = {
    documents: () => ({ findOne: async () => voucher, findMany: async () => links }),
  };
};
const paid = (over = {}) => ({ documentId: 'v1', datePay: '2026-05-18', dateRealized: null, paymentStatus: 'paid', ...over });
const admin = { role: 'administrator' };
const code = (c) => (e) => e.code === c;

test('срок: 6 месяцев от дня оплаты, конец месяца не перескакивает', () => {
  assert.equal(core.voucherValidUntilYmd('2026-05-18'), '2026-11-18');
  assert.equal(core.voucherValidUntilYmd('2026-08-31'), '2027-02-28');
  assert.equal(core.validUntilOf('2026-08-31'), '28.02.2027');
});

test('действующий ваучер проходит, старый без статуса тоже', async () => {
  stub(paid());
  assert.equal(await vc._resolveVoucher('v1', { visitDate: '2026-11-18', session: admin }), 'v1');
  stub(paid({ paymentStatus: null }));
  assert.equal(await vc._resolveVoucher('v1', { visitDate: '2026-11-18', session: admin }), 'v1');
});

test('просрочен: администратору нельзя, руководству можно', async () => {
  stub(paid());
  await assert.rejects(vc._resolveVoucher('v1', { visitDate: '2026-11-19', session: admin }), code('voucher_expired'));
  assert.equal(await vc._resolveVoucher('v1', { visitDate: '2026-11-19', session: { role: 'manager' } }), 'v1');
  assert.equal(await vc._resolveVoucher('v1', { visitDate: '2026-11-19', session: { role: 'owner' } }), 'v1');
});

test('повторное использование запрещено и руководству', async () => {
  stub(paid(), [{ documentId: 'sp-other', date: '2026-11-10' }]);
  await assert.rejects(vc._resolveVoucher('v1', { visitDate: '2026-11-10', session: { role: 'owner' } }), code('voucher_used'));
  stub(paid({ dateRealized: '2026-11-01' }));
  await assert.rejects(vc._resolveVoucher('v1', { visitDate: '2026-11-10', session: admin }), code('voucher_used'));
});

test('правка своей записи не падает, даже если срок уже вышел', async () => {
  stub(paid({ dateRealized: '2026-11-18' }), [{ documentId: 'sp1', date: '2026-11-18' }]);
  assert.equal(await vc._resolveVoucher('v1', { visitDate: '2026-12-01', session: admin, spDocId: 'sp1' }), 'v1');
});

test('возвращённый и неоплаченный не проходят', async () => {
  stub(paid({ paymentStatus: 'refunded' }));
  await assert.rejects(vc._resolveVoucher('v1', { visitDate: '2026-11-10', session: { role: 'owner' } }), code('voucher_refunded'));
  stub(paid({ datePay: null }));
  await assert.rejects(vc._resolveVoucher('v1', { visitDate: '2026-11-10', session: admin }), code('voucher_not_paid'));
});
