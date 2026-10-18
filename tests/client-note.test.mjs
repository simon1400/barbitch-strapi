// Заметка о клиентке (s267): чистые помощники utils/client-note — какую часть
// поля `clients.notes` видят люди и что уходит в календарь.
//
// Запуск: cd strapi && node --test tests/client-note.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = import.meta.dirname;
const src = fs.readFileSync(path.resolve(here, '../src/utils/client-note.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { clientNoteOf, withClientNote, withBookingClientNote, CLIENT_NOTE_MAX } = await import(
  'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64')
);

const MERGE = 'Sloučeno 2026-09-12: Jana Nová · jana@x.cz · +420606000111 (id=812)';

test('строки слияния дублей скрываются, остальной текст остаётся', () => {
  assert.equal(clientNoteOf(`Husté řasy\n${MERGE}`), 'Husté řasy');
  assert.equal(clientNoteOf(`${MERGE}\nAlergie na lepidlo`), 'Alergie na lepidlo');
  assert.equal(clientNoteOf(`Řádek 1\r\nŘádek 2`), 'Řádek 1\nŘádek 2');
});

test('только строки слияния / пусто / не строка → null', () => {
  assert.equal(clientNoteOf(MERGE), null);
  assert.equal(clientNoteOf(`${MERGE}\n${MERGE.replace('812', '813')}`), null);
  assert.equal(clientNoteOf(''), null);
  assert.equal(clientNoteOf(null), null);
  assert.equal(clientNoteOf(undefined), null);
  assert.equal(clientNoteOf(42), null);
});

test('похожий на слияние людской текст не прячется', () => {
  // без «(id=…)» в конце — это написал человек
  assert.equal(clientNoteOf('Sloučeno 2026-09-12: neplatila'), 'Sloučeno 2026-09-12: neplatila');
});

test('withClientNote: новый текст + прежние строки слияния', () => {
  assert.equal(withClientNote(`stará\n${MERGE}`, ' nová '), `nová\n${MERGE}`);
  assert.equal(withClientNote(`stará\n${MERGE}`, ''), MERGE);
  assert.equal(withClientNote('stará', ''), null);
  assert.equal(withClientNote(null, 'nová'), 'nová');
  assert.equal(clientNoteOf(withClientNote(`x\n${MERGE}`, 'Husté řasy')), 'Husté řasy');
});

test('withBookingClientNote: заметка наверх, сырое notes из client убрано', () => {
  const b = { documentId: 'b1', client: { name: 'Jana', notes: `Husté řasy\n${MERGE}` } };
  const out = withBookingClientNote(b);
  assert.equal(out.clientNote, 'Husté řasy');
  assert.deepEqual(out.client, { name: 'Jana' });
  assert.equal('notes' in b.client, true, 'исходный объект не мутируется');
});

test('withBookingClientNote: бронь без клиента (интерная / старая) → clientNote null', () => {
  assert.equal(withBookingClientNote({ documentId: 'b2', client: null }).clientNote, null);
  assert.equal(withBookingClientNote({ documentId: 'b3' }).clientNote, null);
});

test('лимит длины — 1000 знаков (тот же в админке)', () => {
  assert.equal(CLIENT_NOTE_MAX, 1000);
  const adminSrc = fs.readFileSync(path.resolve(here, '../../admin/src/lib/clientNote.ts'), 'utf8');
  assert.match(adminSrc, /CLIENT_NOTE_MAX = 1000\b/);
  // регулярка строки слияния — одна и та же в обоих зеркалах
  const re = (s) => /MERGE_LINE_RE = (\/.*\/);?$/m.exec(s)?.[1];
  assert.ok(re(src), 'регулярка в utils/client-note не найдена');
  assert.equal(re(adminSrc), re(src), 'зеркало admin/src/lib/clientNote.ts разошлось');
});

// 🟥 Мастеру заметка — только у своей брони. Метод вырезается из движка как есть
// (2500 строк со своими импортами тянуть незачем, копия в тесте разошлась бы).
test('мастер: заметка у своей брони есть, у чужой — null; контакты не уходят', () => {
  const engine = fs.readFileSync(path.resolve(here, '../src/api/booking-engine/services/booking-engine.ts'), 'utf8');
  const m = /\n  (_scopeBookingForMaster\(b, ownNoonaId\) \{[\s\S]*?\n  \}),\n/.exec(engine);
  assert.ok(m, '_scopeBookingForMaster не найден в booking-engine.ts');
  const objJs = ts.transpileModule(`const korekceOfForMaster = (k) => k;\nexport default { ${m[1]} };`, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(objJs, 'utf8').toString('base64')).then(({ default: svc }) => {
    const raw = { client: { name: 'Jana', phone: '+420606000111', notes: `Husté řasy\n${MERGE}` }, totalPrice: 900 };
    const own = svc._scopeBookingForMaster(withBookingClientNote({ ...raw, noonaEmployeeId: 'm1' }), 'm1');
    assert.equal(own.clientNote, 'Husté řasy');
    assert.equal(own.client, undefined);
    const other = svc._scopeBookingForMaster(withBookingClientNote({ ...raw, noonaEmployeeId: 'm2' }), 'm1');
    assert.equal(other.clientNote, null);
    assert.equal(other.client, undefined);
    assert.equal(other.totalPrice, null);
    // мастер без сопоставленной карточки — ни одной своей брони
    const none = svc._scopeBookingForMaster(withBookingClientNote({ ...raw, noonaEmployeeId: 'm1' }), null);
    assert.equal(none.clientNote, null);
  });
});
