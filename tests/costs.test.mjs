// Затраты из админки (services/costs.ts, s236): проверка формы, ставка DPH,
// автодополнение, журнал и правила одобрения (владелец правит сразу, управляющая —
// запросом). Сервис гоняется НАСТОЯЩИЙ, на заглушке document service в памяти
// (две версии документа затраты — draft/published — как в Strapi 5) и db.query
// для условного перевода запроса из pending.
//
// Фаза 2 (s237): чеки в закрытом каталоге (настоящая запись на диск во временный
// каталог), «повторить с прошлого месяца», пачка всё-или-ничего, «Сегодня».
//
// Запуск: cd strapi && node --test tests/costs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const toJs = (file) =>
  ts.transpileModule(fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const PF_FROM = "from '../../../utils/private-files'";
const js = toJs('src/api/booking-engine/services/costs.ts');
assert.ok(js.includes(PF_FROM), 'импорт private-files не найден');
const C = await import(dataUrl(js.split(PF_FROM).join(`from '${dataUrl(toJs('src/utils/private-files.ts'))}'`)));
const svc = C.default;

const SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/cost/content-types/cost/schema.json'), 'utf8')
);
const FILE_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/cost-file/content-types/cost-file/schema.json'), 'utf8')
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
  const files = [];
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
    if (uid === C.FILE_UID) {
      const matchFile = (r, f) =>
        Object.entries(f || {}).every(([k, v]) => ('$in' in v ? v.$in.includes(r[k]) : r[k] === v.$eq));
      return {
        findMany: async (q) => files.filter((r) => matchFile(r, q.filters)).map((r) => project(r, q.fields)),
        create: async ({ data }) => {
          const r = { documentId: `file${String(++seq).padStart(20, '0')}`, createdAt: stamp(), ...data };
          files.push(r);
          return { ...r };
        },
        delete: async ({ documentId }) => {
          const i = files.findIndex((x) => x.documentId === documentId);
          if (i >= 0) files.splice(i, 1);
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
  return { costs, reqs, files, logs, calls, failNext, published: (id) => costs.find((x) => x.documentId === id && x.status === 'published') };
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
  await expectErr(() => svc.request({ session: MANAGER, id: 'ucetni00000000000000001', body: { action: 'move' }, now: NOW }), 400, 'bad_action');
  // s237: file_delete — действие Фазы 2, без чека этой затраты — 404
  await expectErr(() => svc.request({ session: MANAGER, id: 'ucetni00000000000000001', body: { action: 'file_delete' }, now: NOW }), 404, 'file_not_found');
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

// ── Фаза 2 (s237) ─────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-test-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let tmpSeq = 0;
const upload = (bytes, name) => {
  const filepath = path.join(tmpRoot, `upload-${++tmpSeq}`);
  fs.writeFileSync(filepath, bytes);
  return { files: { filepath, originalFilename: name, mimetype: 'application/octet-stream', size: bytes.length } };
};
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const useDir = (name) => {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { mode: 0o755 }); // как созданный руками на сервере
  process.env.COST_FILES_DIR = dir;
  return dir;
};
const readAll = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

test('cost-file: без draftAndPublish, storedName private, без REST', () => {
  assert.equal(FILE_SCHEMA.options.draftAndPublish, false);
  assert.equal(FILE_SCHEMA.attributes.storedName.private, true);
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '../src/api/cost-file/routes')), false);
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '../src/api/cost-file/controllers')), false);
  assert.ok(REQ_SCHEMA.attributes.action.enum.includes('file_delete'));
});

test('чек: закрытый каталог 700/600, в списке — без storedName, выдача потоком, удаление владельцем', async () => {
  const st = makeStrapi(SEED);
  const dir = useDir('store1');
  const { file } = await svc.uploadFile({ session: MANAGER, id: NAJEM, files: upload(PDF, '../../účtenka "září".pdf') });
  assert.equal(file.fileName, 'účtenka září.pdf');
  assert.equal(file.mime, 'application/pdf');
  assert.equal(file.uploadedBy, 'Mariia Medvedeva');
  assert.ok(!('storedName' in file));
  const rec = st.files[0];
  assert.match(rec.storedName, /^[a-f0-9]{32}$/);
  const onDisk = path.join(dir, rec.storedName);
  assert.ok(fs.readFileSync(onDisk).equals(PDF));
  assert.equal(fs.statSync(onDisk).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), [rec.storedName], 'без хвостов .part');
  assert.equal(st.logs.at(-1).action, 'cost_file_add');
  assert.match(st.logs.at(-1).summary, /^Doklad přidán: Najem 17 000 Kč .* — účtenka září\.pdf$/);

  const month = await svc.list({ session: OWNER, month: '2026-09' });
  const row = month.rows.find((r) => r.documentId === NAJEM);
  assert.equal(row.files.length, 1);
  assert.equal(row.files[0].id, rec.documentId);
  assert.ok(!JSON.stringify(month).includes(rec.storedName), 'имя на диске наружу не отдаётся');
  assert.equal(month.rows.find((r) => r.documentId !== NAJEM).files.length, 0);

  const dl = await svc.downloadFile({ id: NAJEM, fid: rec.documentId });
  assert.ok((await readAll(dl.stream)).equals(PDF));
  assert.equal(dl.mime, 'application/pdf');
  assert.match(dl.disposition, /^inline; filename="__tenka z___\.pdf"; filename\*=UTF-8''%C3%BA%C4%8Dtenka/);
  // чек чужой затраты по её id — 404
  await expectErr(() => svc.downloadFile({ id: 'ucetni00000000000000001', fid: rec.documentId }), 404, 'file_not_found');
  await expectErr(() => svc.downloadFile({ id: NAJEM, fid: '../etc' }), 404, 'file_not_found');

  await expectErr(() => svc.deleteFile({ session: MANAGER, id: NAJEM, fid: rec.documentId }), 403, 'approval_required');
  assert.ok(fs.existsSync(onDisk));
  await svc.deleteFile({ session: OWNER, id: NAJEM, fid: rec.documentId });
  assert.equal(st.files.length, 0);
  assert.ok(!fs.existsSync(onDisk), 'файл удалён с диска');
  assert.equal(st.logs.at(-1).action, 'cost_file_delete');
});

test('чек: сигнатура, размер, один файл, не больше 5, хранилище не настроено, затраты нет', async () => {
  const st = makeStrapi(SEED);
  useDir('store2');
  const exe = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(50)]);
  await expectErr(() => svc.uploadFile({ session: OWNER, id: NAJEM, files: upload(exe, 'a.pdf') }), 400, 'bad_file_type');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: NAJEM, files: upload(Buffer.from('<svg xmlns='), 'a.jpg') }), 400, 'bad_file_type');
  const big = upload(PDF, 'big.pdf');
  big.files.size = 10 * 1024 * 1024 + 1;
  await expectErr(() => svc.uploadFile({ session: OWNER, id: NAJEM, files: big }), 413, 'file_too_big');
  const two = upload(PDF, 'a.pdf');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: NAJEM, files: { files: [two.files, two.files] } }), 400, 'file_required');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: NAJEM, files: {} }), 400, 'file_required');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: 'nenalezeno00000000001', files: upload(PDF, 'a.pdf') }), 404, 'not_found');
  for (let i = 0; i < C.MAX_FILES_PER_COST; i++) await svc.uploadFile({ session: OWNER, id: NAJEM, files: upload(JPG, `f${i}.jpg`) });
  await expectErr(() => svc.uploadFile({ session: OWNER, id: NAJEM, files: upload(JPG, 'x.jpg') }), 409, 'too_many_files');
  assert.equal(st.files.length, C.MAX_FILES_PER_COST);
  for (const env of ['', 'relative/dir']) {
    process.env.COST_FILES_DIR = env;
    await expectErr(() => svc.uploadFile({ session: OWNER, id: 'ucetni00000000000000001', files: upload(PDF, 'a.pdf') }), 503, 'storage_not_configured');
  }
});

test('удаление затраты (сразу и по одобрению) удаляет её чеки с диска', async () => {
  const st = makeStrapi(SEED);
  const dir = useDir('store3');
  await svc.uploadFile({ session: OWNER, id: NAJEM, files: upload(PDF, 'a.pdf') });
  await svc.uploadFile({ session: OWNER, id: 'ucetni00000000000000001', files: upload(JPG, 'b.jpg') });
  assert.equal(fs.readdirSync(dir).length, 2);
  await svc.remove({ session: OWNER, id: NAJEM, now: NOW });
  assert.deepEqual(st.files.map((f) => f.costDocId), ['ucetni00000000000000001']);
  assert.deepEqual(fs.readdirSync(dir), [st.files[0].storedName]);

  const { request } = await svc.request({ session: MANAGER, id: 'ucetni00000000000000001', body: { action: 'delete' }, now: NOW });
  await svc.approve({ session: OWNER, rid: request.id, now: NOW });
  assert.equal(st.files.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('запрос file_delete: чек этой затраты, одобрение удаляет только чек (затрату правили — не мешает)', async () => {
  const st = makeStrapi(SEED);
  const dir = useDir('store4');
  const { file } = await svc.uploadFile({ session: MANAGER, id: NAJEM, files: upload(PDF, 'a.pdf') });
  await expectErr(() => svc.request({ session: MANAGER, id: NAJEM, body: { action: 'file_delete', fileId: 'cizi0000000000000000001' }, now: NOW }), 404, 'file_not_found');
  await expectErr(() => svc.request({ session: MANAGER, id: NAJEM, body: { action: 'file_delete' }, now: NOW }), 404, 'file_not_found');
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'file_delete', fileId: file.id }, now: NOW });
  assert.equal(request.action, 'file_delete');
  assert.equal(request.fileId, file.id);
  assert.equal(st.logs.at(-1).action, 'cost_request');
  assert.match(st.logs.at(-1).summary, /^Žádost o smazání dokladu: Najem .* — doklad a\.pdf$/);
  const month = await svc.list({ session: MANAGER, month: '2026-09' });
  assert.deepEqual(month.rows.find((r) => r.documentId === NAJEM).pendingRequest, {
    id: request.id,
    action: 'file_delete',
    fileId: file.id,
    requestedBy: 'Mariia Medvedeva',
  });
  // владелец успел поправить сумму — удалению чека это не мешает
  await svc.update({ session: OWNER, id: NAJEM, body: { sum: 16500, noDph: 16500 }, now: NOW });
  const res = await svc.approve({ session: OWNER, rid: request.id, now: NOW });
  assert.equal(res.deletedFile, file.id);
  assert.equal(res.deleted, null);
  assert.equal(st.files.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(st.published(NAJEM), 'затрата на месте');
  assert.equal(st.published(NAJEM).sum, '16500');
  assert.equal(st.reqs[0].status, 'approved');
  assert.match(st.logs.at(-1).summary, /Žádost schválena: .* — smazání dokladu a\.pdf$/);
});

test('file_delete: чек уже удалён владельцем → 404, запрос закрыт; отклонение и отзыв — по журналу', async () => {
  const st = makeStrapi(SEED);
  useDir('store5');
  const { file } = await svc.uploadFile({ session: MANAGER, id: NAJEM, files: upload(PDF, 'a.pdf') });
  const { request } = await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'file_delete', fileId: file.id }, now: NOW });
  await svc.deleteFile({ session: OWNER, id: NAJEM, fid: file.id });
  await expectErr(() => svc.approve({ session: OWNER, rid: request.id, now: NOW }), 404, 'file_not_found');
  assert.equal(st.reqs[0].status, 'cancelled');

  const f2 = (await svc.uploadFile({ session: MANAGER, id: NAJEM, files: upload(PDF, 'b.pdf') })).file;
  const r2 = (await svc.request({ session: MANAGER, id: NAJEM, body: { action: 'file_delete', fileId: f2.id }, now: NOW })).request;
  await svc.reject({ session: OWNER, rid: r2.id, body: { note: 'чек нужен účetní' }, now: NOW });
  assert.match(st.logs.at(-1).summary, /— smazání dokladu · чек нужен účetní$/);
  assert.equal(st.files.length, 1, 'чек остался');
});

const HISTORY = [
  // июль–сентябрь: Najem каждый месяц (20/21/20), Ucetni 08 и 09, Google ADS 07 и 08 (в 09 — «Google and Meta»),
  // Noona 07 и 08 (после ухода с Noona нет), Telefon только 09, Expert dev 08 и 09
  ...[['07', '21'], ['08', '20'], ['09', '20']].map(([m, d], i) => ({ documentId: `najem${i}000000000000000001`, date: `2026-${m}-${d}`, name: i === 1 ? 'Nájem' : 'Najem', category: 'Коммунальные', sum: '17000', noDph: '17000', payment: 'transfer' })),
  { documentId: 'ucet08000000000000000001', date: '2026-08-08', name: 'Ucetni', category: 'Услуги', sum: '9000', noDph: '7438', payment: 'transfer' },
  { documentId: 'ucet09000000000000000001', date: '2026-09-12', name: 'Ucetni', category: 'Услуги', sum: '10285', noDph: '8500', payment: 'transfer' },
  { documentId: 'goog07000000000000000001', date: '2026-07-01', name: 'Google ADS', category: 'Маркетинг', sum: '10500', noDph: '10500' },
  { documentId: 'goog08000000000000000001', date: '2026-08-01', name: 'Google ADS', category: 'Маркетинг', sum: '10500', noDph: '10500' },
  { documentId: 'gome09000000000000000001', date: '2026-09-01', name: 'Google and Meta', category: 'Маркетинг', sum: '16500', noDph: '16500', payment: 'card' },
  { documentId: 'noon07000000000000000001', date: '2026-07-01', name: 'Noona', category: 'Услуги', sum: '1200', noDph: '1200' },
  { documentId: 'noon08000000000000000001', date: '2026-08-01', name: 'Noona', category: 'Услуги', sum: '1700', noDph: '1700' },
  { documentId: 'tele09000000000000000001', date: '2026-09-30', name: 'Telefon', category: 'Коммунальные', sum: '200', noDph: '200' },
  { documentId: 'expe08000000000000000001', date: '2026-08-18', name: 'Expert dev', category: 'Маркетинг', sum: '9680', noDph: '8000', payment: 'transfer' },
  { documentId: 'expe09000000000000000001', date: '2026-09-17', name: 'Expert dev', category: 'Маркетинг', sum: '9680', noDph: '8000', payment: 'transfer' },
  { documentId: 'star06000000000000000001', date: '2026-06-20', name: 'Najem', category: 'Коммунальные', sum: '17000', noDph: '17000' },
];

test('prevMonths / dayInMonth / recurringStats: «был в прошлом месяце и ≥ 2 из 3»', () => {
  assert.deepEqual(C.prevMonths('2026-01', 3), ['2025-12', '2025-11', '2025-10']);
  assert.equal(C.dayInMonth('2026-02', 31), '2026-02-28');
  assert.equal(C.dayInMonth('2028-02', 30), '2028-02-29');
  const rows = HISTORY.map((d) => C.toRow(d));
  const st = C.recurringStats(rows, '2026-10');
  assert.deepEqual([...st.keys()].sort(), ['expert dev', 'najem', 'ucetni']);
  assert.equal(st.get('najem').usualDay, 20);
  assert.equal(st.get('najem').months, 3, 'июнь в окно не входит');
  assert.equal(st.get('ucetni').usualDay, 8, 'медиана двух — меньший');
});

test('repeatCandidates: прошлый месяц без уже внесённых, тот же день, постоянные отмечены', () => {
  const rows = [...HISTORY, { documentId: 'najemX0000000000000001', date: '2026-10-01', name: 'NÁJEM ', category: 'Коммунальные', sum: '17000', noDph: '17000' }].map((d) => C.toRow(d));
  const items = C.repeatCandidates(rows, '2026-10');
  assert.deepEqual(items.map((i) => i.name), ['Google and Meta', 'Ucetni', 'Expert dev', 'Telefon']);
  const ucet = items.find((i) => i.name === 'Ucetni');
  assert.deepEqual(
    { date: ucet.date, sum: ucet.sum, noDph: ucet.noDph, vat: ucet.vat, payment: ucet.payment, recurring: ucet.recurring, sourceId: ucet.sourceId },
    { date: '2026-10-12', sum: 10285, noDph: 8500, vat: 21, payment: 'transfer', recurring: true, sourceId: 'ucet09000000000000000001' }
  );
  assert.equal(items.find((i) => i.name === 'Google and Meta').recurring, false);
  assert.equal(items.find((i) => i.name === 'Telefon').date, '2026-10-30');
  // ноябрь: 30-е → 30-е; февраль: 30-е → 28-е
  assert.equal(C.repeatCandidates(HISTORY.map((d) => C.toRow({ ...d, date: d.date.replace('2026-09', '2027-01') })), '2027-02').find((i) => i.name === 'Telefon').date, '2027-02-28');
});

test('missingRecurring: через 3 дня после обычного дня, не позже конца месяца; внесённая — нет', () => {
  const rows = HISTORY.map((d) => C.toRow(d));
  assert.deepEqual(C.missingRecurring(rows, '2026-10-10').map((m) => m.name), []);
  assert.deepEqual(C.missingRecurring(rows, '2026-10-11').map((m) => m.name), ['Ucetni']);
  const m = C.missingRecurring(rows, '2026-10-23');
  assert.deepEqual(m.map((x) => x.name), ['Ucetni', 'Expert dev', 'Najem']);
  assert.deepEqual(m[2], { name: 'Najem', category: 'Коммунальные', usualDay: 20, lastSum: 17000, lastDate: '2026-09-20' });
  const withOct = [...rows, C.toRow({ documentId: 'x', date: '2026-10-09', name: 'účetní', category: 'Услуги', sum: '10285', noDph: '8500' })];
  assert.deepEqual(C.missingRecurring(withOct, '2026-10-23').map((x) => x.name), ['Expert dev', 'Najem']);
  // обычный день 30 в феврале: показывается в последний день месяца
  const feb = [
    { date: '2027-01-30', name: 'Pozdní' },
    { date: '2026-12-30', name: 'Pozdní' },
  ].map((d, i) => C.toRow({ documentId: `p${i}`, category: 'Другое', sum: '1', noDph: '1', ...d }));
  assert.deepEqual(C.missingRecurring(feb, '2027-02-27'), []);
  assert.equal(C.missingRecurring(feb, '2027-02-28').length, 1);
});

test('normalizeBatch: 1…30, каждая — как новая затрата, ошибка с номером строки', () => {
  assert.throws(() => C.normalizeBatch({ items: [] }, TODAY, CATS), (e) => e.code === 'batch_empty');
  assert.throws(() => C.normalizeBatch({}, TODAY, CATS), (e) => e.code === 'batch_empty');
  assert.throws(() => C.normalizeBatch({ items: Array(31).fill(VALID) }, TODAY, CATS), (e) => e.code === 'batch_too_big');
  assert.throws(
    () => C.normalizeBatch({ items: [VALID, { ...VALID, payment: '' }] }, TODAY, CATS),
    (e) => e.code === 'payment_required' && e.message.startsWith('Строка 2:') && e.details.index === 1
  );
  assert.equal(C.normalizeBatch({ items: [VALID, VALID] }, TODAY, CATS).length, 2);
});

test('recurring + batch: всё или ничего, автор и журнал у каждой; сбой посередине — созданные удалены', async () => {
  const st = makeStrapi(HISTORY);
  const { month, items } = await svc.recurring({ month: '2026-10' });
  assert.equal(month, '2026-10');
  assert.ok(items.some((i) => i.name === 'Najem' && i.recurring));
  await expectErr(() => svc.recurring({ month: '2026-13' }), 400, 'bad_month');

  const pick = items.filter((i) => i.recurring).map((i) => ({ ...i, payment: i.payment || 'transfer', comment: '' }));
  // ошибка во второй строке — ничего не записано
  const before = st.costs.length;
  await expectErr(() => svc.batch({ session: MANAGER, body: { items: [pick[0], { ...pick[1], sum: 0 }] }, now: NOW }), 400, 'bad_sum');
  assert.equal(st.costs.length, before);

  const { rows } = await svc.batch({ session: MANAGER, body: { items: pick }, now: NOW });
  assert.equal(rows.length, pick.length);
  assert.ok(rows.every((r) => r.author === 'Mariia Medvedeva' && r.date.startsWith('2026-10')));
  assert.equal(st.logs.filter((l) => l.action === 'cost_create').length, pick.length);
  assert.match(st.logs.at(-1).summary, /^Náklad \(opakování\): /);
  assert.deepEqual((await svc.recurring({ month: '2026-10' })).items.filter((i) => i.recurring), [], 'внесённые больше не предлагаются');

  // сбой записи на третьей — первые две удаляются
  const st2 = makeStrapi(HISTORY);
  const real = globalThis.strapi.documents;
  let n = 0;
  globalThis.strapi.documents = (uid) => {
    const d = real(uid);
    if (uid !== C.COST_UID) return d;
    return { ...d, create: async (q) => (++n === 3 ? Promise.reject(new Error('db down')) : d.create(q)) };
  };
  await assert.rejects(() => svc.batch({ session: OWNER, body: { items: pick }, now: NOW }), /db down/);
  assert.equal(st2.costs.filter((c) => c.date?.startsWith('2026-10')).length, 0, 'откат пачки');
  assert.equal(st2.logs.length, 0, 'журнал не пишется');
});

test('attention: владельцу — число запросов, управляющей — null; постоянные не внесены', async () => {
  makeStrapi(HISTORY);
  const NOW23 = new Date('2026-10-23T08:00:00Z');
  const req = await svc.request({ session: MANAGER, id: 'najem2000000000000000001', body: { action: 'delete' }, now: NOW23 });
  assert.ok(req.request.id);
  const o = await svc.attention({ session: OWNER, now: NOW23 });
  assert.equal(o.today, '2026-10-23');
  assert.equal(o.pending, 1);
  assert.deepEqual(o.missingRecurring.map((m) => m.name), ['Ucetni', 'Expert dev', 'Najem']);
  const m = await svc.attention({ session: MANAGER, now: NOW23 });
  assert.equal(m.pending, null);
  assert.equal(await svc.pendingCount(), 1);
});
