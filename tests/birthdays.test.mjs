// Дни рождения сотрудников (services/birthdays.ts, s221): разбор свободной строки
// даты, ближайшая дата (граница года, 29 февраля), горизонт 30 дней, сортировка,
// год рождения не уходит наружу, нераспознанные — только руководству.
// Сервис — НАСТОЯЩИЙ, на заглушке document service.
//
// Запуск: cd strapi && node --test tests/birthdays.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const file = path.resolve(import.meta.dirname, '../src/api/booking-engine/services/birthdays.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const B = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const svc = B.default;

const TODAY = '2026-09-28';

test('parseBirth: принятые форматы', () => {
  for (const s of ['03.10.1995', '3.10.1995', '03. 10. 1995', ' 03.10.1995 ', '03/10/1995', '03-10-1995', '1995-10-03', '1995-10-03T00:00:00.000Z']) {
    assert.deepEqual(B.parseBirth(s, 2026), { day: 3, month: 10 }, s);
  }
});

test('parseBirth: мусор и неправдоподобные даты не распознаются', () => {
  for (const s of ['', '-', null, undefined, 'нет', '03.10', '03.10.95', '31.02.1990', '00.10.1990', '10.13.1990', '29.02.1995', '03.10.1939', '03.10.2013', '03.10.2030', '1995-13-01', '3 октября 1995']) {
    assert.equal(B.parseBirth(s, 2026), null, String(s));
  }
  assert.deepEqual(B.parseBirth('29.02.1996', 2026), { day: 29, month: 2 });
  assert.deepEqual(B.parseBirth('03.10.2012', 2026), { day: 3, month: 10 }); // ровно 14 лет
});

test('nextOccurrence: сегодня, завтра, вчера, граница года', () => {
  assert.deepEqual(B.nextOccurrence(28, 9, TODAY), { next: '2026-09-28', daysLeft: 0 });
  assert.deepEqual(B.nextOccurrence(29, 9, TODAY), { next: '2026-09-29', daysLeft: 1 });
  assert.deepEqual(B.nextOccurrence(27, 9, TODAY), { next: '2027-09-27', daysLeft: 364 });
  assert.deepEqual(B.nextOccurrence(2, 1, '2026-12-20'), { next: '2027-01-02', daysLeft: 13 });
  // переход на зимнее время (25.10.2026) день не съедает
  assert.deepEqual(B.nextOccurrence(26, 10, '2026-10-24'), { next: '2026-10-26', daysLeft: 2 });
});

test('nextOccurrence: 29 февраля', () => {
  assert.deepEqual(B.nextOccurrence(29, 2, '2027-02-10'), { next: '2027-02-28', daysLeft: 18 });
  assert.deepEqual(B.nextOccurrence(29, 2, '2028-02-10'), { next: '2028-02-29', daysLeft: 19 });
  // 28.02 невисокосного года уже прошло → следующий год високосный
  assert.deepEqual(B.nextOccurrence(29, 2, '2027-03-01'), { next: '2028-02-29', daysLeft: 365 });
  assert.deepEqual(B.nextOccurrence(29, 2, '2027-02-28'), { next: '2027-02-28', daysLeft: 0 });
});

const ROWS = [
  { documentId: 'a', name: 'Zlata', position: 'master', dateBirth: '28.10.1990' }, // 30 дней — входит
  { documentId: 'b', name: 'Вика', position: 'administrator', dateBirth: '1999-09-28' }, // сегодня
  { documentId: 'c', name: 'Karina', position: 'master', dateBirth: '29.10.1992' }, // 31 день — нет
  { documentId: 'd', name: 'Evelína', position: 'master', dateBirth: '5. 10. 1988' },
  { documentId: 'e', name: 'Adéla', position: 'master', dateBirth: '05.10.2001' },
  { documentId: 'f', name: 'Mariia', position: 'manager', dateBirth: '-' },
  { documentId: 'g', name: '❌ Cristina', position: 'master', dateBirth: '30.09.1990' },
  { documentId: 'h', name: ' Yana ', position: 'master', dateBirth: '27.09.1990' }, // вчера
  { documentId: 'i', name: 'Бек', position: 'master', dateBirth: '' },
];

test('buildBirthdays: горизонт 30 дней, сортировка, служебные строки', () => {
  const r = B.buildBirthdays(ROWS, TODAY, true);
  assert.equal(r.today, TODAY);
  assert.equal(r.horizonDays, 30);
  assert.equal(r.nearestOnly, false);
  assert.deepEqual(r.items.map((i) => [i.name, i.daysLeft, i.next]), [
    ['Вика', 0, '2026-09-28'],
    ['Adéla', 7, '2026-10-05'],
    ['Evelína', 7, '2026-10-05'],
    ['Zlata', 30, '2026-10-28'],
  ]);
  assert.deepEqual(r.unknown, ['Mariia', 'Бек'].sort((a, b) => a.localeCompare(b, 'cs')));
  assert.deepEqual(r.items[0], { docId: 'b', name: 'Вика', position: 'administrator', day: 28, month: 9, next: '2026-09-28', daysLeft: 0 });
});

test('buildBirthdays: год рождения и сама строка наружу не уходят', () => {
  for (const management of [true, false]) {
    const out = JSON.stringify(B.buildBirthdays(ROWS, TODAY, management));
    for (const y of ['1990', '1999', '1992', '1988', '2001', 'dateBirth']) assert.equal(out.includes(y), false, y);
  }
});

test('buildBirthdays: нераспознанные видит только руководство', () => {
  assert.deepEqual(B.buildBirthdays(ROWS, TODAY, false).unknown, []);
  assert.equal(B.buildBirthdays(ROWS, TODAY, false).items.length, 4);
  assert.deepEqual(B.buildBirthdays([], TODAY, true), { today: TODAY, horizonDays: 30, items: [], nearestOnly: false, unknown: [] });
});

test('buildBirthdays: в 30 дней никого — отдаётся самый ближайший (все на эту дату)', () => {
  const rows = [
    { documentId: 'a', name: 'Zlata', position: 'master', dateBirth: '15.12.1990' }, // 78 дней
    { documentId: 'b', name: 'Adéla', position: 'master', dateBirth: '15.12.1995' }, // тот же день
    { documentId: 'c', name: 'Karina', position: 'master', dateBirth: '16.12.1992' },
    { documentId: 'd', name: 'Yana', position: 'master', dateBirth: '27.09.1990' }, // вчера → через год
    { documentId: 'e', name: 'Бек', position: 'master', dateBirth: '-' },
    { documentId: 'f', name: '❌ Cristina', position: 'master', dateBirth: '01.11.1990' },
  ];
  const r = B.buildBirthdays(rows, TODAY, false);
  assert.equal(r.nearestOnly, true);
  assert.deepEqual(r.items.map((i) => [i.name, i.daysLeft, i.next]), [
    ['Adéla', 78, '2026-12-15'],
    ['Zlata', 78, '2026-12-15'],
  ]);
  // ровно на границе горизонта — обычный список, не «ближайший»
  const edge = B.buildBirthdays([{ documentId: 'a', name: 'Z', dateBirth: '28.10.1990' }, { documentId: 'b', name: 'K', dateBirth: '15.12.1990' }], TODAY, false);
  assert.equal(edge.nearestOnly, false);
  assert.deepEqual(edge.items.map((i) => i.name), ['Z']);
  // 31 день — уже «ближайший»
  const over = B.buildBirthdays([{ documentId: 'a', name: 'Z', dateBirth: '29.10.1990' }], TODAY, false);
  assert.equal(over.nearestOnly, true);
  assert.equal(over.items[0].daysLeft, 31);
  // все даты не распознаны — пусто
  const none = B.buildBirthdays([{ documentId: 'a', name: 'Z', dateBirth: '-' }], TODAY, true);
  assert.deepEqual([none.items, none.nearestOnly, none.unknown], [[], false, ['Z']]);
  assert.equal(JSON.stringify(r).includes('199'), false);
});

test('сервис: запрос только активных опубликованных, из компонента — одно поле; день пражский', async () => {
  const calls = [];
  globalThis.strapi = {
    documents: (uid) => ({
      async findMany(q) {
        calls.push([uid, q]);
        return ROWS.map((r) => ({ documentId: r.documentId, name: r.name, position: r.position, oficial: { id: 1, dateBirth: r.dateBirth } }));
      },
    }),
  };
  // 27.09 22:30 UTC = 28.09 00:30 в Праге
  const now = new Date('2026-09-27T22:30:00Z');
  const admin = await svc.list({ session: { role: 'administrator' }, now });
  assert.equal(admin.today, TODAY);
  assert.equal(admin.items[0].name, 'Вика');
  assert.deepEqual(admin.unknown, []);
  for (const role of ['owner', 'manager']) {
    assert.equal((await svc.list({ session: { role }, now })).unknown.length, 2, role);
  }
  assert.deepEqual((await svc.list({ session: { role: 'master' }, now })).unknown, []);
  const [uid, q] = calls[0];
  assert.equal(uid, 'api::personal.personal');
  assert.equal(q.status, 'published');
  assert.deepEqual(q.filters, { isActive: { $eq: true } });
  assert.deepEqual(q.populate, { oficial: { fields: ['dateBirth'] } });
  assert.deepEqual(q.fields, ['name', 'position']);
});
