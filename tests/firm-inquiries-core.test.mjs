// Firemní poptávky voucherů (s274, services/firm-inquiries-core.ts): kontrola formuláře
// z webu, úprava z adminu, tvar řádku (bez storedName) a e-maily (escapování).
// Spuštění: cd strapi && node --test tests/firm-inquiries-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/api/booking-engine/services/firm-inquiries-core.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const { checkInquiry, checkUpdate, inquiryRow, salonEmail, confirmationEmail, STATUSES, FIRM_MIN_COUNT } = core;

const valid = {
  company: ' ACME s.r.o. ', ico: '12345678', count: '20', value: '1 000 Kč', person: 'Jana Nováková',
  phone: '+420 777 000 000', email: 'jana@acme.cz', note: 'Logo vpravo nahoře', consent: 'true',
};

test('platný formulář: ořez mezer, počet jako číslo', () => {
  const r = checkInquiry(valid);
  assert.equal(r.ok, true);
  assert.equal(r.data.company, 'ACME s.r.o.');
  assert.equal(r.data.count, 20);
  assert.equal('consent' in r.data, false);
});

test('chybná pole: první chyba podle pořadí formuláře', () => {
  assert.deepEqual(checkInquiry({ ...valid, company: 'A' }), { ok: false, field: 'company' });
  assert.deepEqual(checkInquiry({ ...valid, count: String(FIRM_MIN_COUNT - 1) }), { ok: false, field: 'count' });
  assert.deepEqual(checkInquiry({ ...valid, count: '12.5' }), { ok: false, field: 'count' });
  assert.deepEqual(checkInquiry({ ...valid, count: 'abc' }), { ok: false, field: 'count' });
  assert.deepEqual(checkInquiry({ ...valid, person: '' }), { ok: false, field: 'person' });
  assert.deepEqual(checkInquiry({ ...valid, email: 'jana@' }), { ok: false, field: 'email' });
  assert.deepEqual(checkInquiry({ ...valid, consent: 'false' }), { ok: false, field: 'consent' });
  assert.deepEqual(checkInquiry({ ...valid, consent: undefined }), { ok: false, field: 'consent' });
  assert.equal(checkInquiry(null).ok, false);
});

test('dlouhé texty se oříznou na limity', () => {
  const r = checkInquiry({ ...valid, note: 'x'.repeat(10000), company: 'y'.repeat(500) });
  assert.equal(r.data.note.length, 4000);
  assert.equal(r.data.company.length, 200);
});

test('úprava z adminu: jen známý stav a poznámka; nic platného → null', () => {
  assert.deepEqual(checkUpdate({ status: 'offer' }), { status: 'offer' });
  assert.deepEqual(checkUpdate({ adminNote: '  voláno ' }), { adminNote: 'voláno' });
  assert.deepEqual(checkUpdate({ status: 'won', adminNote: '' }), { status: 'won', adminNote: '' });
  assert.equal(checkUpdate({ status: 'hacked' }), null);
  assert.equal(checkUpdate({ company: 'X' }), null);
  assert.equal(checkUpdate(undefined), null);
  assert.deepEqual([...STATUSES], ['new', 'contacted', 'offer', 'won', 'lost']);
});

test('řádek pro admin: bez storedName, neznámý stav → new, logo jen když je', () => {
  const row = inquiryRow({
    documentId: 'abc', company: 'ACME', count: '20', status: 'weird',
    logoName: 'logo.png', logoMime: 'image/png', logoSize: 1234, logoStoredName: 'f'.repeat(32),
  });
  assert.equal(row.id, 'abc');
  assert.equal(row.count, 20);
  assert.equal(row.status, 'new');
  assert.deepEqual(row.logo, { name: 'logo.png', mime: 'image/png', size: 1234 });
  assert.equal(JSON.stringify(row).includes('f'.repeat(32)), false);
  assert.equal(inquiryRow({ documentId: 'x' }).logo, null);
});

test('e-maily: HTML z formuláře se escapuje, předmět s firmou a počtem', () => {
  const data = checkInquiry({ ...valid, company: '<b>Evil</b>', note: '<script>x</script>' }).data;
  const salon = salonEmail(data, 'logo.png', 'https://admin.barbitch.cz/firemni-poptavky?id=1');
  assert.equal(salon.subject, 'Firemní vouchery: <b>Evil</b> (20 ks)');
  assert.equal(salon.html.includes('<script>'), false);
  assert.ok(salon.html.includes('&lt;script&gt;'));
  assert.ok(salon.html.includes('logo.png (v příloze)'));
  assert.ok(salonEmail(data, null, '#').html.includes('nepřiloženo'));
  const confirm = confirmationEmail(data);
  assert.ok(confirm.html.includes('Děkujeme, Jana Nováková!'));
  assert.equal(confirm.html.includes('<b>Evil</b>'), false);
});
