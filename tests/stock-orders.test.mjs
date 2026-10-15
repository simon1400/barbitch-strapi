// «Sklad — zásoby», Фаза 2 (s252): заказы (services/stock-orders.ts), напоминания (services/stock-notify.ts)
// и то, что Фаза 2 добавила в stock.ts (уже заказано, «Rychlá inventura» по понедельникам).
//   - заказ: строки только из активных позиций, черновик → «objednáno» → приход (частичный / «kompletní»);
//   - приход: остатки растут движением `in` с orderDocId; руководство — затрата сразу, администратор —
//     запрос на неё (costs.requestCreate), без суммы — «Náklad nezapsán», руководство дописывает;
//     двойное «Přijato» по старой версии заказа — 409, приход не задваивается;
//   - 🟥 администратору цены строк, суммы заказа и прихода не отдаются;
//   - «Co objednat» вычитает заказанное и не пришедшее; полностью покрытое — в `covered`;
//   - напоминания: «došlo» — управляющей сразу (если отметила не она), сводка 10:00 — только новое и
//     не заказанное, отметка notifiedStatus; понедельник — инвентура администраторам, 19:00 — эскалация
//     управляющей + запись журнала от «Systém»; всё под STOCK_PUSH_ENABLED.
// Запуск: cd strapi && node --test tests/stock-orders.test.mjs

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
const swap = (js, from, url) => {
  assert.ok(js.includes(`from '${from}'`), `импорт ${from}`);
  return js.split(`from '${from}'`).join(`from '${url}'`);
};

const slotsUrl = dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'));
const namesUrl = dataUrl(toJs('src/api/booking-engine/services/stock-legacy-names.ts'));
const stockUrl = dataUrl(swap(swap(toJs('src/api/booking-engine/services/stock.ts'), './slots-core', slotsUrl), './stock-legacy-names', namesUrl));
const ordersUrl = dataUrl(swap(swap(toJs('src/api/booking-engine/services/stock-orders.ts'), './slots-core', slotsUrl), './stock', stockUrl));
const notifyUrl = dataUrl(swap(swap(toJs('src/api/booking-engine/services/stock-notify.ts'), './slots-core', slotsUrl), './stock', stockUrl));
const S = await import(stockUrl);
const O = await import(ordersUrl);
const N = await import(notifyUrl);

const ITEM = 'api::stock-item.stock-item';
const MOVE = 'api::stock-move.stock-move';
const ORDER = 'api::stock-order.stock-order';
const ADMIN_USER = 'api::admin-user.admin-user';

const owner = { id: 1, role: 'owner', username: 'Dima' };
const manager = { id: 11, role: 'manager', username: 'Mariia' };
const admin = { id: 12, role: 'administrator', username: 'Julia' };

const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const matchCond = (val, cond) => {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return iso(val) === iso(cond);
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$eq') return val === arg;
    if (op === '$eqi') return String(val ?? '').toLowerCase() === String(arg).toLowerCase();
    if (op === '$in') return arg.includes(val);
    if (op === '$lt') return val != null && iso(val) < iso(arg);
    if (op === '$gte') return val != null && iso(val) >= iso(arg);
    if (op === '$null') return arg ? val == null : val != null;
    throw new Error(`op ${op}`);
  });
};
const matches = (row, filters = {}) =>
  Object.entries(filters).every(([k, c]) => (k === '$or' ? c.some((f) => matches(row, f)) : matchCond(row[k], c)));

let seq = 1;
/** Склад в памяти + настоящие stock / stock-orders / stock-notify; затраты и push — шпионы. */
function fresh({ admins = ['Julia', 'Vika'] } = {}) {
  const db = { [ITEM]: [], [MOVE]: [], [ORDER]: [], [ADMIN_USER]: admins.map((u, i) => ({ documentId: `adm${i}`, username: u, role: 'administrator' })) };
  db[ADMIN_USER].push({ documentId: 'own', username: 'Dima', role: 'owner' });
  const logs = [];
  const costs = [];
  const pushes = [];
  let clock = Date.parse('2026-10-13T08:00:00Z');
  const costsSvc = {
    checkInput({ body }) {
      if (!(Number(body.sum) > 0)) throw Object.assign(new Error('bad sum'), { status: 400, code: 'bad_sum' });
      return body;
    },
    async create({ session, body }) {
      const row = { documentId: `cost${String(seq++).padStart(18, '0')}`, ...clone(body), author: session.username };
      costs.push({ kind: 'cost', ...row });
      return { row };
    },
    async requestCreate({ session, body, source }) {
      const id = `req${String(seq++).padStart(19, '0')}`;
      costs.push({ kind: 'request', id, by: session.username, source, ...clone(body) });
      return { request: { id } };
    },
    async attachFile(x) {
      costs.push({ kind: 'file', costDocId: x.costDocId || null, requestDocId: x.requestDocId || null });
      return { file: { id: 'f1' } };
    },
  };
  const mn = {
    async toManagers(payload, kind) {
      pushes.push({ to: 'manager', kind, ...payload });
      return { sent: 1 };
    },
    async toOwner(payload, kind) {
      pushes.push({ to: 'owner', kind, ...payload });
      return { sent: 1 };
    },
  };
  const pushSvc = {
    async notifyByNames(names, payload) {
      pushes.push({ to: 'admins', names, ...payload });
      return { sent: names.length };
    },
  };
  globalThis.strapi = {
    rows: db,
    logs,
    costs,
    pushes,
    contentTypes: {},
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
        const t = new Date((clock += 1000)).toISOString();
        const row = { id: seq, documentId: `doc${String(seq++).padStart(18, '0')}`, createdAt: t, updatedAt: t, ...clone(data) };
        for (const k of Object.keys(row)) row[k] = iso(row[k]);
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
          for (const r of rows) Object.assign(r, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, iso(v)])));
          return { count: rows.length };
        },
      }),
    },
    service: (uid) => {
      if (uid === 'api::booking-engine.stock') return S.default;
      if (uid === 'api::booking-engine.stock-orders') return O.default;
      if (uid === 'api::booking-engine.stock-notify') return N.default;
      if (uid === 'api::booking-engine.costs') return costsSvc;
      if (uid === 'api::booking-engine.manager-notify') return mn;
      if (uid === 'api::booking-engine.push-notify') return pushSvc;
      assert.equal(uid, 'api::calendar-log.calendar-log');
      return { write: async (e) => void logs.push(e) };
    },
    log: { error() {}, warn() {}, info() {} },
  };
  return globalThis.strapi;
}

const now = new Date('2026-10-13T10:00:00Z'); // вторник
const expectErr = async (p, status, code) =>
  assert.rejects(p, (e) => (assert.equal(e.status, status, `${e.status} ${e.code}`), code && assert.equal(e.code, code), true));
const item = (name, extra = {}) => ({ name, location: 'U dezinfekce', category: 'hygiena', ...extra });

async function seedItems() {
  const st = S.default;
  const g = (await st.create({ session: manager, body: item('Rukavice S', { packSize: 100, min: 2, target: 6, supplier: 'Nehtyshop', lastPrice: 150, units: 50 }), now })).item;
  const v = (await st.create({ session: manager, body: item('Vata', { min: 1, target: 4, supplier: 'Nehtyshop', lastPrice: 40, units: 1 }), now })).item;
  const p = (await st.create({ session: manager, body: item('Papír', { location: 'WC', min: 2, target: 6, supplier: 'Makro', units: 1 }), now })).item;
  return { g, v, p };
}

// ── чистые функции ────────────────────────────────────────────────────────────

test('понедельник недели и «Rychlá inventura»: срок наступает в течение недели', () => {
  assert.equal(S.mondayOf('2026-10-13'), '2026-10-12');
  assert.equal(S.mondayOf('2026-10-12'), '2026-10-12');
  assert.equal(S.mondayOf('2026-10-18'), '2026-10-12', 'воскресенье — та же неделя');
  assert.equal(S.inventoryDueOf({ lastCountedAt: null }, now), true, 'ни разу не считали');
  assert.equal(S.inventoryDueOf({ lastCountedAt: '2026-10-12T07:00:00Z', countEveryDays: 7 }, now), false, 'посчитали в понедельник');
  assert.equal(S.inventoryDueOf({ lastCountedAt: '2026-10-07T07:00:00Z', countEveryDays: 7 }, now), true, 'в среду прошлой недели — пора к концу этой');
  assert.equal(S.inventoryDueOf({ lastCountedAt: '2026-10-07T07:00:00Z', countEveryDays: 30 }, now), false, 'раз в месяц — ещё рано');
  assert.equal(S.inventoryDueOf({ lastCountedAt: '2026-09-14T07:00:00Z', countEveryDays: 30 }, now), true, 'срок 14.10 — на этой неделе');
  assert.equal(S.inventoryDueOf({ lastCountedAt: null, active: false }, now), false, 'архив — нет');
});

test('строки заказа и поля: только активные позиции, целые упаковки, без дублей', () => {
  const items = new Map([
    ['a1aaaaaaaaaa', { documentId: 'a1aaaaaaaaaa', name: 'Rukavice S', packSize: 100, unit: 'ks' }],
    ['b2bbbbbbbbbb', { documentId: 'b2bbbbbbbbbb', name: 'Káva', packSize: 1, unit: 'g' }],
  ]);
  assert.deepEqual(O.normalizeOrderInput({ supplier: ' Nehtyshop ', lines: [{ itemDocId: 'a1aaaaaaaaaa', packs: '3', price: '149,90' }] }, items), {
    supplier: 'Nehtyshop',
    note: '',
    expectedDays: 7,
    payment: null,
    lines: [{ itemDocId: 'a1aaaaaaaaaa', name: 'Rukavice S', packSize: 100, unit: 'ks', packs: 3, receivedPacks: 0, price: 149.9 }],
  });
  const bad = (body, code) => assert.throws(() => O.normalizeOrderInput(body, items), (e) => e.code === code, code);
  bad({ lines: [] }, 'lines_required');
  bad({ lines: [{ itemDocId: 'zzzzzzzzzzzz', packs: 1 }] }, 'unknown_item');
  bad({ lines: [{ itemDocId: 'a1aaaaaaaaaa', packs: 1 }, { itemDocId: 'a1aaaaaaaaaa', packs: 2 }] }, 'duplicate_line');
  bad({ lines: [{ itemDocId: 'a1aaaaaaaaaa', packs: 0 }] }, 'bad_packs');
  bad({ lines: [{ itemDocId: 'a1aaaaaaaaaa', packs: 1.5 }] }, 'bad_packs');
  bad({ lines: [{ itemDocId: 'a1aaaaaaaaaa', packs: 1 }], payment: 'bitcoin' }, 'bad_payment');
  bad({ lines: [{ itemDocId: 'a1aaaaaaaaaa', packs: 1 }], expectedDays: 0 }, 'bad_expected_days');
  assert.deepEqual(O.normalizeOrderInput({ note: ' x ' }, items, { partial: true }), { note: 'x' });
  assert.throws(() => O.normalizeOrderInput({}, items, { partial: true }), (e) => e.code === 'nothing_to_change');
});

test('приход: частичный, сверх заказанного, «kompletní»; затрата из формы', () => {
  const order = { lines: [{ itemDocId: 'a', name: 'A', packs: 3, receivedPacks: 0 }, { itemDocId: 'b', name: 'B', packs: 2, receivedPacks: 1 }] };
  const p1 = O.receivePlan(order, { lines: [{ itemDocId: 'a', packs: 2 }, { itemDocId: 'b', packs: 0 }] });
  assert.deepEqual(p1.received, [{ itemDocId: 'a', name: 'A', packs: 2 }]);
  assert.deepEqual(p1.nextLines.map((l) => l.receivedPacks), [2, 1]);
  assert.equal(p1.complete, false);
  assert.equal(O.receivePlan(order, { lines: [{ itemDocId: 'a', packs: 2 }], complete: true }).complete, true, 'остальное не придёт');
  assert.equal(O.receivePlan(order, { lines: [{ itemDocId: 'a', packs: 4 }, { itemDocId: 'b', packs: 1 }] }).complete, true, 'пришло всё (и сверх)');
  assert.throws(() => O.receivePlan(order, { lines: [{ itemDocId: 'a', packs: 0 }] }), (e) => e.code === 'nothing_received');
  assert.throws(() => O.receivePlan(order, { lines: [{ itemDocId: 'x', packs: 1 }] }), (e) => e.code === 'unknown_line');
  assert.throws(() => O.receivePlan(order, {}), (e) => e.code === 'lines_required');

  const ctx = { today: '2026-10-13', supplier: 'Nehtyshop', payment: 'transfer', received: [{ name: 'A', packs: 2 }] };
  assert.equal(O.receiptCostDraft(null, ctx), null);
  assert.deepEqual(O.receiptCostDraft({ sum: '1 210' }, ctx), {
    date: '2026-10-13',
    name: 'Sklad — Nehtyshop',
    category: 'Материалы',
    sum: 1210,
    noDph: 1000,
    payment: 'transfer',
    comment: 'Objednávka ze skladu: A 2×',
  });
  assert.equal(O.receiptCostDraft({ sum: 1120, vat: 12, payment: 'cash' }, ctx).noDph, 1000);
  assert.equal(O.receiptCostDraft({ sum: 500, vat: 0 }, { ...ctx, payment: null }).payment, 'card');
  assert.throws(() => O.receiptCostDraft({ sum: 1, vat: 15 }, ctx), (e) => e.code === 'bad_vat');
});

test('вид заказа: просрочка по пражским дням, администратору без цен', () => {
  const doc = {
    documentId: 'o1',
    status: 'sent',
    supplier: 'Nehtyshop',
    expectedDays: 7,
    sentAt: '2026-10-05T08:00:00Z',
    lines: [
      { itemDocId: 'a', name: 'Rukavice S', packSize: 100, unit: 'ks', packs: 3, receivedPacks: 1, price: 150 },
      { itemDocId: 'b', name: 'Vata', packSize: 1, unit: 'ks', packs: 2, receivedPacks: 0, price: null },
    ],
    receipts: [{ at: '2026-10-10T10:00:00Z', by: 'Julia', role: 'administrator', lines: [{ itemDocId: 'a', name: 'Rukavice S', packs: 1 }], sum: 150, cost: { mode: 'request', status: 'pending', requestDocId: 'r1' } }],
  };
  const m = O.orderView(doc, { now, showPrices: true });
  assert.equal(m.overdue, true, '8 дней > 7');
  assert.equal(m.daysSinceSent, 8);
  assert.equal(m.sum, 450);
  assert.equal(m.sumPartial, true);
  assert.equal(m.remainingPacks, 4);
  assert.equal(m.costPending, true);
  assert.equal(m.receipts[0].sum, 150);
  assert.equal(m.text, 'Objednávka — Nehtyshop\n• Rukavice S — 3 bal. (à 100 ks)\n• Vata — 2 ks');
  assert.equal(O.orderView({ ...doc, sentAt: '2026-10-06T08:00:00Z' }, { now, showPrices: true }).overdue, false, 'ровно 7 — ещё не просрочен');
  const a = O.orderView(doc, { now, showPrices: false });
  const json = JSON.stringify(a);
  assert.ok(!('sum' in a) && !('price' in a.lines[0]) && !('sum' in a.receipts[0]), 'цен администратору нет');
  assert.ok(!json.includes('150') && !json.includes('requestDocId'), json);
  assert.deepEqual(a.receipts[0].cost, { mode: 'request', status: 'pending' });
  assert.deepEqual([...O.openPacksOf([doc, { ...doc, status: 'received' }, { ...doc, status: 'draft', lines: [{ itemDocId: 'b', packs: 5, receivedPacks: 0 }] }])], [['a', 2], ['b', 7]]);
});

// ── сервис ────────────────────────────────────────────────────────────────────

test('заказ из «Co objednat»: черновик → objednáno; уже заказанное вычитается; правят только руководство и до прихода', async () => {
  const s = fresh();
  const { g, v, p } = await seedItems();
  const before = await S.default.order({ session: manager, now });
  assert.deepEqual(before.groups.map((x) => [x.supplier, x.lines.map((l) => [l.name, l.packs])]), [
    ['Makro', [['Papír', 5]]],
    ['Nehtyshop', [['Rukavice S', 6], ['Vata', 3]]],
  ]);
  await expectErr(O.default.create({ session: admin, body: { supplier: 'Nehtyshop', lines: [{ itemDocId: g.documentId, packs: 6 }] }, now }), 403, 'edit_not_allowed');
  const { order } = await O.default.create({
    session: manager,
    body: { supplier: 'Nehtyshop', payment: 'transfer', lines: [{ itemDocId: g.documentId, packs: 4, price: 150 }, { itemDocId: v.documentId, packs: 3 }] },
    now,
  });
  assert.equal(order.status, 'draft');
  assert.equal(order.sum, 600);
  assert.equal(s.logs.at(-1).action, 'stock_order_create');

  const after = await S.default.order({ session: manager, now });
  assert.deepEqual(after.groups.map((x) => [x.supplier, x.lines.map((l) => [l.name, l.packs, l.onOrderPacks])]), [
    ['Makro', [['Papír', 5, 0]]],
    ['Nehtyshop', [['Rukavice S', 2, 4]]],
  ], 'Rukavice: 6 − 4 заказано; Vata заказана целиком');
  assert.deepEqual(after.covered.map((c) => [c.name, c.onOrderPacks]), [['Vata', 3]]);
  const att = await S.default.attention({ session: manager, now });
  assert.deepEqual(att.low.find((i) => i.name === 'Vata').onOrder, true);
  assert.equal(att.orders.drafts, 1);
  assert.equal(att.orders.waiting, 0);

  const ed = await O.default.update({ session: owner, id: order.documentId, body: { lines: [{ itemDocId: g.documentId, packs: 6 }] }, now });
  assert.deepEqual(ed.order.lines.map((l) => [l.name, l.packs]), [['Rukavice S', 6]]);
  await expectErr(O.default.update({ session: owner, id: order.documentId, body: { lines: [{ itemDocId: p.documentId, packs: 0 }] }, now }), 400, 'bad_packs');
  // администратор не видит черновиков
  assert.equal((await O.default.list({ session: admin, now })).orders.length, 0);
  const sent = await O.default.send({ session: manager, id: order.documentId, now });
  assert.equal(sent.order.status, 'sent');
  assert.equal(sent.order.sentBy, 'Mariia');
  await expectErr(O.default.send({ session: manager, id: order.documentId, now }), 409, 'order_not_draft');
  const adminList = await O.default.list({ session: admin, now });
  assert.equal(adminList.orders.length, 1);
  assert.ok(!JSON.stringify(adminList).includes('"sum"') && !JSON.stringify(adminList).includes('"price"'), 'цен администратору нет');
  assert.equal(adminList.meta.showPrices, false);
});

test('приход администратором: остатки сразу, запрос на затрату, чек — к запросу; двойное «Přijato» — 409', async () => {
  const s = fresh();
  const { g, v } = await seedItems();
  const { order } = await O.default.create({
    session: manager,
    body: { supplier: 'Nehtyshop', status: 'sent', lines: [{ itemDocId: g.documentId, packs: 4, price: 150 }, { itemDocId: v.documentId, packs: 3 }] },
    now,
  });
  await expectErr(
    O.default.receive({ session: admin, id: order.documentId, body: { lines: [{ itemDocId: g.documentId, packs: 2 }], cost: { sum: 0 } }, now }),
    400,
    'bad_sum'
  );
  assert.equal(s.rows[ITEM].find((i) => i.name === 'Rukavice S').qty, 50, 'затрата не прошла проверку — остаток не тронут');

  const stale = clone(s.rows[ORDER][0]);
  const r = await O.default.receive({
    session: admin,
    id: order.documentId,
    body: { lines: [{ itemDocId: g.documentId, packs: 2 }, { itemDocId: v.documentId, packs: 0 }], cost: { sum: '363', payment: 'card' } },
    now,
  });
  assert.equal(r.order.status, 'sent', 'часть — заказ открыт');
  assert.deepEqual(r.order.lines.map((l) => [l.receivedPacks, l.remainingPacks]), [[2, 2], [0, 3]]);
  assert.equal(s.rows[ITEM].find((i) => i.name === 'Rukavice S').qty, 250);
  const mv = s.rows[MOVE].filter((m) => m.kind === 'in');
  assert.deepEqual(mv.map((m) => [m.itemName, m.delta, m.orderDocId, m.by]), [['Rukavice S', 200, order.documentId, 'Julia']]);
  const req = s.costs.find((c) => c.kind === 'request');
  assert.deepEqual([req.sum, req.noDph, req.category, req.by, req.source], [363, 300, 'Материалы', 'Julia', { kind: 'stock-order', docId: order.documentId }]);
  assert.equal(s.costs.filter((c) => c.kind === 'cost').length, 0, 'затраты нет — только запрос');
  assert.deepEqual(s.rows[ORDER][0].receipts[0].cost, { mode: 'request', status: 'pending', requestDocId: req.id });
  assert.ok(!JSON.stringify(r.order).includes('363'), 'администратор сумму после сохранения не видит');
  assert.equal(s.logs.at(-1).action, 'stock_order_receive');
  assert.match(s.logs.at(-1).summary, /náklad ke schválení/);

  await O.default.uploadFile({ session: admin, id: order.documentId, files: {} });
  assert.deepEqual(s.costs.at(-1), { kind: 'file', costDocId: null, requestDocId: req.id });

  // двойное нажатие по старой версии заказа — 409, остаток тот же
  s.rows[ORDER][0] = { ...s.rows[ORDER][0], version: stale.version };
  const keep = clone(s.rows[ORDER][0]);
  s.rows[ORDER][0].version = 999;
  await assert.rejects(
    (async () => {
      const o = await O.default._find(order.documentId);
      await O.default._write({ ...o, version: keep.version - 1 }, { receipts: [] }, now);
    })(),
    (e) => e.code === 'order_busy'
  );
  s.rows[ORDER][0].version = keep.version;

  // одобрили — приход узнаёт; остаток пришёл «kompletní» — заказ закрыт
  await O.default.onRequestDecided({ orderDocId: order.documentId, requestDocId: req.id, status: 'approved', costDocId: 'costX', now });
  assert.deepEqual(s.rows[ORDER][0].receipts[0].cost, { mode: 'request', status: 'approved', requestDocId: req.id, costDocId: 'costX' });
  const r2 = await O.default.receive({ session: admin, id: order.documentId, body: { lines: [{ itemDocId: v.documentId, packs: 2 }], complete: true }, now });
  assert.equal(r2.order.status, 'received');
  assert.equal(r2.order.needsCost, true, 'второй приход без суммы — «Náklad nezapsán»');
  await expectErr(O.default.receive({ session: admin, id: order.documentId, body: { lines: [{ itemDocId: v.documentId, packs: 1 }] }, now }), 409, 'order_not_open');
  const mgmt = await S.default.attention({ session: manager, now });
  assert.equal(mgmt.orders.needsCost, 1);
  // руководство дописывает затрату к приходу без неё
  await expectErr(O.default.addCost({ session: owner, id: order.documentId, body: { receipt: 0, cost: { sum: 100 } }, now }), 409, 'cost_exists');
  const ac = await O.default.addCost({ session: owner, id: order.documentId, body: { receipt: 1, cost: { sum: 80 } }, now });
  assert.equal(ac.order.needsCost, false);
  assert.equal(ac.order.receipts[1].sum, 80);
  assert.equal(s.costs.filter((c) => c.kind === 'cost').at(-1).author, 'Dima');
});

test('приход руководством: затрата сразу; архивная позиция — 409 до записи; закрыть / отменить', async () => {
  const s = fresh();
  const { g, v, p } = await seedItems();
  const { order } = await O.default.create({ session: owner, body: { supplier: 'Makro', lines: [{ itemDocId: p.documentId, packs: 6 }, { itemDocId: v.documentId, packs: 1 }] }, now });
  // черновик руководство может принять сразу (купили в магазине), администратор — нет
  await expectErr(O.default.receive({ session: admin, id: order.documentId, body: { lines: [{ itemDocId: p.documentId, packs: 1 }] }, now }), 409, 'order_not_open');
  await S.default.update({ session: owner, id: v.documentId, body: { active: false }, now });
  await expectErr(O.default.receive({ session: owner, id: order.documentId, body: { lines: [{ itemDocId: v.documentId, packs: 1 }] }, now }), 409, 'item_archived');
  assert.equal(s.rows[ORDER][0].receipts.length, 0);
  const r = await O.default.receive({ session: manager, id: order.documentId, body: { lines: [{ itemDocId: p.documentId, packs: 6 }], cost: { sum: 242, vat: 21 } }, now });
  assert.equal(r.order.status, 'sent', 'Vata не пришла — заказ ждёт');
  assert.deepEqual(r.order.receipts[0].cost.status, 'recorded');
  assert.equal(s.costs.filter((c) => c.kind === 'cost').length, 1);
  assert.equal(s.rows[ITEM].find((i) => i.name === 'Papír').qty, 7);
  const closed = await O.default.close({ session: manager, id: order.documentId, now });
  assert.equal(closed.order.status, 'received', 'часть пришла — закрыт как принятый');
  assert.equal(s.logs.at(-1).action, 'stock_order_close');
  const { order: o2 } = await O.default.create({ session: owner, body: { supplier: 'X', lines: [{ itemDocId: g.documentId, packs: 1 }] }, now });
  assert.equal((await O.default.close({ session: owner, id: o2.documentId, now })).order.status, 'cancelled');
  await expectErr(O.default.close({ session: owner, id: o2.documentId, now }), 409, 'order_closed');
  await expectErr(O.default.close({ session: admin, id: o2.documentId, now }), 403, 'edit_not_allowed');
});

// ── напоминания ───────────────────────────────────────────────────────────────

test('push: всё выключено без STOCK_PUSH_ENABLED', async () => {
  delete process.env.STOCK_PUSH_ENABLED;
  const s = fresh();
  const { g } = await seedItems();
  await S.default.move({ session: admin, id: g.documentId, body: { kind: 'out', mode: 'empty' }, now });
  await flush();
  assert.deepEqual(await N.default.daily({ now }), { skipped: 'disabled' });
  assert.deepEqual(await N.default.inventoryEscalate({ now }), { skipped: 'disabled' });
  assert.equal(s.pushes.length, 0);
  assert.equal(s.logs.filter((l) => l.action === 'stock_inventory_missed').length, 0);
});

test('push: «došlo» — управляющей сразу (не когда отметила она), сводка 10:00 — только новое и не заказанное', async () => {
  process.env.STOCK_PUSH_ENABLED = 'true';
  try {
    const s = fresh();
    const { g, v, p } = await seedItems();
    await S.default.move({ session: admin, id: g.documentId, body: { kind: 'out', mode: 'empty' }, now });
    await flush();
    assert.deepEqual(s.pushes.map((x) => [x.to, x.title, x.url]), [['manager', '📦 Došlo: Rukavice S', '/stock?tab=order']]);
    assert.equal(s.rows[ITEM].find((i) => i.name === 'Rukavice S').notifiedStatus, 'out');
    await S.default.move({ session: manager, id: v.documentId, body: { kind: 'out', mode: 'empty' }, now });
    await flush();
    assert.equal(s.pushes.length, 1, 'отметила сама управляющая — без push');
    assert.equal(s.rows[ITEM].find((i) => i.name === 'Vata').notifiedStatus, 'out', 'но знает');

    // Papír (málo) — в сводку; Rukavice и Vata уже известны; заказанное — не в сводку
    await O.default.create({ session: manager, body: { supplier: 'Makro', status: 'sent', lines: [{ itemDocId: p.documentId, packs: 2 }] }, now });
    let d = await N.default.daily({ now });
    assert.deepEqual(d, { items: 1, soon: 0, overdue: 0, stale: 0, sent: 1 });
    assert.equal(s.pushes.at(-1).body, 'Dochází: Papír', 'заказано 2 из 6 — ещё не покрыто');
    assert.equal(s.rows[ITEM].find((i) => i.name === 'Papír').notifiedStatus, 'low');
    s.pushes.length = 0;
    d = await N.default.daily({ now });
    assert.equal(s.pushes.length, 0, 'повтор — тишина');

    // вернулась в «Skladem» — отметка снята, следующий раз снова попадёт
    await S.default.move({ session: admin, id: g.documentId, body: { kind: 'in', packs: 5 }, now });
    assert.equal(s.rows[ITEM].find((i) => i.name === 'Rukavice S').notifiedStatus, null);

    // просроченный заказ — управляющей и владельцу; по понедельникам — «давно не считали»
    const later = new Date('2026-10-26T08:00:00Z'); // понедельник, заказ отправлен 13.10
    d = await N.default.daily({ now: later });
    assert.equal(d.overdue, 1);
    assert.equal(d.stale, 0);
    const own = s.pushes.find((x) => x.to === 'owner');
    assert.equal(own.title, '📦 Заказ не пришёл: 1');
    assert.match(own.body, /^Makro · 13 дн\. назад$/);
  } finally {
    delete process.env.STOCK_PUSH_ENABLED;
  }
});

test('инвентура: понедельник — администраторам, 19:00 не сделана — управляющей и запись «Systém»', async () => {
  process.env.STOCK_PUSH_ENABLED = 'true';
  try {
    const s = fresh();
    const { g, v } = await seedItems();
    // посчитаны 13.10 при создании; через неделю (понедельник 19.10) — все три в инвентуре
    const mon = new Date('2026-10-19T08:00:00Z');
    const list = (await S.default.list({ session: admin, now: mon })).items;
    assert.deepEqual(list.filter((i) => i.inventoryDue).map((i) => i.name).sort(), ['Papír', 'Rukavice S', 'Vata']);
    const st = await N.default.inventoryStart({ now: mon });
    assert.equal(st.remaining, 3);
    assert.deepEqual(s.pushes.at(-1).names, ['Julia', 'Vika']);
    assert.equal(s.pushes.at(-1).url, '/stock?tab=inventory');
    assert.match(s.pushes.at(-1).body, /3 položky/);

    // днём посчитали две — «OK jak bylo» тоже считается
    const day = new Date('2026-10-19T12:00:00Z');
    await S.default.move({ session: admin, id: g.documentId, body: { kind: 'count', units: 50 }, now: day });
    await S.default.move({ session: admin, id: v.documentId, body: { kind: 'count', units: 5 }, now: day });
    const eve = new Date('2026-10-19T17:00:00Z');
    const esc = await N.default.inventoryEscalate({ now: eve });
    assert.equal(esc.remaining, 1);
    assert.deepEqual(s.pushes.at(-1), { to: 'manager', kind: 'stock_inventory_missed', title: '🧮 Inventura neprovedena', body: 'Zbývá přepočítat 1 položka.', url: '/stock?tab=inventory', tag: 'stock-inventory-missed' });
    const miss = s.logs.find((l) => l.action === 'stock_inventory_missed');
    assert.equal(miss.actorName, 'Systém');
    assert.equal(miss.entityType, 'stock');
    const att = await S.default.attention({ session: admin, now: eve });
    assert.deepEqual(att.inventory, { monday: '2026-10-19', isMonday: true, remaining: 1 });
  } finally {
    delete process.env.STOCK_PUSH_ENABLED;
  }
});

test('тексты push: запрос на затрату — управляющей по-чешски, владельцу по-русски; сводка ≤ 4 строк', () => {
  const req = { documentId: 'r1', requestedBy: 'Julia', changes: { name: 'Sklad — Nehtyshop', sum: 1210 }, managerApprovedBy: 'Mariia' };
  assert.deepEqual(N.costRequestPayload(req, 'manager'), {
    title: '🧾 Náklad ke schválení',
    body: 'Julia přijal(a) objednávku\nSklad — Nehtyshop · 1 210 Kč',
    url: '/global/expenses',
    tag: 'cost-request-r1',
  });
  assert.equal(N.costRequestPayload(req, 'owner').body, 'Sklad — Nehtyshop · 1 210 Kč\nпринял(а) Julia, одобрила Mariia');
  const many = N.managerDailyPayload({ items: [1, 2, 3, 4, 5].map((i) => ({ name: `P${i}`, status: i === 1 ? 'out' : 'low' })), overdue: [] });
  assert.deepEqual(many.body.split('\n'), ['Došlo: P1', 'Dochází: P2', 'Dochází: P3', '… a další 2']);
  assert.equal(many.title, '📦 Sklad: objednat 5');
  assert.equal(N.managerDailyPayload({}), null);
  // в сводку — только «málo/došlo», о которых управляющая не знает и что ещё не заказано целиком
  const cand = N.summaryCandidates([
    { name: 'A', active: true, status: 'low', notifiedStatus: null, toOrderPacks: 0 },
    { name: 'B', active: true, status: 'low', notifiedStatus: null, toOrderPacks: 2 },
    { name: 'C', active: true, status: 'out', notifiedStatus: 'out', toOrderPacks: 1 },
    { name: 'D', active: true, status: 'out', notifiedStatus: 'low', toOrderPacks: 1 },
    { name: 'E', active: true, status: 'ok', notifiedStatus: null, toOrderPacks: 0 },
  ]);
  assert.deepEqual(cand.map((i) => i.name), ['B', 'D']);
  assert.equal(N.ownerOverduePayload([]), null);
});

test('s261: сводка 10:00 — «Brzy dojde» один раз, не заказанное; отметка soon', () => {
  const items = [
    { documentId: 'a', name: 'Toaletní papír', active: true, status: 'ok', soon: true, daysLeft: 4, notifiedStatus: null, toOrderPacks: 1 },
    { documentId: 'b', name: 'Ubrousky', active: true, status: 'ok', soon: true, daysLeft: 6, notifiedStatus: 'soon', toOrderPacks: 2 },
    { documentId: 'c', name: 'Káva', active: true, status: 'ok', soon: true, daysLeft: 3, notifiedStatus: null, toOrderPacks: 0 },
    { documentId: 'd', name: 'Rukavice S', active: true, status: 'ok', soon: false, daysLeft: 30, notifiedStatus: null, toOrderPacks: 0 },
  ];
  assert.deepEqual(N.soonCandidates(items).map((i) => i.name), ['Toaletní papír'], 'уже сообщили / уже заказано / не скоро — нет');
  assert.equal(N.summaryCandidates(items).length, 0, '«Skladem» в «Došlo/Dochází» не попадает');
  const p = N.managerDailyPayload({ soon: N.soonCandidates(items) });
  assert.equal(p.title, '📦 Sklad: objednat 1');
  assert.equal(p.body, 'Brzy dojde: Toaletní papír (~4 dny)');
  assert.equal(p.url, '/stock?tab=order');
  assert.equal(N.managerDailyPayload({ soon: [] }), null);
});
