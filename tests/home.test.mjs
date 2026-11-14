// Данные главной сайта (services/home.ts, s286): популярные услуги (статусы,
// internal/korekce не считаются, лимит на группу, добор при нехватке), цены «od»
// (продление ресниц без снятия/доплнения), команда (только разрешённые поля,
// галочка, ушедшие). Сервис — НАСТОЯЩИЙ, на заглушке document service.
//
// Запуск: cd strapi && node --test tests/home.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const wamUrl = dataUrl(toJs(read('src/utils/works-as-master.ts')));
const H = await import(
  dataUrl(toJs(read('src/api/booking-engine/services/home.ts')).replace("from '../../../utils/works-as-master'", `from '${wamUrl}'`))
);
const svc = H.default;

// ── каталог как на проде (13.11, /api/engine/services) ──
const S = (documentId, title, category, price, durationMin, variants = []) => ({
  documentId,
  title,
  category,
  price,
  durationMin,
  variants: variants.map((d) => ({ label: `v${d}`, priceDiff: d })),
});
const CATALOG = [
  S('hyg', 'Hygienická manikúra', 'Nehty 💅💅💅', 650, 45, [0, 120]),
  S('gel', 'Gel lak manikúra', 'Nehty 💅💅💅', 990, 90, [200, 400]),
  S('ext', 'Prodloužení nehtů', 'Nehty 💅💅💅', 1100, 150, [100]),
  S('sun', 'Sundání nehtů', 'Nehty 💅💅💅', 650, 30),
  S('kor', 'Korekce do 5 dnů', 'Nehty 💅💅💅', 0, 60),
  S('vos', 'Úprava tvaru, korekce voskem / pinzetou', 'Obočí🤨🩷', 350, 30, [100]),
  S('lam', 'Laminace + úprava tvaru', 'Obočí🤨🩷', 880, 50, [300]),
  S('lash', 'Lash lifting', 'Řasy – barvení a péče ☁️', 990, 50, [300]),
  S('barv', 'Barvení řas', 'Řasy – barvení a péče ☁️', 330, 30),
  S('1d', '1D (Classic)', 'Prodlužování řas 👁️👄👁️', 970, 90),
  S('2d', '2D', 'Prodlužování řas 👁️👄👁️', 1090, 90, [60]),
  S('dop', 'Doplnění řas', 'Prodlužování řas 👁️👄👁️', 770, 60, [50]),
  S('sunr', 'Sundání řas', 'Prodlužování řas 👁️👄👁️', 300, 30),
];
const B = (ids, extra = {}) => ({ status: 'active', internal: false, korekce: false, services: ids.map((serviceDocId) => ({ serviceDocId, variant: null, modifiers: [] })), ...extra });

test('sectionOfCategory: группы каталога с эмодзи → разделы /book', () => {
  assert.equal(H.sectionOfCategory('Nehty 💅💅💅'), 'Nehty');
  assert.equal(H.sectionOfCategory('Obočí🤨🩷'), 'Oboci');
  assert.equal(H.sectionOfCategory('Řasy – barvení a péče ☁️'), 'Rasy_barveni_a_pece');
  assert.equal(H.sectionOfCategory('Prodlužování řas 👁️👄👁️'), 'Prodluzovani_ras');
  assert.equal(H.sectionOfCategory('Ostatní'), null);
  assert.equal(H.sectionOfCategory(''), null);
});

test('cleanCategory: без эмодзи', () => {
  assert.equal(H.cleanCategory('Nehty 💅💅💅'), 'Nehty');
  assert.equal(H.cleanCategory('Obočí🤨🩷'), 'Obočí');
  assert.equal(H.cleanCategory('Řasy – barvení a péče ☁️'), 'Řasy – barvení a péče');
  assert.equal(H.cleanCategory('Prodlužování řas 👁️👄👁️'), 'Prodlužování řas');
});

test('countServiceUsage: отменённые, internal и korekce не считаются, noshow считается', () => {
  const c = H.countServiceUsage([
    B(['gel']),
    B(['gel'], { status: 'checkedOut' }),
    B(['gel'], { status: 'noshow' }),
    B(['gel'], { status: 'cancelled' }),
    B(['gel'], { internal: true }),
    B(['gel'], { korekce: true }),
    B(['gel'], { internal: null, korekce: null }),
    B(['gel', 'gel', 'lam']), // одна бронь — +1 услуге, даже если пункт повторён
    { status: 'active', services: null },
    { status: 'active', services: [{ title: 'без id' }] },
  ]);
  assert.equal(c.get('gel'), 5);
  assert.equal(c.get('lam'), 1);
  assert.equal(c.size, 2);
});

test('pickPopular: по числу броней, не больше 2 из группы', () => {
  const counts = new Map([['gel', 30], ['hyg', 25], ['ext', 20], ['1d', 10], ['lam', 5], ['lash', 3]]);
  const ids = H.pickPopular(CATALOG, counts, { limit: 4, perCategory: 2 }).map((s) => s.documentId);
  assert.deepEqual(ids, ['gel', 'hyg', '1d', 'lam']); // ext — третий маникюр, отсечён
});

test('pickPopular: лимит 1 на группу', () => {
  const counts = new Map([['gel', 30], ['hyg', 25], ['1d', 10], ['2d', 9], ['lam', 5]]);
  const ids = H.pickPopular(CATALOG, counts, { limit: 4, perCategory: 1 }).map((s) => s.documentId);
  assert.deepEqual(ids, ['gel', '1d', 'lam', 'lash']); // 4-й — добор: первая по каталогу из свободной группы
});

test('pickPopular: снятие и бесплатная корекция в топ не попадают', () => {
  const counts = new Map([['sun', 99], ['kor', 99], ['sunr', 99], ['gel', 1]]);
  const ids = H.pickPopular(CATALOG, counts, { limit: 4 }).map((s) => s.documentId);
  assert.ok(!ids.some((id) => ['sun', 'kor', 'sunr'].includes(id)), ids.join());
  assert.equal(ids[0], 'gel');
});

test('pickPopular: данных мало — добор по порядку каталога, лимит на группу соблюдается', () => {
  const ids = H.pickPopular(CATALOG, new Map([['lash', 2]]), { limit: 4, perCategory: 2 }).map((s) => s.documentId);
  assert.deepEqual(ids, ['lash', 'hyg', 'gel', 'vos']);
  // совсем нет броней
  assert.deepEqual(H.pickPopular(CATALOG, new Map(), { limit: 4 }).map((s) => s.documentId), ['hyg', 'gel', 'vos', 'lam']);
});

test('pickPopular: при нехватке групп добирает и сверх лимита', () => {
  const small = CATALOG.filter((s) => s.category.startsWith('Nehty'));
  const ids = H.pickPopular(small, new Map(), { limit: 3, perCategory: 2 }).map((s) => s.documentId);
  assert.deepEqual(ids, ['hyg', 'gel', 'ext']);
});

test('shapePopular: только нужные поля, цена «od», ссылка на шаг услуги', () => {
  const p = H.shapePopular(CATALOG[1]);
  assert.deepEqual(p, {
    id: 'gel',
    title: 'Gel lak manikúra',
    category: 'Nehty',
    price: 990,
    from: true,
    durationMin: 90,
    bookingSection: 'Nehty',
    bookHref: '/book/gel',
  });
  assert.equal(H.shapePopular(CATALOG[9]).from, false); // 1D без вариантов
  assert.deepEqual(H.priceOf({ price: 1000, variants: [{ priceDiff: -200 }, { priceDiff: 100 }] }), { price: 800, from: true });
});

test('minPrices: продление ресниц без снятия/доплнения/корекции', () => {
  assert.deepEqual(H.minPrices(CATALOG), { manikura: 650, oboci: 350, rasy: 970 });
  assert.deepEqual(H.minPrices([]), { manikura: null, oboci: null, rasy: null });
});

test('specializationOf и firstName', () => {
  assert.equal(H.specializationOf(['Nehty 💅💅💅']), 'Manikúra');
  assert.equal(H.specializationOf(['Obočí🤨🩷', 'Prodlužování řas 👁️👄👁️', 'Řasy – barvení a péče ☁️']), 'Řasy a obočí');
  assert.equal(H.specializationOf(['Obočí', 'Nehty', 'Prodlužování řas']), 'Manikúra, řasy a obočí');
  assert.equal(H.specializationOf([]), '');
  assert.equal(H.firstName('  Karina  Nováková '), 'Karina');
  assert.equal(H.firstName(''), '');
});

test('clampLimit', () => {
  assert.equal(H.clampLimit(undefined), 4);
  assert.equal(H.clampLimit('2'), 2);
  assert.equal(H.clampLimit('0'), 4);
  assert.equal(H.clampLimit('99'), 8);
  assert.equal(H.clampLimit('abc'), 4);
});

// ── сервис на заглушке document service ──

const PERSONALS = [
  {
    documentId: 'p1',
    name: 'Zlata Kovalenko',
    isActive: true,
    calendarOrder: 3,
    showOnHomepage: null, // старая строка — колонка появилась позже → показывать
    publicNote: null,
    leftAt: null,
    photo: { url: 'https://ik.imagekit.io/x/z.jpg', width: 900, height: 1200, hash: 'h' },
    services: [{ category: 'Nehty 💅💅💅' }],
    // поля, которые наружу уйти НЕ должны
    ratePercent: 40,
    rates: [{ sum: 1 }],
    oficial: { dateBirth: '01.01.1990', passport: 'X' },
    phone: '+420',
    hiredAt: '2025-01-01',
  },
  { documentId: 'p2', name: 'Karina', isActive: true, calendarOrder: 1, showOnHomepage: true, publicNote: ' Gel lak a design ', photo: null, services: [] },
  { documentId: 'p3', name: 'Skrytá', isActive: true, calendarOrder: 2, showOnHomepage: false, services: [] },
  { documentId: 'p4', name: 'Odešla', isActive: true, calendarOrder: 0, leftAt: '2026-01-01', services: [] },
  { documentId: 'p5', name: 'Odejde', isActive: true, calendarOrder: 4, leftAt: '2099-01-01', services: [{ category: 'Obočí' }] },
];

const makeStrapi = (calls) => ({
  documents: (uid) => ({
    findMany: async (q) => {
      calls.push({ uid, q });
      if (uid === 'api::salon-service.salon-service') return CATALOG;
      if (uid === 'api::booking.booking') return [B(['lam']), B(['lam']), B(['gel']), B(['lam'], { internal: true }), B(['1d'], { korekce: true })];
      if (uid === 'api::personal.personal') return PERSONALS;
      return [];
    },
  }),
});

test('service.team: только разрешённые поля, галочка, ушедшие, порядок', async () => {
  const calls = [];
  globalThis.strapi = makeStrapi(calls);
  H.clearHomeCache();
  const { team } = await svc.team();
  assert.deepEqual(team.map((m) => m.name), ['Karina', 'Zlata', 'Odejde']);
  for (const m of team) assert.deepEqual(Object.keys(m).sort(), ['bookHref', 'id', 'name', 'photo', 'specialization']);
  assert.equal(team[0].specialization, 'Gel lak a design');
  assert.equal(team[0].photo, null);
  assert.deepEqual(team[1].photo, { url: 'https://ik.imagekit.io/x/z.jpg', width: 900, height: 1200 });
  assert.equal(team[1].specialization, 'Manikúra');
  const json = JSON.stringify(team);
  for (const bad of ['oficial', 'ratePercent', 'rates', 'passport', '1990', 'hiredAt', '+420', 'Kovalenko']) assert.ok(!json.includes(bad), bad);
  // запрос: только опубликованные, фильтр «работает как мастер», ограниченный набор полей
  const q = calls.find((c) => c.uid === 'api::personal.personal').q;
  assert.equal(q.status, 'published');
  assert.ok(q.filters.$or, 'WORKS_AS_MASTER_FILTER');
  assert.ok(!q.fields.includes('oficial') && !q.populate.oficial);
});

test('service.popularServices: бронирования за 30 дней, кэш', async () => {
  const calls = [];
  globalThis.strapi = makeStrapi(calls);
  H.clearHomeCache();
  const r = await svc.popularServices('4');
  assert.equal(r.days, 30);
  assert.deepEqual(r.services.map((s) => s.id), ['lam', 'gel', 'hyg', 'vos']);
  for (const s of r.services) assert.ok(!('count' in s) && !('revenue' in s));
  const bq = calls.find((c) => c.uid === 'api::booking.booking').q;
  assert.deepEqual(bq.filters.status, { $in: ['active', 'checkedOut', 'noshow'] });
  assert.ok(bq.filters.date.$gte < bq.filters.date.$lte);
  await svc.popularServices('4');
  assert.equal(calls.filter((c) => c.uid === 'api::booking.booking').length, 1, 'второй вызов из кэша');
});

test('service.servicePrices', async () => {
  globalThis.strapi = makeStrapi([]);
  H.clearHomeCache();
  assert.deepEqual(await svc.servicePrices(), { manikura: 650, oboci: 350, rasy: 970 });
});
