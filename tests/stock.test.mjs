// «Sklad — zásoby» (services/stock.ts, s251 — Фаза 1 плана STOCK_NEXT_SESSION_PROMPT.md):
//   - количество: упаковки + штуки, «2 bal. + 5 ks»; штуки целые, ml/g до сотых;
//   - статус из остатка и минимума (в упаковках), «Co objednat» — до target, минимум одна упаковка;
//   - движения: пересчёт = введённое, приход > 0, «Došlo» → 0, «Málo» → не больше минимума;
//   - пора пересчитать — по пражским дням и `countEveryDays`; код места для QR без диакритики;
//   - роли: администратор смотрит/считает/принимает, но не правит позиции и НЕ видит цен;
//   - запись остатка условная по version — гонка двух приходов не теряет ни одного;
//   - журнал — entityType stock; дайджест — только названия.
// Запуск: cd strapi && node --test tests/stock.test.mjs

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

let js = toJs('src/api/booking-engine/services/stock.ts');
assert.ok(js.includes("from './slots-core'"));
js = js.split("from './slots-core'").join(`from '${dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'))}'`);
// s261: словарь названий старой «Склад» (коллекция удалена)
assert.ok(js.includes("from './stock-legacy-names'"));
js = js.split("from './stock-legacy-names'").join(`from '${dataUrl(toJs('src/api/booking-engine/services/stock-legacy-names.ts'))}'`);
const S = await import(dataUrl(js));
const svc = S.default;
const D = await import(dataUrl(toJs('src/api/digest/services/digest-attention.ts')));

const ITEM = 'api::stock-item.stock-item';
const MOVE = 'api::stock-move.stock-move';
const ORDER = 'api::stock-order.stock-order';

const owner = { id: 1, role: 'owner', username: 'Dima' };
const manager = { id: 11, role: 'manager', username: 'Mariia' };
const admin = { id: 12, role: 'administrator', username: 'Julia' };
const master = { id: 13, role: 'master', username: 'Karina' };

const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
const matchCond = (val, cond) => {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return val === cond;
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$eq') return val === arg;
    if (op === '$eqi') return String(val ?? '').toLowerCase() === String(arg).toLowerCase();
    if (op === '$lt') return val != null && val < arg;
    if (op === '$gte') return val != null && val >= arg;
    if (op === '$null') return arg ? val == null : val != null;
    throw new Error(`op ${op}`);
  });
};
const matches = (row, filters = {}) =>
  Object.entries(filters).every(([k, c]) => (k === '$or' ? c.some((f) => matches(row, f)) : matchCond(row[k], c)));

let seq = 1;
function fresh() {
  const db = { [ITEM]: [], [MOVE]: [], [ORDER]: [] };
  const logs = [];
  let clock = Date.parse('2026-10-13T08:00:00Z');
  globalThis.strapi = {
    rows: db,
    logs,
    documents: (uid) => ({
      async findMany({ filters = {}, limit, sort } = {}) {
        await tick();
        let rows = db[uid].filter((r) => matches(r, filters));
        if (sort?.[0]?.createdAt === 'desc') rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return clone(rows.slice(0, limit ?? 1000));
      },
      async findOne({ documentId }) {
        await tick();
        const r = db[uid].find((x) => x.documentId === documentId);
        return r ? clone(r) : null;
      },
      async create({ data }) {
        await tick();
        const row = { id: seq, documentId: `doc${String(seq++).padStart(18, '0')}`, createdAt: new Date((clock += 1000)).toISOString(), ...clone(data) };
        db[uid].push(row);
        return clone(row);
      },
      async update({ documentId, data }) {
        await tick();
        Object.assign(db[uid].find((x) => x.documentId === documentId), clone(data));
      },
    }),
    db: {
      query: (uid) => ({
        async updateMany({ where, data }) {
          await tick();
          const rows = db[uid].filter((r) => matches(r, where));
          for (const r of rows) Object.assign(r, clone(data));
          return { count: rows.length };
        },
      }),
    },
    service: (uid) => {
      // s252: заказы и push — свои наборы (stock-orders.test.mjs); здесь — «заказов нет», push молчит
      if (uid === 'api::booking-engine.stock-orders') return { openPacks: async () => new Map(), attention: async () => null };
      if (uid === 'api::booking-engine.stock-notify') return { itemOut: async () => ({ skipped: 'test' }) };
      assert.equal(uid, 'api::calendar-log.calendar-log');
      return { write: async (e) => void logs.push(e) };
    },
    log: { error() {}, warn() {} },
  };
  return globalThis.strapi;
}
const now = new Date('2026-10-13T10:00:00Z');
const expectErr = async (p, status, code) =>
  assert.rejects(p, (e) => (assert.equal(e.status, status, `${e.status} ${e.code}`), code && assert.equal(e.code, code), true));

const glovesS = { name: 'Rukavice S', category: 'hygiena', location: 'U dezinfekce', unit: 'ks', packSize: 100, min: 2, target: 6, supplier: 'Nehtyshop', lastPrice: 150 };

test('количество текстом и из формы', () => {
  assert.equal(S.fmtQty(205, 100, 'ks'), '2 bal. + 5 ks');
  assert.equal(S.fmtQty(300, 100, 'ks'), '3 bal.');
  assert.equal(S.fmtQty(40, 100, 'ks'), '40 ks');
  assert.equal(S.fmtQty(0, 100, 'ks'), '0 ks');
  assert.equal(S.fmtQty(12.5, 1, 'ml'), '12,5 ml');
  assert.equal(S.fmtQty(-3, 1, 'ks'), '0 ks');
  const item = { packSize: 100, unit: 'ks' };
  assert.equal(S.qtyFromInput({ packs: 2, units: 5 }, item), 205);
  assert.equal(S.qtyFromInput({ packs: '3' }, item), 300);
  assert.equal(S.qtyFromInput({ units: '0' }, item), 0);
  assert.throws(() => S.qtyFromInput({}, item), (e) => e.code === 'qty_required');
  assert.throws(() => S.qtyFromInput({ units: 1.5 }, item), (e) => e.code === 'bad_units', 'штуки — целые');
  assert.throws(() => S.qtyFromInput({ packs: -1 }, item), (e) => e.code === 'bad_packs');
  assert.throws(() => S.qtyFromInput({ packs: 1.5 }, item), (e) => e.code === 'bad_packs', 'упаковки штучных — целые');
  assert.equal(S.qtyFromInput({ units: '12,5' }, { packSize: 1, unit: 'ml' }), 12.5);
  // s258: у ml/g упаковки дробные — «0,2 канистры по 5000 ml» = 1000 ml; складывается с «navíc»
  assert.equal(S.qtyFromInput({ packs: '0,2' }, { packSize: 5000, unit: 'ml' }), 1000);
  assert.equal(S.qtyFromInput({ packs: '1.5', units: '250' }, { packSize: 500, unit: 'g' }), 1000);
  assert.throws(() => S.qtyFromInput({ packs: '-0.5' }, { packSize: 5000, unit: 'ml' }), (e) => e.code === 'bad_packs');
});

test('статус, «докупать до», сколько заказать', () => {
  const it = (qty, extra = {}) => ({ packSize: 100, min: 2, target: 6, qty, ...extra });
  assert.equal(S.statusOf(it(0)), 'out');
  assert.equal(S.statusOf(it(200)), 'low', 'ровно минимум — málo');
  assert.equal(S.statusOf(it(201)), 'ok');
  assert.equal(S.statusOf({ min: 0, qty: 1 }), 'ok');
  assert.equal(S.suggestedPacks(it(201)), 0);
  assert.equal(S.suggestedPacks(it(150)), 5, '6 − 1,5 → 5 (вверх)');
  assert.equal(S.suggestedPacks(it(0)), 6);
  assert.equal(S.suggestedPacks(it(0, { active: false })), 0, 'архив не заказываем');
  assert.equal(S.effectiveTarget({ min: 2, target: 0 }), 4, 'не задан — двойной минимум');
  assert.equal(S.effectiveTarget({ min: 0, target: 0 }), 1);
  assert.equal(S.effectiveTarget({ min: 3, target: 2 }), 6, 'target ≤ min не действует');
  assert.equal(S.suggestedPacks({ min: 0, target: 0, qty: 0, packSize: 1 }), 1, 'без минимума — došlo → одна');
  // s258: канистра 5 l — минимум 0,2 канистры (1000 ml); у штучных дробный минимум режется до целого
  const can = (qty, extra = {}) => ({ packSize: 5000, unit: 'ml', min: 0.2, target: 0, qty, ...extra });
  assert.equal(S.minBase(can(0)), 1000);
  assert.deepEqual([S.statusOf(can(1000)), S.statusOf(can(1000.5)), S.statusOf(can(4000))], ['low', 'ok', 'ok']);
  assert.equal(S.effectiveTarget(can(0)), 1.2, 'не задан — минимум + 1 (больше двойного)');
  assert.equal(S.suggestedPacks(can(500)), 2, '1,2 − 0,1 → 2 целых канистры');
  assert.equal(S.suggestedPacks(can(500, { target: 1 })), 1);
  assert.equal(S.minBase({ packSize: 100, unit: 'ks', min: 0.8 }), 0, 'штучные — целые упаковки');
  assert.equal(S.normalizeItemInput({ ...glovesS, unit: 'ml', packSize: 5000, min: '0,2', target: '' }).min, 0.2);
  assert.throws(() => S.normalizeItemInput({ ...glovesS, min: '0,2' }), (e) => e.code === 'bad_min', 'ks — целое');
  assert.throws(() => S.normalizeItemInput({ min: '0,5' }, { partial: true, current: { ...glovesS } }), (e) => e.code === 'bad_min', 'правка: единица из текущей');
  assert.equal(S.normalizeItemInput({ min: '0.5' }, { partial: true, current: { ...glovesS, unit: 'g' } }).min, 0.5);
});

test('движения', () => {
  const item = { packSize: 100, unit: 'ks', min: 2, qty: 350 };
  assert.deepEqual(S.computeMove(item, { kind: 'count', packs: 1, units: 20 }), { kind: 'count', mode: null, qtyBefore: 350, qtyAfter: 120, delta: -230 });
  assert.deepEqual(S.computeMove(item, { kind: 'count', packs: 3, units: 50 }).delta, 0, '«OK jak bylo»');
  assert.deepEqual(S.computeMove(item, { kind: 'in', packs: 2 }), { kind: 'in', mode: null, qtyBefore: 350, qtyAfter: 550, delta: 200 });
  assert.throws(() => S.computeMove(item, { kind: 'in', units: 0 }), (e) => e.code === 'qty_positive');
  assert.deepEqual(S.computeMove(item, { kind: 'out', mode: 'empty' }), { kind: 'out', mode: 'empty', qtyBefore: 350, qtyAfter: 0, delta: -350 });
  assert.deepEqual(S.computeMove(item, { kind: 'out', mode: 'low' }).qtyAfter, 200);
  assert.deepEqual(S.computeMove({ ...item, qty: 50 }, { kind: 'out', mode: 'low' }).qtyAfter, 50, 'уже ниже — не растёт');
  assert.throws(() => S.computeMove({ ...item, min: 0 }, { kind: 'out', mode: 'low' }), (e) => e.code === 'no_min');
  assert.throws(() => S.computeMove(item, { kind: 'adjust' }), (e) => e.code === 'bad_kind');
  assert.throws(() => S.computeMove(item, { kind: 'out', mode: 'half' }), (e) => e.code === 'bad_mode');
});

test('поля позиции', () => {
  assert.deepEqual(S.normalizeItemInput({ name: '  Rukavice   S ', location: 'U dezinfekce' }), {
    name: 'Rukavice S',
    category: 'jine',
    location: 'U dezinfekce',
    unit: 'ks',
    packSize: 1,
    min: 0,
    target: 0,
    supplier: '',
    url: '',
    lastPrice: null,
    countEveryDays: 7,
    note: '',
  });
  assert.throws(() => S.normalizeItemInput({ name: 'a' }), (e) => e.code === 'location_required');
  assert.throws(() => S.normalizeItemInput({ location: 'a' }), (e) => e.code === 'name_required');
  assert.throws(() => S.normalizeItemInput({ name: 'a', location: 'b', category: 'x' }), (e) => e.code === 'bad_category');
  assert.throws(() => S.normalizeItemInput({ name: 'a', location: 'b', min: 3, target: 3 }), (e) => e.code === 'target_below_min');
  assert.throws(() => S.normalizeItemInput({ target: 2 }, { partial: true, current: { min: 3 } }), (e) => e.code === 'target_below_min');
  assert.throws(() => S.normalizeItemInput({ name: 'a', location: 'b', url: 'javascript:alert(1)' }), (e) => e.code === 'bad_url');
  assert.throws(() => S.normalizeItemInput({ name: 'a', location: 'b', packSize: 0 }), (e) => e.code === 'bad_pack_size');
  assert.deepEqual(S.normalizeItemInput({ min: '4', lastPrice: '149,90' }, { partial: true }), { min: 4, lastPrice: 149.9 });
  assert.throws(() => S.normalizeItemInput({}, { partial: true }), (e) => e.code === 'nothing_to_change');
  assert.throws(() => S.normalizeItemInput({ active: 'no' }, { partial: true }), (e) => e.code === 'bad_active');
  assert.equal(S.normalizeItemInput({ name: 'a', location: 'b', active: false }).active, undefined, 'при создании архив не задаётся');
});

test('пора пересчитать; код места', () => {
  assert.deepEqual(S.countDueOf({ lastCountedAt: null }, now), { daysSinceCount: null, countDue: true });
  // 06.10 23:30 по Праге = 06.10 21:30Z → прошло 7 пражских дней к 13.10
  assert.deepEqual(S.countDueOf({ lastCountedAt: '2026-10-06T21:30:00Z', countEveryDays: 7 }, now), { daysSinceCount: 7, countDue: true });
  assert.deepEqual(S.countDueOf({ lastCountedAt: '2026-10-06T22:30:00Z', countEveryDays: 7 }, now), { daysSinceCount: 6, countDue: false });
  assert.equal(S.locationSlug('Skříň s laky'), 'skrin-s-laky');
  assert.equal(S.locationSlug('  Kuchyň / WC '), 'kuchyn-wc');
  assert.equal(S.locationSlug(''), 'bez-mista');
});

test('«Co objednat»: группы по поставщику, текст без цен, сумма только руководству', () => {
  const view = (d) => S.itemView({ documentId: d.name, active: true, ...d }, { now, showPrices: true });
  const items = [
    view({ ...glovesS, qty: 150 }),
    view({ name: 'Rukavice L', location: 'U dezinfekce', packSize: 100, min: 1, target: 3, qty: 0, supplier: 'Nehtyshop' }),
    view({ name: 'Toaletní papír', location: 'WC', packSize: 8, min: 1, qty: 30, supplier: '' }),
    view({ name: 'Kapesníky', location: 'Recepce', min: 2, qty: 1, supplier: 'Makro', lastPrice: 20 }),
  ];
  const g = S.orderGroups(items, { showPrices: true });
  assert.deepEqual(g.map((x) => x.supplier), ['Makro', 'Nehtyshop'], 'без поставщика — в конце; бумага в порядке');
  assert.deepEqual(g[1].lines.map((l) => [l.name, l.packs]), [['Rukavice L', 3], ['Rukavice S', 5]], 'došlo первыми');
  assert.equal(g[1].text, 'Objednávka — Nehtyshop\n• Rukavice L — 3 bal. (à 100 ks)\n• Rukavice S — 5 bal. (à 100 ks)');
  assert.equal(g[1].sum, 750);
  assert.equal(g[1].sumPartial, true, 'у Rukavice L цены нет');
  assert.equal(g[0].text, 'Objednávka — Makro\n• Kapesníky — 3 ks');
  const forAdmin = S.orderGroups(items, { showPrices: false });
  assert.ok(!JSON.stringify(forAdmin).includes('sum'), 'администратору — без сумм');
});

test('сервис: роли, цены, создание, движения, журнал', async () => {
  const s = fresh();
  await expectErr(svc.list({ session: master, now }), 403, 'not_allowed');

  const { item } = await svc.create({ session: manager, body: { ...glovesS, packs: 3, units: 40 }, now });
  assert.equal(item.qty, 340);
  assert.equal(item.qtyText, '3 bal. + 40 ks');
  assert.equal(item.lastPrice, 150);
  assert.equal(item.countDue, false, 'стартовый остаток = пересчёт');
  assert.deepEqual(s.rows[MOVE].map((m) => [m.kind, m.qtyAfter, m.by]), [['create', 340, 'Mariia']]);
  await expectErr(svc.create({ session: owner, body: { ...glovesS, name: 'rukavice s' }, now }), 409, 'duplicate_name');

  // администратор: видит без цены, считает, отмечает приход и «Došlo»
  const adminList = await svc.list({ session: admin, now });
  assert.equal(adminList.meta.canEdit, false);
  assert.equal(adminList.meta.showPrices, false);
  assert.ok(!('lastPrice' in adminList.items[0]), 'цены администратору нет');
  const one = await svc.item({ session: admin, id: item.documentId, now });
  assert.ok(!('lastPrice' in one.item));
  // s257: позиции правит и администратор, но цену — нет (поле отбрасывается)
  await expectErr(svc.update({ session: admin, id: item.documentId, body: { lastPrice: 1 }, now }), 400, 'nothing_to_change');

  const c = await svc.move({ session: admin, id: item.documentId, body: { kind: 'count', packs: 1, units: 50, note: 'po směně' }, now });
  assert.equal(c.item.status, 'low');
  assert.equal(c.item.lastCountedBy, 'Julia');
  assert.equal(c.move.deltaText, '−1 bal. + 90 ks');
  const inn = await svc.move({ session: admin, id: item.documentId, body: { kind: 'in', packs: 5 }, now });
  assert.equal(inn.item.qtyText, '6 bal. + 50 ks');
  assert.equal(inn.item.status, 'ok');
  assert.ok(!('lastPrice' in inn.item));
  const out = await svc.move({ session: admin, id: item.documentId, body: { kind: 'out', mode: 'empty' }, now });
  assert.equal(out.item.status, 'out');

  // журнал
  assert.deepEqual(s.logs.map((l) => [l.action, l.entityType]), [
    ['stock_item_create', 'stock'],
    ['stock_count', 'stock'],
    ['stock_in', 'stock'],
    ['stock_out', 'stock'],
  ]);
  assert.match(s.logs[2].summary, /Rukavice S — přišlo 5 bal\., stav 1 bal\. \+ 50 ks → 6 bal\. \+ 50 ks/);

  // настройки: только изменённое; архив
  const u = await svc.update({ session: owner, id: item.documentId, body: { min: 3, target: 8, supplier: 'Nehtyshop' }, now });
  assert.deepEqual([u.item.min, u.item.target], [3, 8]);
  assert.deepEqual(s.logs.at(-1).details.fields, ['min', 'target']);
  await svc.update({ session: owner, id: item.documentId, body: { active: false }, now });
  await expectErr(svc.move({ session: admin, id: item.documentId, body: { kind: 'in', packs: 1 }, now }), 409, 'item_archived');
  assert.equal((await svc.item({ session: admin, id: item.documentId, now })).item.active, false, 's257: архив видит и администратор');
  assert.equal((await svc.list({ session: owner, now })).items.length, 0);
  assert.equal((await svc.list({ session: owner, archived: '1', now })).items.length, 1);
  assert.equal((await svc.list({ session: admin, archived: '1', now })).items.length, 1, 's257: архив — и администратору');
  assert.equal((await svc.summary(now)).total, 0);

  // автодополнение: свои + словарь старой «Склад» (s261: коллекция удалена) без дублей по регистру + места по умолчанию
  const sug = await svc.suggest({ session: admin });
  assert.ok(sug.names.includes('Rukavice S') && sug.names.includes('DARK gel'));
  assert.equal(new Set(sug.names.map((n) => n.toLowerCase())).size, sug.names.length, 'без дублей по регистру');
  assert.ok(sug.names.length > 250, 'словарь старой «Склад» на месте');
  assert.ok(sug.locations.includes('Skříň s laky') && sug.locations.includes('U dezinfekce'));
  assert.deepEqual(sug.suppliers, ['Nehtyshop']);

  // журнал движений постранично
  const p1 = await svc.moves({ session: admin, item: item.documentId, limit: 2 });
  assert.deepEqual(p1.moves.map((m) => m.kind), ['out', 'in']);
  assert.equal(p1.hasMore, true);
  const p2 = await svc.moves({ session: admin, item: item.documentId, before: p1.moves[1].at, limit: 10 });
  assert.deepEqual(p2.moves.map((m) => m.kind), ['count', 'create']);
  assert.equal(p2.hasMore, false);
  await expectErr(svc.moves({ session: admin, item: 'x', limit: 2 }), 404);
});

test('гонка: два прихода одновременно — оба учтены (условная запись по version)', async () => {
  const s = fresh();
  const { item } = await svc.create({ session: owner, body: { name: 'Vata', location: 'Recepce', packs: 0, units: 10 }, now });
  await Promise.all([
    svc.move({ session: admin, id: item.documentId, body: { kind: 'in', units: 5 }, now }),
    svc.move({ session: manager, id: item.documentId, body: { kind: 'in', units: 7 }, now }),
  ]);
  assert.equal(s.rows[ITEM][0].qty, 22);
  assert.deepEqual(s.rows[MOVE].filter((m) => m.kind === 'in').map((m) => m.qtyBefore).sort((a, b) => a - b).length, 2);
  const ins = s.rows[MOVE].filter((m) => m.kind === 'in');
  assert.equal(ins[1].qtyBefore, ins[0].qtyAfter, 'второй приход считает от первого');
});

test('сводка и дайджест: только названия', async () => {
  fresh();
  await svc.create({ session: owner, body: { ...glovesS }, now });
  await svc.create({ session: owner, body: { name: 'Vlhčené utěrky', location: 'Kuchyň', min: 2, units: 1 }, now });
  await svc.create({ session: owner, body: { name: 'Káva', location: 'Kuchyň', min: 1, units: 5 }, now });
  await svc.create({ session: owner, body: { name: 'Papír', location: 'WC', units: 5 } , now });
  const sum = await svc.attention({ session: admin, now });
  assert.deepEqual([sum.total, sum.out.map((i) => i.name), sum.low.map((i) => i.name)], [4, ['Rukavice S'], ['Vlhčené utěrky']]);
  assert.equal(sum.countDue, 1, 'Rukavice S без стартового остатка — не считали');
  const { sections } = D.buildAttention({ today: '2026-10-13', stock: sum });
  const sec = sections.find((x) => x[0].startsWith('📦'));
  // s252: 13.10 — вторник; Rukavice S ни разу не считали → инвентура с понедельника не закончена
  assert.deepEqual(sum.inventory, { monday: '2026-10-12', isMonday: false, remaining: 1 });
  assert.deepEqual(sec, [
    '📦 <b>Склад (адмінка → Sklad):</b>',
    '• закінчилось: <b>Rukavice S</b>',
    '• нижче мінімуму: Vlhčené utěrky',
    '• інвентура з понеділка не завершена: 1',
  ]);
  const monday = D.buildAttention({ today: '2026-10-12', stock: { ...sum, inventory: { ...sum.inventory, isMonday: true } } }).sections[0];
  assert.ok(!monday.some((l) => l.includes('інвентура')), 'в понедельник 08:00 инвентура ещё впереди');
  const overdue = D.buildAttention({ today: '2026-10-13', stock: { out: [], low: [], overdue: [{ supplier: 'Nehtyshop', days: 9 }] } }).sections[0];
  assert.deepEqual(overdue, ['📦 <b>Склад (адмінка → Sklad):</b>', '• замовлення не прийшло: Nehtyshop (9 дн.)']);
  assert.equal(D.buildAttention({ today: '2026-10-13', stock: { out: [], low: [] } }).sections.length, 0);
  assert.ok(!JSON.stringify(sec).includes('Kč'));
});

test('s257: администратор заводит и правит позиции, архивирует; цену не задаёт и не видит', async () => {
  const s = fresh();
  const { item } = await svc.create({ session: admin, body: { ...glovesS, units: 30 }, now });
  assert.ok(!('lastPrice' in item));
  assert.equal(s.rows[ITEM][0].lastPrice, null, 'цена от администратора не записана');
  assert.equal(s.rows[ITEM][0].createdByName, 'Julia');
  const u = await svc.update({ session: admin, id: item.documentId, body: { min: 3, target: 8, lastPrice: 999 }, now });
  assert.deepEqual([u.item.min, u.item.target], [3, 8]);
  assert.deepEqual(s.logs.at(-1).details.fields, ['min', 'target']);
  assert.equal(s.rows[ITEM][0].lastPrice, null, 'и при правке');
  await svc.update({ session: admin, id: item.documentId, body: { active: false }, now });
  assert.equal(s.rows[ITEM][0].active, false);
  await svc.update({ session: admin, id: item.documentId, body: { active: true }, now });
  // руководство цену задаёт по-прежнему
  await svc.update({ session: manager, id: item.documentId, body: { lastPrice: 150 }, now });
  assert.equal(s.rows[ITEM][0].lastPrice, 150);
  const list = await svc.list({ session: admin, now });
  assert.equal(list.meta.canEditItems, true);
  assert.equal(list.meta.canEdit, false, 'заказы и цены — по-прежнему руководство');
  assert.ok(!('lastPrice' in list.items[0]));
});

// ───────────── s261, Фаза 3: прогноз расхода, «brzy dojde», подсказка минимума, отчёт «Spotřeba» ─────────────
const mv = (at, kind, qtyBefore, qtyAfter, extra = {}) => ({ itemDocId: 'it1', kind, qtyBefore, qtyAfter, delta: qtyAfter - qtyBefore, createdAt: new Date(at).toISOString(), ...extra });

test('s261: интервалы расхода — между наблюдениями, приход не наблюдение, время без товара не считается', () => {
  const { intervals, last } = S.usageIntervals([
    mv('2026-10-08T08:00:00Z', 'count', 600, 500),
    mv('2026-10-01T08:00:00Z', 'create', 0, 600), // порядок движений — любой
    mv('2026-10-10T08:00:00Z', 'in', 500, 700),
    mv('2026-10-12T08:00:00Z', 'out', 700, 700, { mode: 'low' }), // «Málo» без изменения — не наблюдение
    mv('2026-10-15T08:00:00Z', 'count', 700, 600),
  ]);
  assert.deepEqual(intervals.map((i) => i.used), [100, 100]);
  assert.equal(intervals[1].from, Date.parse('2026-10-08T08:00:00Z'));
  assert.deepEqual(last, { at: Date.parse('2026-10-15T08:00:00Z'), qty: 600, since: Date.parse('2026-10-15T08:00:00Z') });
  // кончилось 01.10, пришло 10.10, пересчёт 17.10: расход 70 за 7 дней (не за 16)
  const gap = S.usageIntervals([
    mv('2026-10-01T08:00:00Z', 'out', 20, 0, { mode: 'empty' }),
    mv('2026-10-10T08:00:00Z', 'in', 0, 100),
    mv('2026-10-17T08:00:00Z', 'count', 100, 30),
  ]);
  assert.deepEqual(gap.intervals, [{ from: Date.parse('2026-10-10T08:00:00Z'), to: Date.parse('2026-10-17T08:00:00Z'), used: 70 }]);
  // создана без остатка (0) — не наблюдение; первый пересчёт — начало
  assert.equal(S.usageIntervals([mv('2026-10-01T08:00:00Z', 'create', 0, 0), mv('2026-10-03T08:00:00Z', 'in', 0, 50), mv('2026-10-09T08:00:00Z', 'count', 50, 40)]).intervals.length, 0);
});

test('s261: прогноз — расход в день, на сколько хватит, brzy dojde, подсказка минимума', () => {
  const gloves = { documentId: 'it1', ...glovesS, qty: 600, active: true };
  const moves = [mv('2026-10-01T08:00:00Z', 'create', 0, 600), mv('2026-10-08T08:00:00Z', 'count', 600, 500), mv('2026-10-10T08:00:00Z', 'in', 500, 700), mv('2026-10-15T08:00:00Z', 'count', 700, 600)];
  const t = new Date('2026-10-15T12:00:00Z');
  const f = S.forecastOf(gloves, moves, t);
  assert.equal(f.forecastDays, 14);
  assert.equal(f.avgDailyUse, 14.286);
  assert.equal(f.useText, '~14 ks za den');
  assert.equal(f.daysLeft, 41, '600 / 14,3 = 42 − 4 часа после пересчёта → 41 целый');
  assert.equal(f.leftText, 'vystačí ~41 dní');
  assert.equal(f.soon, false);
  assert.equal(f.suggestedMin, 2, '14,3 × 14 дней = 200 ks = 2 bal.');
  // через 30 дней без пересчёта остаток «тает»: хватит на 11 дней
  assert.equal(S.forecastOf(gloves, moves, new Date('2026-11-14T12:00:00Z')).daysLeft, 11);
  // мало наблюдений — прогноза нет
  const short = S.forecastOf(gloves, moves.slice(0, 1).concat(mv('2026-10-06T08:00:00Z', 'count', 600, 550)), t);
  assert.deepEqual([short.avgDailyUse, short.daysLeft, short.soon, short.suggestedMin, short.forecastDays], [null, null, false, null, 5]);
  // больше минимума (200), но хватит на 8 дней → brzy dojde, и его заказываем
  const soonItem = { ...gloves, qty: 250 };
  const fs2 = S.forecastOf(soonItem, [mv('2026-10-01T08:00:00Z', 'create', 0, 460), mv('2026-10-08T08:00:00Z', 'count', 460, 250)], new Date('2026-10-08T09:00:00Z'));
  assert.deepEqual([fs2.daysLeft, fs2.soon], [8, true]);
  assert.equal(S.suggestedPacks(soonItem), 0, 'без прогноза — в порядке');
  assert.equal(S.suggestedPacks(soonItem, { soon: true }), 4, 'до target 6: 6 − 2,5 → 4');
  const v = S.itemView(soonItem, { now: new Date('2026-10-08T09:00:00Z'), showPrices: false, history: new Map([['it1', [mv('2026-10-01T08:00:00Z', 'create', 0, 460), mv('2026-10-08T08:00:00Z', 'count', 460, 250)]]]) });
  assert.deepEqual([v.status, v.soon, v.suggestedPacks, v.toOrderPacks, v.leftText], ['ok', true, 4, 4, 'vystačí ~8 dní']);
  const g = S.orderGroups([v], { showPrices: false });
  assert.deepEqual(g[0].lines.map((l) => [l.name, l.packs, l.soon, l.leftText]), [['Rukavice S', 4, true, 'vystačí ~8 dní']]);
  assert.equal(S.attentionOf([v]).low.length, 0, 'карточки «Сегодня» brzy dojde не считают');
  // уже ниже минимума — это «Málo», а не brzy dojde
  assert.equal(S.forecastOf({ ...gloves, qty: 150 }, moves, t).soon, false);
  // канистра 5 l: подсказка минимума — до десятых упаковки
  const can = { documentId: 'it1', unit: 'ml', packSize: 5000, min: 0.2, qty: 3000, active: true };
  const fc = S.forecastOf(can, [mv('2026-10-01T08:00:00Z', 'create', 0, 4000), mv('2026-10-11T08:00:00Z', 'count', 4000, 3000)], new Date('2026-10-11T09:00:00Z'));
  assert.deepEqual([fc.useText, fc.suggestedMin], ['~100 ml za den', 0.3]);
  assert.equal(S.useText(0.2, 'ks'), '~1,4 ks za týden');
  assert.equal(S.useText(0.01, 'g'), '~0,3 g za měsíc');
  // отметка «управляющая знает»: brzy dojde снимает только приход
  assert.equal(S.clearNotified('soon', 'ok', 'count'), false);
  assert.equal(S.clearNotified('soon', 'ok', 'in'), true);
  assert.equal(S.clearNotified('low', 'ok', 'count'), true);
  assert.equal(S.clearNotified('low', 'low', 'in'), false);
  assert.equal(S.clearNotified(null, 'ok', 'in'), false);
});

test('s261: месяц отчёта — пражские границы, соседние месяцы, неверный — 400', () => {
  const r = S.monthRange(undefined, new Date('2026-10-15T12:00:00Z'));
  assert.deepEqual([r.month, r.from, r.to, r.prev, r.next, r.current], ['2026-10', '2026-09-30T22:00:00.000Z', '2026-10-31T23:00:00.000Z', null, null, true]);
  assert.equal(r.days, 14.6);
  const nov = S.monthRange('2026-11', new Date('2026-12-02T12:00:00Z'));
  assert.deepEqual([nov.prev, nov.next, nov.current, nov.days], ['2026-10', '2026-12', false, 30]);
  for (const bad of ['2026-09', '2026-11', '2026-1', 'x', '2026-13']) assert.throws(() => S.monthRange(bad, new Date('2026-10-15T12:00:00Z')), (e) => e.status === 400 && e.code === 'bad_month', bad);
});

test('s261: отчёт «Spotřeba» — пришло, израсходовано пропорционально месяцу, деньги только руководству', () => {
  const items = [
    { documentId: 'it1', name: 'Rukavice S', category: 'hygiena', location: 'U dezinfekce', unit: 'ks', packSize: 10, lastPrice: 100, active: true },
    { documentId: 'it2', name: 'Káva', category: 'kuchyn', location: 'Kuchyň', unit: 'ks', packSize: 1, lastPrice: null, active: true },
    { documentId: 'old', name: 'Starý', category: 'jine', location: 'WC', unit: 'ks', packSize: 1, active: false },
  ];
  const moves = [
    mv('2026-09-26T00:00:00Z', 'create', 0, 100),
    mv('2026-10-03T00:00:00Z', 'in', 100, 200),
    mv('2026-10-06T00:00:00Z', 'count', 200, 150), // 26.09 → 06.10: 50 за 10 дней, в октябре — 5 дней → 25
    mv('2026-10-16T00:00:00Z', 'count', 150, 100), // целиком в октябре — 50
  ];
  const range = { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };
  const own = S.usageReport({ items, moves, ...range, showPrices: true });
  assert.deepEqual(own.items.map((r) => r.name), ['Rukavice S', 'Káva'], 'архив без движений — не в отчёте; порядок — по категориям');
  const g = own.items[0];
  assert.deepEqual([g.inQty, g.inText, g.usedQty, g.usedText, g.coveredDays], [100, '10 bal.', 75, '7 bal. + 5 ks', 15]);
  assert.deepEqual([g.inValue, g.usedValue], [1000, 750]);
  assert.deepEqual([own.items[1].usedText, own.items[1].inValue], ['—', null]);
  assert.deepEqual(own.categories.map((c) => [c.label, c.inValue, c.usedValue]), [['Hygiena', 1000, 750], ['Kuchyň', 0, 0]]);
  assert.deepEqual(own.totals, { items: 2, withUse: 1, inValue: 1000, usedValue: 750, unpriced: 0 });
  const adm = S.usageReport({ items, moves, ...range, showPrices: false });
  assert.ok(!JSON.stringify(adm).match(/Value|price|unpriced/), 'администратору — без денег');
  // архивная позиция с расходом за месяц — в отчёте
  const arch = S.usageReport({ items: [{ ...items[0], active: false }], moves, ...range, showPrices: false });
  assert.equal(arch.items.length, 1);
  const paid = S.receiptsPaidOf(
    [{ receipts: [{ at: '2026-10-05T10:00:00Z', sum: 500 }, { at: '2026-10-07T10:00:00Z', sum: null }, { at: '2026-09-30T10:00:00Z', sum: 999 }] }, { receipts: null }],
    range.from,
    range.to
  );
  assert.deepEqual(paid, { paid: 500, receipts: 2, noSum: 1 });
});

test('s261: сервис — прогноз в списке и на экране позиции, отчёт по ролям, словарь вместо старой «Склад»', async () => {
  const s = fresh();
  const { item } = await svc.create({ session: owner, body: { ...glovesS, packs: 6 }, now: new Date('2026-09-20T08:00:00Z') });
  const id = item.documentId;
  s.rows[MOVE] = [
    { ...mv('2026-10-01T08:00:00Z', 'create', 0, 600), itemDocId: id },
    { ...mv('2026-10-12T08:00:00Z', 'count', 600, 250), itemDocId: id },
  ];
  s.rows[ITEM][0].qty = 250;
  const later = new Date('2026-10-12T09:00:00Z');
  const list = await svc.list({ session: admin, now: later });
  // 350 ks за 11 дней ≈ 31,8 в день → 250 хватит на 7 дней (≤ SOON_DAYS), хотя выше минимума 200
  assert.deepEqual([list.items[0].status, list.items[0].soon, list.items[0].daysLeft, list.items[0].useText], ['ok', true, 7, '~32 ks za den']);
  const one = await svc.item({ session: admin, id, now: later });
  assert.equal(one.item.daysLeft, list.items[0].daysLeft);
  const ord = await svc.order({ session: manager, now: later });
  assert.equal(ord.groups[0].lines[0].soon, true);
  // движение возвращает позицию уже с прогнозом
  const mvRes = await svc.move({ session: admin, id, body: { kind: 'count', units: 240 }, now: new Date('2026-10-12T10:00:00Z') });
  assert.ok(mvRes.item.avgDailyUse > 0);

  s.rows[ORDER] = [{ documentId: 'o1', createdAt: '2026-10-02T08:00:00Z', updatedAt: '2026-10-05T10:00:00Z', receipts: [{ at: '2026-10-05T10:00:00Z', sum: 900 }] }];
  const rep = await svc.report({ session: owner, month: '2026-10', now: later });
  assert.equal(rep.month, '2026-10');
  assert.equal(rep.items[0].name, 'Rukavice S');
  assert.equal(rep.totals.paid, 900);
  assert.equal(rep.meta.showPrices, true);
  const repAdm = await svc.report({ session: admin, now: later });
  assert.ok(!('paid' in repAdm.totals) && !('inValue' in repAdm.items[0]), 'администратору без денег');
  await expectErr(svc.report({ session: master, now: later }), 403, 'not_allowed');
  await expectErr(svc.report({ session: owner, month: '2027-01', now: later }), 400, 'bad_month');
  // сбой истории — список работает без прогноза
  const realDocs = s.documents;
  s.documents = (uid) => (uid === MOVE ? { findMany: async () => { throw new Error('db down'); }, create: realDocs(uid).create } : realDocs(uid));
  const noHist = await svc.list({ session: admin, now: later });
  assert.deepEqual([noHist.items[0].avgDailyUse, noHist.items[0].soon], [null, false]);
  s.documents = realDocs;
});

test('s264: материалы мастеров — Nehty/Řasy/Obočí открыты в форме, оттенок в названии, «Jiné» последней', () => {
  const keys = S.CATEGORIES.map((c) => c.key);
  assert.deepEqual(keys, ['hygiena', 'uklid', 'kuchyn', 'kancelar', 'nehty', 'rasy', 'oboci', 'jine']);
  assert.ok(S.CATEGORIES.every((c) => !('later' in c)), 'ни одна категория не спрятана');
  const schema = JSON.parse(read('src/api/stock-item/content-types/stock-item/schema.json'));
  assert.deepEqual([...schema.attributes.category.enum].sort(), [...keys].sort(), 'enum схемы = список категорий');
  const gel = S.normalizeItemInput({ name: 'DNKA gel 012', category: 'nehty', location: 'Skříň s laky', unit: 'ml', packSize: 15, min: '0,5' });
  assert.equal(gel.category, 'nehty');
  assert.equal(gel.name, 'DNKA gel 012');
  for (const category of ['rasy', 'oboci']) assert.equal(S.normalizeItemInput({ name: 'X', category, location: 'Skříň s laky' }).category, category);
});
