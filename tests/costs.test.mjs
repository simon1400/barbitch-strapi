// Затраты из админки (services/costs.ts, s236): проверка формы, ставка DPH,
// автодополнение, журнал и правила одобрения (владелец правит сразу, управляющая —
// запросом). Сервис гоняется НАСТОЯЩИЙ, на заглушке document service в памяти
// (две версии документа затраты — draft/published — как в Strapi 5) и db.query
// для условного перевода запроса из pending.
//
// Запуск: cd strapi && node --test tests/costs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/booking-engine/services/costs.ts'), 'utf8');
const js = ts.transpileModule(SRC, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const C = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const svc = C.default;

const SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/cost/content-types/cost/schema.json'), 'utf8')
);
const REQ_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/cost-request/content-types/cost-request/schema.json'), 'utf8')
);
const CATS = SCHEMA.attributes.category.enum;
const TODAY = '2026-10-05';
const NOW = new Date('2026-10-05T10:00:00Z');

// ── заглушка ────────────────────────────────────────────────────────────────
function makeStrapi(seed = [], { categories = CATS } = {}) {
  let seq = 0;
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 5, 10, 0, ++tick)).toISOString();
  const costs = []; // {documentId, status, ...}
  const reqs = [];
  const logs = [];
  const calls = [];
  for (const c of seed) {
    const base = { createdAt: stamp(), updatedAt: stamp(), author: null, payment: null, comment: null, ...c };
    costs.push({ ...base, status: 'draft' }, { ...base, status: 'published' });
  }
  const project = (r, fields) => {
    const out = { documentId: r.documentId };
    for (const f of fields || Object.keys(r)) if (f in r) out[f] = r[f];
    return out;
  };
  const matchCost = (r, f) => {
    if (!f) return true;
    if (f.date?.$gte && r.date < f.date.$gte) return false;
    if (f.date?.$lte && r.date > f.date.$lte) return false;
    if (f.documentId?.$in && !f.documentId.$in.includes(r.documentId)) return false;
    return true;
  };
  const matchReq = (r, f) => {
    for (const [k, v] of Object.entries(f || {})) {
      if (v && typeof v === 'object' && '$eq' in v) {
        if (r[k] !== v.$eq) return false;
      } else if (r[k] !== v) return false;
    }
    return true;
  };
  const failNext = { publish: null };
  const documents = (uid) => {
    if (uid === C.COST_UID) {
      return {
        findMany: async (q) => {
          calls.push({ op: 'findMany', q });
          assert.equal(q.status, 'published', 'затраты читаются только опубликованные');
          return costs.filter((r) => r.status === 'published' && matchCost(r, q.filters)).map((r) => project(r, q.fields));
        },
        findOne: async (q) => {
          const r = costs.find((x) => x.documentId === q.documentId && x.status === q.status);
          return r ? project(r, q.fields) : null;
        },
        create: async (q) => {
          calls.push({ op: 'create', q });
          const documentId = `cost${String(++seq).padStart(20, '0')}`;
          const t = stamp();
          const base = { documentId, ...q.data, createdAt: t, updatedAt: t };
          costs.push({ ...base, status: 'draft' });
          if (q.status === 'published') costs.push({ ...base, status: 'published' });
          return project(base, q.fields);
        },
        update: async (q) => {
          calls.push({ op: 'update', q });
          assert.equal(q.status, 'draft', 'правка — черновик, затем publish');
          const d = costs.find((x) => x.documentId === q.documentId && x.status === 'draft');
          Object.assign(d, q.data, { updatedAt: stamp() });
          return d;
        },
        publish: async ({ documentId }) => {
          calls.push({ op: 'publish', documentId });
          if (failNext.publish) {
            const e = failNext.publish;
            failNext.publish = null;
            throw e;
          }
          const d = costs.find((x) => x.documentId === documentId && x.status === 'draft');
          const i = costs.findIndex((x) => x.documentId === documentId && x.status === 'published');
          // как Strapi 5: опубликованная строка пересоздаётся из черновика
          costs.splice(i, 1, { ...d, status: 'published', updatedAt: stamp() });
        },
        delete: async ({ documentId }) => {
          calls.push({ op: 'delete', documentId });
          for (let i = costs.length - 1; i >= 0; i--) if (costs[i].documentId === documentId) costs.splice(i, 1);
        },
      };
    }
    if (uid === C.REQUEST_UID) {
      return {
        findMany: async (q) => reqs.filter((r) => matchReq(r, q.filters)).map((r) => ({ ...r })),
        findOne: async ({ documentId }) => {
          const r = reqs.find((x) => x.documentId === documentId);
          return r ? { ...r } : null;
        },
        create: async ({ data }) => {
          const r = { documentId: `req${String(++seq).padStart(21, '0')}`, createdAt: stamp(), ...JSON.parse(JSON.stringify(data)) };
          reqs.push(r);
          return { ...r };
        },
      };
    }
    throw new Error(`unexpected uid ${uid}`);
  };
  globalThis.strapi = {
    documents,
    contentTypes: { [C.COST_UID]: { attributes: { category: { enum: categories } } } },
    db: {
      query: (uid) => {
        assert.equal(uid, C.REQUEST_UID);
        return {
          updateMany: async ({ where, data }) => {
            let count = 0;
            for (const r of reqs) if (matchReq(r, where)) Object.assign(r, data, { updatedAt: stamp() }) && count++;
            return { count };
          },
        };
      },
    },
    service: () => ({ write: async (e) => { logs.push(e); } }),
    log: { error() {}, warn() {}, info() {} },
  };
  return { costs, reqs, logs, calls, failNext, published: (id) => costs.find((x) => x.documentId === id && x.status === 'published') };
}

const OWNER = { id: 1, username: 'Dima', role: 'owner' };
const MANAGER = { id: 2, username: 'Mariia Medvedeva', role: 'manager' };
const MANAGER2 = { id: 5, username: 'Druhá', role: 'manager' };
const flush = () => new Promise((r) => setImmediate(r));
const NAJEM = 'najem000000000000000001';
const SEED = [
  { documentId: NAJEM, date: '2026-09-20', name: 'Najem', category: 'Коммунальные', sum: '17000', noDph: '17000', payment: 'transfer' },
  { documentId: 'ucetni00000000000000001', date: '2026-09-10', name: 'Ucetni', category: 'Услуги', sum: '10285', noDph: '8500', author: 'Dima', payment: 'transfer' },
  { documentId: 'klej0000000000000000001', date: '2026-10-02', name: 'Клей', category: 'Материалы', sum: '2090', noDph: '1727' },
];
const VALID = { date: '2026-10-03', name: ' Makro ', category: 'Материалы', sum: '1 180', noDph: 1000, payment: 'card', comment: '' };

const expectErr = async (fn, status, code) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `status ${e.status} ≠ ${status} (${e.code})`);
    assert.equal(e.code, code);
    return true;
  });
};

// ── чистые функции ──────────────────────────────────────────────────────────
test('схемы: payment/author у затраты, cost-request без draftAndPublish и с enum действий/статусов', () => {
  assert.deepEqual(SCHEMA.attributes.payment.enum, Object.keys(C.PAYMENTS));
  assert.equal(SCHEMA.attributes.author.type, 'string');
  assert.equal(REQ_SCHEMA.options.draftAndPublish, false);
  assert.deepEqual(REQ_SCHEMA.attributes.status.enum, ['pending', 'approved', 'rejected', 'cancelled']);
  assert.ok(REQ_SCHEMA.attributes.action.enum.includes('edit') && REQ_SCHEMA.attributes.action.enum.includes('delete'));
  // REST-роутов у запросов нет — только ручки движка
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '../src/api/cost-request/routes')), false);
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '../src/api/cost-request/controllers')), false);
});

test('normalizeCostInput: валидная форма, белый список полей', () => {
  const r = C.normalizeCostInput({ ...VALID, author: 'hacker', publishedAt: null, id: 1 }, TODAY, CATS);
  assert.deepEqual(r, {
    date: '2026-10-03',
    name: 'Makro',
    category: 'Материалы',
    sum: 1180,
    noDph: 1000,
    payment: 'card',
    comment: null,
  });
});

test('normalizeCostInput: коды ошибок', () => {
  const cases = [
    [{ name: '  ' }, 'name_required'],
    [{ name: 'x'.repeat(121) }, 'name_too_long'],
    [{ category: 'Еда' }, 'bad_category'],
    [{ category: 'constructor' }, 'bad_category'],
    [{ sum: 0 }, 'bad_sum'],
    [{ sum: -5 }, 'bad_sum'],
    [{ sum: '12.5' }, 'bad_sum'],
    [{ sum: 'abc' }, 'bad_sum'],
    [{ sum: '' }, 'bad_sum'],
    [{ sum: 300001, noDph: 1 }, 'sum_too_big'],
    [{ noDph: 1181 }, 'bad_no_dph'],
    [{ noDph: -1 }, 'bad_no_dph'],
    [{ noDph: '' }, 'bad_no_dph'],
    [{ noDph: undefined }, 'bad_no_dph'],
    [{ noDph: 99.5 }, 'bad_no_dph'],
    [{ payment: '' }, 'payment_required'],
    [{ payment: 'bitcoin' }, 'bad_payment'],
    [{ payment: '__proto__' }, 'bad_payment'],
    [{ date: '2026-02-30' }, 'bad_date'],
    [{ date: '03.10.2026' }, 'bad_date'],
    [{ date: '2026-11-20' }, 'date_too_far'],
    [{ comment: 'x'.repeat(501) }, 'text_too_long'],
  ];
  for (const [patch, code] of cases) {
    assert.throws(() => C.normalizeCostInput({ ...VALID, ...patch }, TODAY, CATS), (e) => e.code === code && e.status === 400, `${JSON.stringify(patch)} → ${code}`);
  }
  // граница: ровно +45 дней и 300 000 — можно
  assert.equal(C.normalizeCostInput({ ...VALID, date: '2026-11-19' }, TODAY, CATS).date, '2026-11-19');
  assert.equal(C.normalizeCostInput({ ...VALID, sum: 300000, noDph: 0 }, TODAY, CATS).sum, 300000);
  assert.throws(() => C.normalizeCostInput(null, TODAY, CATS), (e) => e.code === 'name_required');
});

test('normalizeCostChanges: только изменившиеся поля, проверка целой записи', () => {
  const before = C.snapshotOf(SEED[0]);
  const { changes, after } = C.normalizeCostChanges({ sum: 17500, noDph: 17500, name: 'Najem', bogus: 1 }, before, TODAY, CATS);
  assert.deepEqual(changes, { sum: 17500, noDph: 17500 });
  assert.equal(after.name, 'Najem');
  assert.throws(() => C.normalizeCostChanges({ name: ' Najem ' }, before, TODAY, CATS), (e) => e.code === 'no_changes');
  assert.throws(() => C.normalizeCostChanges({}, before, TODAY, CATS), (e) => e.code === 'no_changes');
  // сумма меньше суммы без DPH — целая запись не проходит
  assert.throws(() => C.normalizeCostChanges({ sum: 100 }, before, TODAY, CATS), (e) => e.code === 'bad_no_dph');
  // способ оплаты не стирается
  assert.throws(() => C.normalizeCostChanges({ payment: '' }, before, TODAY, CATS), (e) => e.code === 'payment_required');
  // старая запись без способа оплаты: правка другого поля его не требует
  const old = C.snapshotOf(SEED[2]);
  assert.equal(old.payment, null);
  assert.deepEqual(C.normalizeCostChanges({ comment: 'lepidlo' }, old, TODAY, CATS).changes, { comment: 'lepidlo' });
  // комментарий стирается в null
  const withComment = { ...before, comment: 'x' };
  assert.deepEqual(C.normalizeCostChanges({ comment: '  ' }, withComment, TODAY, CATS).changes, { comment: null });
});

test('vatFromRatio / noDphFor: данные прода', () => {
  assert.equal(C.vatFromRatio(17000, 17000), 0);
  assert.equal(C.vatFromRatio(9680, 8000), 21);
  assert.equal(C.vatFromRatio(10285, 8500), 21);
  assert.equal(C.vatFromRatio(1120, 1000), 12);
  assert.equal(C.vatFromRatio(1180, 1000), 'manual'); // Makro, смешанный чек
  assert.equal(C.vatFromRatio(9800, 8000), 'manual'); // ExpertDev с округлением
  assert.equal(C.vatFromRatio(0, 0), 0);
  // ставка, посчитанная формой, восстанавливается при правке
  for (const sum of [99, 2090, 9680, 17000, 299999]) {
    assert.equal(C.vatFromRatio(sum, C.noDphFor(sum, 21)), 21, `21 % ${sum}`);
    assert.equal(C.vatFromRatio(sum, C.noDphFor(sum, 12)), 12, `12 % ${sum}`);
    assert.equal(C.vatFromRatio(sum, C.noDphFor(sum, 0)), 0);
  }
  assert.equal(C.noDphFor(9680, 21), 8000);
  assert.equal(C.noDphFor(1120, 12), 1000);
  assert.equal(C.noDphFor(500, 0), 500);
});

test('suggestFrom: по названию без регистра, последнее написание, частые сверху', () => {
  const rows = [
    { name: 'Nájem', date: '2026-08-20', category: 'Коммунальные', sum: 12641, noDph: 12641, payment: null },
    { name: 'najem ', date: '2026-09-20', category: 'Коммунальные', sum: 17000, noDph: 17000, payment: null },
    { name: 'Najem', date: '2026-07-20', category: 'Коммунальные', sum: 17000, noDph: 17000, payment: 'transfer' },
    { name: 'Expert dev', date: '2026-09-18', category: 'Маркетинг', sum: 9680, noDph: 8000, payment: 'transfer' },
    { name: '', date: '2026-09-18', category: 'Другое', sum: 1, noDph: 1 },
  ];
  const s = C.suggestFrom(rows);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], {
    name: 'najem',
    category: 'Коммунальные',
    vat: 0,
    payment: 'transfer', // у последних пусто — берётся последний заданный
    lastSum: 17000,
    lastDate: '2026-09-20',
    count: 3,
  });
  assert.equal(s[1].vat, 21);
  assert.equal(C.suggestFrom(rows, 1).length, 1);
  // исходный массив не пересортирован
  assert.equal(rows[0].name, 'Nájem');
});

test('diffSummary / logSummary: строки журнала по-чешски', () => {
  const before = C.snapshotOf(SEED[0]);
  assert.equal(
    C.diffSummary(before, { date: '2026-09-21', sum: 17500, payment: 'card' }),
    'datum: 20.09.2026 → 21.09.2026; suma: 17 000 Kč → 17 500 Kč; platba: převod → karta salonu'
  );
  assert.equal(C.diffSummary({ comment: null }, { comment: 'x' }), 'komentář: — → x');
  assert.equal(C.logSummary('Náklad', before), 'Náklad: Najem 17 000 Kč · 20.09.2026 · Коммунальные · převod');
});

// ── сервис ──────────────────────────────────────────────────────────────────
test('create: опубликованная запись, author = логин сессии, журнал', async () => {
  const st = makeStrapi(SEED);
  const { row } = await svc.create({ session: MANAGER, body: { ...VALID, author: 'Dima', publishedAt: null, id: 7, locale: 'cs' }, now: NOW });
  assert.equal(row.author, 'Mariia Medvedeva');
  assert.equal(row.viaPanel, false);
  assert.equal(row.vat, 'manual');
  assert.equal(row.pendingRequest, null);
  const c = st.calls.find((x) => x.op === 'create');
  assert.equal(c.q.status, 'published');
  // в базу — только поля формы и автор из сессии, лишнее из тела отбрасывается
  assert.deepEqual(Object.keys(c.q.data).sort(), ['author', 'category', 'comment', 'date', 'name', 'noDph', 'payment', 'sum']);
  assert.equal(c.q.data.sum, '1180'); // biginteger — строкой
  assert.equal(c.q.data.noDph, '1000');
  assert.ok(st.published(row.documentId));
  await flush();
  assert.equal(st.logs.length, 1);
  assert.equal(st.logs[0].action, 'cost_create');
  assert.equal(st.logs[0].entityType, 'cost');
  assert.equal(st.logs[0].actorName, 'Mariia Medvedeva');
  assert.equal(st.logs[0].summary, 'Náklad: Makro 1 180 Kč · 03.10.2026 · Материалы · karta salonu');
  await expectErr(() => svc.create({ session: OWNER, body: { ...VALID, payment: '' }, now: NOW }), 400, 'payment_required');
});

test('list: месяц, свежие сверху, категории из схемы, панель без автора', async () => {
  makeStrapi(SEED);
  const r = await svc.list({ session: OWNER, month: '2026-09' });
  assert.equal(r.month, '2026-09');
  assert.deepEqual(r.rows.map((x) => x.documentId), [NAJEM, 'ucetni00000000000000001']);
  assert.equal(r.rows[0].viaPanel, true);
  assert.equal(r.rows[0].author, null);
  assert.equal(r.rows[1].author, 'Dima');
  assert.equal(r.rows[1].vat, 21);
  assert.deepEqual(r.categories, CATS);
  assert.deepEqual(r.payments, ['card', 'cash', 'transfer', 'owner']);
  assert.deepEqual(r.pending, []);
  await expectErr(() => svc.list({ session: OWNER, month: '2026-13' }), 400, 'bad_month');
});

test('правка и удаление: управляющей — 403 approval_required, ничего не меняется', async () => {
  const st = makeStrapi(SEED);
  await expectErr(() => svc.update({ session: MANAGER, id: NAJEM, body: { sum: 1 }, now: NOW }), 403, 'approval_required');
  await expectErr(() => svc.remove({ session: MANAGER, id: NAJEM, now: NOW }), 403, 'approval_required');
  // в том числе собственная запись
  const { row } = await svc.create({ session: MANAGER, body: VALID, now: NOW });
  await expectErr(() => svc.update({ session: MANAGER, id: row.documentId, body: { sum: 1180, noDph: 1180 }, now: NOW }), 403, 'approval_required');
  assert.equal(st.calls.filter((c) => ['update', 'publish', 'delete'].includes(c.op)).length, 0);
});

test('владелец правит сразу: черновик → publish, журнал «было → стало»', async () => {
  const st = makeStrapi(SEED);
  const r = await svc.update({ session: OWNER, id: NAJEM, body: { sum: '17 500', noDph: 17500, date: '2026-10-01' }, now: NOW });
  assert.equal(r.row.sum, 17500);
  assert.equal(r.row.date, '2026-10-01');
  assert.equal(r.before.date, '2026-09-20'); // админке — сбросить кэш старого месяца
  assert.equal(st.published(NAJEM).sum, '17500');
  assert.deepEqual(st.calls.filter((c) => c.op === 'update' || c.op === 'publish').map((c) => c.op), ['update', 'publish']);
  await flush();
  assert.equal(st.logs[0].action, 'cost_update');
  assert.match(st.logs[0].summary, /datum: 20\.09\.2026 → 01\.10\.2026; suma: 17 000 Kč → 17 500 Kč/);
  await expectErr(() => svc.update({ session: OWNER, id: NAJEM, body: { sum: 17500, noDph: 17500 }, now: NOW }), 400, 'no_changes');
  await expectErr(() => svc.update({ session: OWNER, id: 'neexistuje000000000001', body: { sum: 1 }, now: NOW }), 404, 'not_found');
  await expectErr(() => svc.update({ session: OWNER, id: "x' or 1=1", body: { sum: 1 }, now: NOW }), 404, 'not_found');
});

test('владелец удаляет сразу: документ целиком + ожидающий запрос → cancelled', async () => {
  const st = makeStrapi(SEED);
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'delete' }, now: NOW });
  const r = await svc.remove({ session: OWNER, id: NAJEM, now: NOW });
  assert.equal(r.deleted, NAJEM);
  assert.equal(r.row.date, '2026-09-20');
  assert.equal(st.costs.filter((c) => c.documentId === NAJEM).length, 0, 'и черновик, и публикация');
  const q = st.reqs.find((x) => x.documentId === request.id);
  assert.equal(q.status, 'cancelled');
  assert.equal(q.decisionNote, 'затрата удалена');
  await flush();
  assert.deepEqual(st.logs.map((l) => l.action), ['cost_request', 'cost_delete']);
});

test('запрос управляющей → одобрение владельцем применяет правку', async () => {
  const st = makeStrapi(SEED);
  const { request, row } = await svc.request({
    session: MANAGER,
    id: NAJEM,
    body: { action: 'edit', changes: { sum: 16500, noDph: 16500, name: 'Najem', publishedAt: null } },
    now: NOW,
  });
  assert.equal(request.status, 'pending');
  assert.deepEqual(request.changes, { sum: 16500, noDph: 16500 }); // только разница, белый список
  assert.equal(request.before.sum, 17000);
  assert.equal(row.pendingRequest.action, 'edit');
  assert.equal(st.published(NAJEM).sum, '17000', 'до одобрения деньги старые');

  // второй запрос по той же затрате — 409
  await expectErr(() => svc.request({ session: MANAGER, id: NAJEM, body: { action: 'delete' }, now: NOW }), 409, 'request_pending');
  // владельцу запрос не нужен
  await expectErr(() => svc.request({ session: OWNER, id: NAJEM, body: { action: 'delete' }, now: NOW }), 400, 'owner_direct');
  await expectErr(() => svc.request({ session: MANAGER, id: 'ucetni00000000000000001', body: { action: 'file_delete' }, now: NOW }), 400, 'bad_action');
  await expectErr(() => svc.request({ session: MANAGER, id: 'ucetni00000000000000001', body: { action: 'edit', changes: {} }, now: NOW }), 400, 'no_changes');

  // список: строка помечена, владелец видит запрос, другая управляющая — нет
  const lo = await svc.list({ session: OWNER, month: '2026-10' });
  assert.equal(lo.pending.length, 1);
  assert.equal(lo.pending[0].cost.documentId, NAJEM, 'затрата из другого месяца подтянута');
  assert.equal((await svc.list({ session: MANAGER, month: '2026-09' })).pending.length, 1);
  assert.equal((await svc.list({ session: MANAGER2, month: '2026-09' })).pending.length, 0);
  assert.equal((await svc.list({ session: MANAGER2, month: '2026-09' })).rows[0].pendingRequest.requestedBy, 'Mariia Medvedeva');

  const a = await svc.approve({ session: OWNER, rid: request.id, now: NOW });
  assert.equal(a.row.sum, 16500);
  assert.equal(a.request.status, 'approved');
  assert.equal(a.before.sum, 17000);
  assert.equal(st.published(NAJEM).sum, '16500');
  assert.equal(st.reqs[0].status, 'approved');
  assert.equal(st.reqs[0].decidedBy, 'Dima');
  // повторно — уже решён
  await expectErr(() => svc.approve({ session: OWNER, rid: request.id, now: NOW }), 409, 'request_closed');
  await flush();
  assert.deepEqual(st.logs.map((l) => l.action), ['cost_request', 'cost_approve']);
  assert.match(st.logs[1].summary, /suma: 17 000 Kč → 16 500 Kč/);
});

test('одобрение: запись изменили после запроса → 409 cost_changed, запрос ждёт', async () => {
  const st = makeStrapi(SEED);
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'edit', changes: { name: 'Nájem' } }, now: NOW });
  await svc.update({ session: OWNER, id: NAJEM, body: { comment: 'za září' }, now: NOW });
  await assert.rejects(
    () => svc.approve({ session: OWNER, rid: request.id, now: NOW }),
    (e) => e.status === 409 && e.code === 'cost_changed' && e.details.cost.comment === 'za září'
  );
  assert.equal(st.reqs[0].status, 'pending');
  assert.equal(st.published(NAJEM).name, 'Najem');
  // отклонить всё ещё можно
  const r = await svc.reject({ session: OWNER, rid: request.id, body: { note: '  už opraveno  ' }, now: NOW });
  assert.equal(r.request.status, 'rejected');
  assert.equal(st.reqs[0].decisionNote, 'už opraveno');
});

test('одобрение перепроверяет правку и откатывает статус, если запись не легла', async () => {
  const st = makeStrapi(SEED);
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'edit', changes: { category: 'Услуги' } }, now: NOW });
  // владелец убрал категорию из enum, пока запрос ждал
  globalThis.strapi.contentTypes[C.COST_UID].attributes.category.enum = CATS.filter((c) => c !== 'Услуги');
  await expectErr(() => svc.approve({ session: OWNER, rid: request.id, now: NOW }), 400, 'bad_category');
  assert.equal(st.reqs[0].status, 'pending');
  globalThis.strapi.contentTypes[C.COST_UID].attributes.category.enum = CATS;
  // публикация упала — запрос снова pending, решатель стёрт
  st.failNext.publish = new Error('db down');
  await assert.rejects(() => svc.approve({ session: OWNER, rid: request.id, now: NOW }), /db down/);
  assert.equal(st.reqs[0].status, 'pending');
  assert.equal(st.reqs[0].decidedBy, null);
  const ok = await svc.approve({ session: OWNER, rid: request.id, now: NOW });
  assert.equal(ok.row.category, 'Услуги');
});

test('одобрение удаления: затрата удалена; затрата уже удалена → 404, запрос закрыт', async () => {
  const st = makeStrapi(SEED);
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'delete' }, now: NOW });
  const a = await svc.approve({ session: OWNER, rid: request.id, now: NOW });
  assert.equal(a.deleted, NAJEM);
  assert.equal(a.row, null);
  assert.equal(st.costs.filter((c) => c.documentId === NAJEM).length, 0);
  assert.equal(st.reqs[0].status, 'approved', 'одобренный запрос не превращается в cancelled');

  const r2 = await svc.request({ session: MANAGER, id: 'ucetni00000000000000001', body: { action: 'delete' }, now: NOW });
  // запись стёрли в панели мимо движка
  st.costs.splice(0, st.costs.length, ...st.costs.filter((c) => c.documentId !== 'ucetni00000000000000001'));
  await expectErr(() => svc.approve({ session: OWNER, rid: r2.request.id, now: NOW }), 404, 'not_found');
  assert.equal(st.reqs[1].status, 'cancelled');
});

test('отзыв: только автор и только pending; одобрить и отклонить — только владелец', async () => {
  const st = makeStrapi(SEED);
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'delete' }, now: NOW });
  await expectErr(() => svc.cancelRequest({ session: MANAGER2, rid: request.id, now: NOW }), 403, 'not_your_request');
  await expectErr(() => svc.cancelRequest({ session: OWNER, rid: request.id, now: NOW }), 403, 'not_your_request');
  await expectErr(() => svc.approve({ session: MANAGER, rid: request.id, now: NOW }), 403, 'owner_only');
  await expectErr(() => svc.reject({ session: MANAGER, rid: request.id, body: {}, now: NOW }), 403, 'owner_only');
  const c = await svc.cancelRequest({ session: MANAGER, rid: request.id, now: NOW });
  assert.equal(c.request.status, 'cancelled');
  await expectErr(() => svc.cancelRequest({ session: MANAGER, rid: request.id, now: NOW }), 409, 'request_closed');
  await expectErr(() => svc.approve({ session: OWNER, rid: request.id, now: NOW }), 409, 'request_closed');
  await expectErr(() => svc.reject({ session: OWNER, rid: request.id, body: {}, now: NOW }), 409, 'request_closed');
  await expectErr(() => svc.approve({ session: OWNER, rid: 'nic000000000000000000000', now: NOW }), 404, 'request_not_found');
  await expectErr(() => svc.reject({ session: OWNER, rid: request.id, body: { note: 'x'.repeat(501) }, now: NOW }), 400, 'text_too_long');
  assert.equal(st.published(NAJEM).sum, '17000');
  // после отзыва можно подать новый
  const again = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'delete' }, now: NOW });
  assert.equal(again.request.status, 'pending');
  await flush();
  assert.deepEqual(st.logs.map((l) => l.action), ['cost_request', 'cost_cancel', 'cost_request']);
});

test('гонка: отозвали между проверкой и решением — условный UPDATE не даёт применить', async () => {
  const st = makeStrapi(SEED);
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'delete' }, now: NOW });
  // запрос прочитан как pending, но к моменту UPDATE уже отозван
  const orig = svc._findRequest;
  svc._findRequest = async (rid) => {
    const r = await orig.call(svc, rid);
    st.reqs[0].status = 'cancelled';
    return r;
  };
  try {
    await expectErr(() => svc.approve({ session: OWNER, rid: request.id, now: NOW }), 409, 'request_closed');
  } finally {
    svc._findRequest = orig;
  }
  assert.ok(st.published(NAJEM), 'затрата не удалена');
});

test('suggest: записи за год, частые сверху', async () => {
  makeStrapi([
    ...SEED,
    { documentId: 'najem000000000000000002', date: '2026-08-20', name: 'Najem', category: 'Коммунальные', sum: '12641', noDph: '12641' },
    { documentId: 'stary00000000000000001', date: '2025-09-01', name: 'Stará', category: 'Другое', sum: '5', noDph: '5' },
  ]);
  const { items } = await svc.suggest({ now: NOW });
  assert.equal(items[0].name, 'Najem');
  assert.equal(items[0].count, 2);
  assert.equal(items[0].lastSum, 17000);
  assert.ok(!items.some((i) => i.name === 'Stará'), 'старше года не берётся');
});
