// Platby voucherů kartou (s275, services/voucher-payments-core.ts): katalog a formulář,
// tělo pro Comgate, ověření stavu (částka/refId/měna/test), přechody stavů, push, vypršení,
// vrácení peněz, platnost voucheru. Konstanty se sverují s webem (client/src/lib/vouchers.ts).
// Spuštění: cd strapi && node --test tests/voucher-payments-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/api/booking-engine/services/voucher-payments-core.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const {
  AMOUNT_VOUCHERS, FOR_NAME_MAX, FROM_NAME_MAX, PAYMENT_LABEL, buildCatalog, checkCheckout, comgateConfig, basicAuth,
  createPaymentBody, parseCreateResponse, statusVerdict, nextStatus, fromStatusesFor, checkPush, isExpired,
  refundBlock, refundBody, validUntilOf, publicStatus,
} = core;

const catalog = buildCatalog([{ id: 'sluzba-abc', name: 'Gel lak manikúra', price: 990 }]);
const form = { voucherId: 'castka-1000', forName: ' Anna ', fromName: 'Petra  Nová', email: 'petra@example.cz', consent: true };
const cfg = { merchant: '123456', secret: 's3cr3t', test: true, apiUrl: 'https://payments.comgate.cz' };
const payment = { transId: 'AB12-CD34-EF56', idVoucher: '12345678', price: 1000, paymentStatus: 'pending', test: true };
const okStatus = { code: 0, transId: 'AB12-CD34-EF56', refId: '12345678', curr: 'CZK', price: '100000', test: 'true', status: 'PAID', method: 'CARD_CZ_COMGATE' };

test('konstanty sedí s webem (client/src/lib/vouchers.ts)', () => {
  const web = fs.readFileSync(path.join(root, '../client/src/lib/vouchers.ts'), 'utf8');
  const amounts = web.match(/const AMOUNT_VOUCHERS = \[([^\]]*)\]/)[1].match(/\d+/g).map(Number);
  assert.deepEqual(amounts, [...AMOUNT_VOUCHERS]);
  assert.equal(Number(web.match(/FOR_NAME_MAX = (\d+)/)[1]), FOR_NAME_MAX);
  assert.equal(Number(web.match(/FROM_NAME_MAX = (\d+)/)[1]), FROM_NAME_MAX);
});

test('katalog: služby ze Strapi + částky, id jako na webu', () => {
  assert.deepEqual(catalog.map((c) => c.id), ['sluzba-abc', 'castka-500', 'castka-1000', 'castka-1500', 'castka-2000']);
  assert.equal(catalog[0].serviceName, 'Gel lak manikúra');
  assert.equal(catalog[2].serviceName, null);
  assert.equal(buildCatalog(null).length, 4);
});

test('formulář: cena z katalogu, ne z prohlížeče; ořez a mezery', () => {
  const r = checkCheckout({ ...form, price: 1, sum: 1 }, catalog);
  assert.equal(r.ok, true);
  assert.equal(r.data.item.price, 1000);
  assert.equal(r.data.forName, 'Anna');
  assert.equal(r.data.fromName, 'Petra Nová');
  assert.equal(r.data.phone, null);
  assert.equal(checkCheckout({ ...form, forName: 'x'.repeat(50) }, catalog).data.forName.length, FOR_NAME_MAX);
  assert.equal(checkCheckout({ ...form, consent: 'true' }, catalog).ok, true);
});

test('formulář: první chyba podle pořadí', () => {
  assert.deepEqual(checkCheckout({ ...form, voucherId: 'castka-5' }, catalog), { ok: false, field: 'voucherId' });
  assert.deepEqual(checkCheckout({ ...form, voucherId: 'sluzba-gone' }, catalog), { ok: false, field: 'voucherId' });
  assert.deepEqual(checkCheckout({ ...form, forName: 'A' }, catalog), { ok: false, field: 'forName' });
  assert.deepEqual(checkCheckout({ ...form, fromName: '' }, catalog), { ok: false, field: 'fromName' });
  assert.deepEqual(checkCheckout({ ...form, email: 'petra@' }, catalog), { ok: false, field: 'email' });
  assert.deepEqual(checkCheckout({ ...form, consent: false }, catalog), { ok: false, field: 'consent' });
  assert.equal(checkCheckout(null, catalog).ok, false);
});

test('konfigurace: bez merchant/secret vypnuto; test je výchozí', () => {
  assert.equal(comgateConfig({}), null);
  assert.equal(comgateConfig({ COMGATE_MERCHANT: '1' }), null);
  assert.equal(comgateConfig({ COMGATE_MERCHANT: '1', COMGATE_SECRET: 's' }).test, true);
  assert.equal(comgateConfig({ COMGATE_MERCHANT: '1', COMGATE_SECRET: 's', COMGATE_TEST: 'false' }).test, false);
  assert.equal(comgateConfig({ COMGATE_MERCHANT: '1', COMGATE_SECRET: 's', COMGATE_TEST: 'nesmysl' }).test, true);
  assert.equal(comgateConfig({ COMGATE_MERCHANT: '1', COMGATE_SECRET: 's', COMGATE_API_URL: 'http://localhost:1354/' }).apiUrl, 'http://localhost:1354');
  assert.equal(basicAuth(cfg), 'Basic ' + Buffer.from('123456:s3cr3t').toString('base64'));
});

test('tělo platby: haléře, label ≤ 16, návrat na naši stránku, 24 h', () => {
  const b = createPaymentBody({ cfg, price: 990, idVoucher: '12345678', catalogId: 'sluzba-abc', email: 'a@b.cz', fullName: 'Petra', returnUrl: 'https://barbitch.cz/darkovy-voucher/dekujeme?t=x' });
  assert.equal(b.price, 99000);
  assert.equal(b.curr, 'CZK');
  assert.ok(PAYMENT_LABEL.length >= 1 && PAYMENT_LABEL.length <= 16);
  assert.equal(b.refId, '12345678');
  assert.equal(b.test, true);
  assert.equal(b.expirationTime, '24h');
  assert.equal(b.url_paid, b.url_cancelled);
  assert.equal(b.method, 'ALL');
});

test('odpověď na založení: jen code 0 s https adresou', () => {
  assert.deepEqual(parseCreateResponse({ code: 0, transId: 'T1', redirect: 'https://payments.comgate.cz/client/instructions/index?id=T1' }), { transId: 'T1', redirect: 'https://payments.comgate.cz/client/instructions/index?id=T1' });
  assert.equal(parseCreateResponse({ code: 1100, message: 'Unknown error' }), null);
  assert.equal(parseCreateResponse({ code: 0, transId: 'T1', redirect: 'javascript:alert(1)' }), null);
  assert.equal(parseCreateResponse(null), null);
  assert.equal(parseCreateResponse({ code: 0, transId: 'T1', redirect: 'http://localhost:1354/pay/T1' }), null);
  assert.equal(parseCreateResponse({ code: 0, transId: 'T1', redirect: 'http://localhost:1354/pay/T1' }, 'http://localhost:1354').transId, 'T1');
});

test('ověření stavu: PAID jen když sedí vše', () => {
  assert.deepEqual(statusVerdict(okStatus, payment), { action: 'paid', method: 'CARD_CZ_COMGATE' });
  assert.equal(statusVerdict({ ...okStatus, test: true }, payment).action, 'paid');
  assert.deepEqual(statusVerdict({ ...okStatus, price: '1000' }, payment), { action: 'mismatch', reason: 'price' });
  assert.deepEqual(statusVerdict({ ...okStatus, refId: '99999999' }, payment), { action: 'mismatch', reason: 'refId' });
  assert.deepEqual(statusVerdict({ ...okStatus, curr: 'EUR' }, payment), { action: 'mismatch', reason: 'curr' });
  assert.deepEqual(statusVerdict({ ...okStatus, transId: 'X' }, payment), { action: 'mismatch', reason: 'transId' });
  // testovací platba nesmí zaplatit ostrou objednávku
  assert.deepEqual(statusVerdict(okStatus, { ...payment, test: false }), { action: 'mismatch', reason: 'test' });
  assert.equal(statusVerdict({ code: 1400, message: 'x' }, payment).action, 'mismatch');
  assert.deepEqual(statusVerdict({ ...okStatus, status: 'CANCELLED', paymentErrorReason: 'CUSTOMER_CLICK' }, payment), { action: 'cancelled', reason: 'CUSTOMER_CLICK' });
  assert.deepEqual(statusVerdict({ ...okStatus, status: 'PENDING' }, payment), { action: 'pending' });
  assert.deepEqual(statusVerdict({ ...okStatus, status: 'AUTHORIZED' }, payment), { action: 'pending' });
});

test('přechody: paid jednou, pozdní platba po zrušení platí, refunded konečný', () => {
  const paid = { action: 'paid', method: null };
  const cancelled = { action: 'cancelled', reason: null };
  assert.equal(nextStatus('pending', paid), 'paid');
  assert.equal(nextStatus('cancelled', paid), 'paid');
  assert.equal(nextStatus('paid', paid), null);
  assert.equal(nextStatus('refunded', paid), null);
  assert.equal(nextStatus('pending', cancelled), 'cancelled');
  assert.equal(nextStatus('paid', cancelled), null);
  assert.equal(nextStatus('pending', { action: 'pending' }), null);
  assert.deepEqual(fromStatusesFor('paid'), ['pending', 'cancelled']);
  assert.deepEqual(fromStatusesFor('cancelled'), ['pending']);
  assert.deepEqual(fromStatusesFor('refunded'), ['paid']);
  assert.deepEqual(fromStatusesFor('pending'), []);
});

test('push: náš merchant a secret, jinak odmítnout', () => {
  assert.deepEqual(checkPush({ merchant: '123456', secret: 's3cr3t', transId: 'T1', status: 'PAID' }, cfg), { ok: true, transId: 'T1' });
  assert.deepEqual(checkPush({ merchant: '123456', secret: 'spatne', transId: 'T1' }, cfg), { ok: false, reason: 'secret' });
  assert.deepEqual(checkPush({ merchant: '123456', secret: 's3cr3', transId: 'T1' }, cfg), { ok: false, reason: 'secret' });
  assert.deepEqual(checkPush({ merchant: '999', secret: 's3cr3t', transId: 'T1' }, cfg), { ok: false, reason: 'merchant' });
  assert.deepEqual(checkPush({ merchant: '123456', secret: 's3cr3t' }, cfg), { ok: false, reason: 'transId' });
  assert.equal(checkPush(undefined, cfg).ok, false);
});

test('vypršení: pending po 24 h 15 min', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  assert.equal(isExpired({ paymentStatus: 'pending', createdAt: '2026-10-24T11:50:00Z' }, now), false);
  assert.equal(isExpired({ paymentStatus: 'pending', createdAt: '2026-10-24T11:40:00Z' }, now), true);
  assert.equal(isExpired({ paymentStatus: 'paid', createdAt: '2026-10-01T00:00:00Z' }, now), false);
});

test('vrácení: jen zaplacené a nevyužité, celá částka v haléřích', () => {
  assert.equal(refundBlock({ paymentStatus: 'paid' }, { dateRealized: null }), null);
  assert.equal(refundBlock({ paymentStatus: 'paid' }, { dateRealized: '2026-11-02' }), 'voucher_used');
  assert.equal(refundBlock({ paymentStatus: 'pending' }, null), 'not_paid');
  assert.equal(refundBlock({ paymentStatus: 'refunded' }, null), 'already_refunded');
  assert.deepEqual(refundBody(payment), { transId: 'AB12-CD34-EF56', amount: 100000, test: true, refId: '12345678' });
});

test('platnost 6 měsíců, konec měsíce jako date-fns addMonths', () => {
  assert.equal(validUntilOf('2026-10-24'), '24.04.2027');
  assert.equal(validUntilOf('2026-08-31'), '28.02.2027');
  assert.equal(validUntilOf('2027-08-31'), '29.02.2028');
});

test('stav pro stránku výsledku: e-mail jen po zaplacení', () => {
  assert.deepEqual(publicStatus({ paymentStatus: 'pending', price: 990, catalogId: 'sluzba-abc' }, 'pe•••@example.cz'), { status: 'pending', price: 990, voucherId: 'sluzba-abc', email: null });
  assert.equal(publicStatus({ paymentStatus: 'paid', price: 990, catalogId: 'x' }, 'pe•••@example.cz').email, 'pe•••@example.cz');
});

test('schema: platba nemá atribut `status` (ve Strapi 5 vyhrazený, panel ho ukazuje prázdný)', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../src/api/voucher-payment/content-types/voucher-payment/schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.attributes.status, undefined);
  assert.deepEqual(schema.attributes.paymentStatus.enum, ['pending', 'paid', 'cancelled', 'refunded']);
});
