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
const S = await import(dataUrl(js));
const svc = S.default;
const D = await import(dataUrl(toJs('src/api/digest/services/digest-attention.ts')));

const ITEM = 'api::stock-item.stock-item';
const MOVE = 'api::stock-move.stock-move';
const LEGACY = 'api::stock.stock';

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
    if (op === '$null') return arg ? val == null : val != null;
    throw new Error(`op ${op}`);
  });
};
const matches = (row, filters = {}) =>
  Object.entries(filters).every(([k, c]) => (k === '$or' ? c.some((f) => matches(row, f)) : matchCond(row[k], c)));

let seq = 1;
function fresh({ legacy = [] } = {}) {
  const db = { [ITEM]: [], [MOVE]: [], [LEGACY]: legacy };
  const logs = [];
  let clock = Date.parse('2026-10-13T08:00:00Z');
  globalThis.strapi = {
    rows: db,
    logs,
    contentTypes: { [LEGACY]: {} },
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
  assert.throws(() => S.qtyFromInput({ units: 1.5 }, item), (e) => e.code === 'bad_qty', 'штуки — целые');
  assert.throws(() => S.qtyFromInput({ packs: -1 }, item), (e) => e.code === 'bad_qty');
  assert.throws(() => S.qtyFromInput({ packs: 1.5 }, item), (e) => e.code === 'bad_qty', 'упаковки — целые');
  assert.equal(S.qtyFromInput({ units: '12,5' }, { packSize: 1, unit: 'ml' }), 12.5);
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
  const s = fresh({ legacy: [{ documentId: 'l1', name: 'DARK gel' }, { documentId: 'l2', name: 'dark  gel' }] });
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

  // автодополнение: свои + старая «Склад» (без дублей по регистру и пробелам) + места по умолчанию
  const sug = await svc.suggest({ session: admin });
  assert.deepEqual(sug.names, ['DARK gel', 'Rukavice S']);
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
