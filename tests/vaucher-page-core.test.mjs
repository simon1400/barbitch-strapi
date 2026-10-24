// Karty „Voucher na službu“ pro web (s274, services/vaucher-page-core.ts): co ze
// seznamu ve Strapi projde na stránku a jak vypadá karta. Čistá funkce bez Strapi.
// Spuštění: cd strapi && node --test tests/vaucher-page-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/api/vaucher-page/services/vaucher-page-core.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { shapeServiceVouchers } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const svc = (over = {}) => ({
  documentId: 'wpz9', title: 'Gel lak manikúra', price: 990, active: true, onlineBookable: true, ...over,
});
const row = (over = {}) => ({
  service: svc(), tag: 'Nehty', name: '', title: 'Voucher na gel lak manikúru', desc: ' popis ',
  photo: { url: 'https://ik/orig.jpg', formats: { large: { url: 'https://ik/large.jpg' } } }, active: true, ...over,
});

test('karta: id podle služby, cena ze služby, name = název služby když prázdný, fotka large', () => {
  const [card] = shapeServiceVouchers([row()]);
  assert.deepEqual(card, {
    id: 'sluzba-wpz9', serviceId: 'wpz9', tag: 'Nehty', name: 'Gel lak manikúra',
    title: 'Voucher na gel lak manikúru', desc: 'popis', photo: 'https://ik/large.jpg', price: 990,
  });
});

test('vlastní name má přednost; bez title se odvodí „Voucher na <name>“; bez large formátu originál', () => {
  const [card] = shapeServiceVouchers([row({ name: 'Laminace obočí', title: '', photo: { url: 'https://ik/o.jpg' } })]);
  assert.equal(card.name, 'Laminace obočí');
  assert.equal(card.title, 'Voucher na laminace obočí');
  assert.equal(card.photo, 'https://ik/o.jpg');
});

test('vyřazeno: karta vypnutá, bez služby, služba vypnutá / bez online rezervace / nulová cena', () => {
  const rows = [
    row({ active: false }),
    row({ service: null }),
    row({ service: svc({ active: false }) }),
    row({ service: svc({ onlineBookable: false }) }),
    row({ service: svc({ price: 0 }) }),
    row({ service: svc({ documentId: 'ok' }) }),
  ];
  assert.deepEqual(shapeServiceVouchers(rows).map((c) => c.id), ['sluzba-ok']);
});

test('duplicitní služba jen jednou, pořadí = pořadí v CMS; prázdný / chybějící seznam → []', () => {
  const rows = [row({ service: svc({ documentId: 'b' }) }), row({ service: svc({ documentId: 'a' }) }), row({ service: svc({ documentId: 'b' }) })];
  assert.deepEqual(shapeServiceVouchers(rows).map((c) => c.serviceId), ['b', 'a']);
  assert.deepEqual(shapeServiceVouchers([]), []);
  assert.deepEqual(shapeServiceVouchers(null), []);
  assert.deepEqual(shapeServiceVouchers(undefined), []);
});

test('bez fotky → photo null (web vezme výchozí obrázek)', () => {
  assert.equal(shapeServiceVouchers([row({ photo: null })])[0].photo, null);
});
