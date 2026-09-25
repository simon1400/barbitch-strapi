// Корректировки зарплат из админки (services/corrections.ts, s215): проверка
// формы, строки списка, журнал и то, что записи движка (source) не удаляются.
// Сервис гоняется НАСТОЯЩИЙ, на заглушке document service в памяти
// (две версии документа — draft/published — как в Strapi 5).
//
// Запуск: cd strapi && node --test tests/corrections.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/booking-engine/services/corrections.ts'), 'utf8');
const js = ts.transpileModule(SRC, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const C = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const svc = C.default;

// ── заглушка document service ─────────────────────────────────────────────
function makeStrapi(seed = []) {
  let seq = 0;
  const rows = seed.map((r) => ({ ...r })); // {uid, documentId, status, date, sum, comment|title, source, personal}
  const logs = [];
  const calls = [];
  const personals = {
    per1aaaaaaaaaaaaaaaaaaaa: { documentId: 'per1aaaaaaaaaaaaaaaaaaaa', name: 'Yana Ivanova' },
    per2bbbbbbbbbbbbbbbbbbbb: { documentId: 'per2bbbbbbbbbbbbbbbbbbbb', name: 'Mariia Medvedeva' },
  };
  const match = (r, filters) => {
    if (!filters) return true;
    if (filters.date && (r.date < filters.date.$gte || r.date > filters.date.$lte)) return false;
    if (filters.personal && r.personal?.documentId !== filters.personal.documentId.$eq) return false;
    return true;
  };
  const project = (r, fields) => {
    const out = { documentId: r.documentId, personal: r.personal ? { ...r.personal } : null };
    for (const f of fields || []) if (f in r) out[f] = r[f];
    return out;
  };
  const documents = (uid) => {
    if (uid === 'api::personal.personal') {
      return { findOne: async ({ documentId }) => personals[documentId] || null };
    }
    return {
      findMany: async (q) => {
        calls.push({ uid, op: 'findMany', q });
        return rows.filter((r) => r.uid === uid && r.status === q.status && match(r, q.filters)).map((r) => project(r, q.fields));
      },
      findOne: async (q) => {
        const r = rows.find((x) => x.uid === uid && x.documentId === q.documentId && x.status === q.status);
        return r ? project(r, q.fields) : null;
      },
      create: async (q) => {
        calls.push({ uid, op: 'create', q });
        const documentId = `new${String(++seq).padStart(21, '0')}`;
        const personal = personals[q.data.personal.documentId];
        const base = { uid, documentId, ...q.data, personal, createdAt: '2026-10-05T10:00:00.000Z' };
        rows.push({ ...base, status: 'draft' });
        if (q.status === 'published') rows.push({ ...base, status: 'published' });
        return project(base, q.fields);
      },
      delete: async ({ documentId }) => {
        calls.push({ uid, op: 'delete', documentId });
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].uid === uid && rows[i].documentId === documentId) rows.splice(i, 1);
      },
    };
  };
  globalThis.strapi = {
    documents,
    service: () => ({ write: async (e) => { logs.push(e); } }),
    log: { error() {}, warn() {}, info() {} },
  };
  return { rows, logs, calls };
}

const SESSION = { username: 'Mariia Medvedeva', role: 'manager' };
const P1 = 'per1aaaaaaaaaaaaaaaaaaaa';
const flush = () => new Promise((r) => setImmediate(r));

const expectErr = async (fn, status, code) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `status ${e.status} ≠ ${status} (${e.code})`);
    assert.equal(e.code, code);
    return true;
  });
};

// ── чистые функции ─────────────────────────────────────────────────────────
test('monthRange: границы месяца включительно, мусор → 400', () => {
  assert.deepEqual(C.monthRange('2026-10'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(C.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  for (const bad of ['', '2026-13', '2026-1', "2026-10' or 1=1", null]) {
    assert.throws(() => C.monthRange(bad), (e) => e.code === 'bad_month', String(bad));
  }
});

test('normalizeCorrectionInput: валидная форма', () => {
  const r = C.normalizeCorrectionInput(
    { kind: 'penalty', personal: P1, date: '2026-10-03', sum: '1 500', text: '  pozdní příchod ' },
    '2026-10-05'
  );
  assert.deepEqual(r, { kind: 'penalty', personal: P1, date: '2026-10-03', sum: 1500, text: 'pozdní příchod' });
  // аванс без комментария — можно
  assert.equal(C.normalizeCorrectionInput({ kind: 'avans', personal: P1, date: '2026-10-03', sum: 5000 }, '2026-10-05').text, '');
});

test('normalizeCorrectionInput: коды ошибок', () => {
  const ok = { kind: 'penalty', personal: P1, date: '2026-10-03', sum: 500, text: 'x' };
  const cases = [
    [{ kind: 'tax' }, 'bad_kind'],
    [{ kind: 'constructor' }, 'bad_kind'],
    [{ kind: '__proto__' }, 'bad_kind'],
    [{ personal: '' }, 'personal_required'],
    [{ personal: "x' or 1=1" }, 'personal_not_found'],
    [{ date: '2026-02-30' }, 'bad_date'],
    [{ date: '03.10.2026' }, 'bad_date'],
    [{ date: '2026-12-31' }, 'date_too_far'],
    [{ sum: 0 }, 'bad_sum'],
    [{ sum: -100 }, 'bad_sum'],
    [{ sum: '12.5' }, 'bad_sum'],
    [{ sum: 'abc' }, 'bad_sum'],
    [{ sum: C.MAX_SUM_KC + 1 }, 'sum_too_big'],
    [{ text: '' }, 'text_required'],
    [{ text: 'x'.repeat(C.MAX_TEXT + 1) }, 'text_too_long'],
    [{ kind: 'add-money', text: ' ' }, 'text_required'],
    [{ kind: 'payroll', text: '' }, 'text_required'],
  ];
  for (const [patch, code] of cases) {
    assert.throws(
      () => C.normalizeCorrectionInput({ ...ok, ...patch }, '2026-10-05'),
      (e) => e.code === code && e.status === 400,
      `${JSON.stringify(patch)} → ${code}`
    );
  }
  // ровно на границе будущего — проходит
  assert.equal(C.normalizeCorrectionInput({ ...ok, date: '2026-11-19' }, '2026-10-05').date, '2026-11-19');
});

test('toRow: поле описания по типу, source только у схем с source', () => {
  const add = C.toRow('add-money', { documentId: 'd1', date: '2026-10-01', sum: '33', title: 'Dozápis', source: 'upsell', personal: { documentId: P1, name: ' Yana ' } }, false);
  assert.equal(add.text, 'Dozápis');
  assert.equal(add.sum, 33);
  assert.equal(add.readOnly, true);
  assert.equal(add.personal.name, 'Yana');
  const pen = C.toRow('penalty', { documentId: 'd2', date: '2026-10-01', sum: '500', comment: 'x', source: 'hack' }, true);
  assert.equal(pen.source, null, 'у штрафа поля source нет — чужое значение не читается');
  assert.equal(pen.readOnly, false);
  assert.equal(pen.draft, true);
});

// ── сервис ─────────────────────────────────────────────────────────────────
test('create: публикует запись в нужную коллекцию, текст в своё поле, журнал', async () => {
  const s = makeStrapi();
  const now = new Date('2026-10-05T08:00:00Z');
  const { row } = await svc.create({ session: SESSION, body: { kind: 'add-money', personal: P1, date: '2026-10-04', sum: 700, text: 'Za zaučení' }, now });
  const cr = s.calls.find((c) => c.op === 'create');
  assert.equal(cr.uid, 'api::add-money.add-money');
  assert.equal(cr.q.status, 'published', 'зарплаты читают только published');
  assert.deepEqual(cr.q.data, { date: '2026-10-04', sum: '700', title: 'Za zaučení', personal: { documentId: P1 } });
  assert.equal(s.rows.filter((r) => r.documentId === row.documentId).length, 2, 'обе версии документа');
  assert.equal(row.personal.name, 'Yana Ivanova');
  assert.equal(row.sum, 700);
  await flush();
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].action, 'correction_create');
  assert.equal(s.logs[0].entityType, 'correction');
  assert.equal(s.logs[0].actorName, 'Mariia Medvedeva');
  assert.equal(s.logs[0].employeeName, 'Yana Ivanova');
  assert.match(s.logs[0].summary, /^Příplatek: Yana Ivanova 700 Kč · 04\.10\.2026 · Za zaučení$/);

  // штраф: описание уходит в comment
  await svc.create({ session: SESSION, body: { kind: 'penalty', personal: P1, date: '2026-10-04', sum: 200, text: 'pozdě' }, now });
  const cr2 = s.calls.filter((c) => c.op === 'create')[1];
  assert.equal(cr2.uid, 'api::penalty.penalty');
  assert.equal(cr2.q.data.comment, 'pozdě');
  assert.ok(!('title' in cr2.q.data));
});

test('create: несуществующий сотрудник → 404, ничего не пишется', async () => {
  const s = makeStrapi();
  await expectErr(
    () => svc.create({ session: SESSION, body: { kind: 'avans', personal: 'zzzzzzzzzzzzzzzzzzzzzzzz', date: '2026-10-04', sum: 100 }, now: new Date('2026-10-05T08:00:00Z') }),
    404,
    'personal_not_found'
  );
  assert.equal(s.calls.filter((c) => c.op === 'create').length, 0);
  await flush();
  assert.equal(s.logs.length, 0);
});

test('create: дата «слишком далеко» считается от пражского сегодня', async () => {
  makeStrapi();
  // 31.10 23:30 UTC — в Праге уже 01.11; 16.12 = +45 дней от 01.11 → проходит
  const now = new Date('2026-10-31T23:30:00Z');
  const r = await svc.create({ session: SESSION, body: { kind: 'salary', personal: P1, date: '2026-12-16', sum: 100 }, now });
  assert.equal(r.row.date, '2026-12-16');
});

const seed = () => [
  // опубликованный ручной штраф (обе версии)
  { uid: 'api::penalty.penalty', documentId: 'pen1aaaaaaaaaaaaaaaaaaaa', status: 'draft', date: '2026-10-02', sum: '500', comment: 'pozdě', personal: { documentId: P1, name: 'Yana Ivanova' }, createdAt: '2026-10-02T09:00:00Z' },
  { uid: 'api::penalty.penalty', documentId: 'pen1aaaaaaaaaaaaaaaaaaaa', status: 'published', date: '2026-10-02', sum: '500', comment: 'pozdě', personal: { documentId: P1, name: 'Yana Ivanova' }, createdAt: '2026-10-02T09:00:00Z' },
  // черновик списания от движка (коррекция) — только draft
  { uid: 'api::payroll.payroll', documentId: 'pay1aaaaaaaaaaaaaaaaaaaa', status: 'draft', date: '2026-10-03', sum: '216', comment: 'Korekce', source: 'korekce', personal: { documentId: P1, name: 'Yana Ivanova' }, createdAt: '2026-10-03T09:00:00Z' },
  // комиссия дозаписи — опубликована
  { uid: 'api::add-money.add-money', documentId: 'add1aaaaaaaaaaaaaaaaaaaa', status: 'draft', date: '2026-10-01', sum: '33', title: 'Dozápis', source: 'upsell', personal: { documentId: 'per2bbbbbbbbbbbbbbbbbbbb', name: 'Mariia Medvedeva' }, createdAt: '2026-10-01T09:00:00Z' },
  { uid: 'api::add-money.add-money', documentId: 'add1aaaaaaaaaaaaaaaaaaaa', status: 'published', date: '2026-10-01', sum: '33', title: 'Dozápis', source: 'upsell', personal: { documentId: 'per2bbbbbbbbbbbbbbbbbbbb', name: 'Mariia Medvedeva' }, createdAt: '2026-10-01T09:00:00Z' },
  // штраф из НОЯБРЯ — в октябрь не попадает (верхняя граница месяца)
  { uid: 'api::penalty.penalty', documentId: 'pen2aaaaaaaaaaaaaaaaaaaa', status: 'published', date: '2026-11-01', sum: '100', comment: 'listopad', personal: { documentId: P1, name: 'Yana Ivanova' }, createdAt: '2026-11-01T09:00:00Z' },
  // аванс из СЕНТЯБРЯ — в октябрь не попадает
  { uid: 'api::avans.avans', documentId: 'ava1aaaaaaaaaaaaaaaaaaaa', status: 'published', date: '2026-09-30', sum: '5000', comment: null, personal: { documentId: P1, name: 'Yana Ivanova' }, createdAt: '2026-09-30T09:00:00Z' },
];

test('list: месяц, по строке на документ, черновик без публикации помечен, свежие сверху', async () => {
  makeStrapi(seed());
  const r = await svc.list({ month: '2026-10' });
  assert.equal(r.month, '2026-10');
  assert.deepEqual(r.rows.map((x) => [x.kind, x.documentId, x.draft, x.readOnly]), [
    ['payroll', 'pay1aaaaaaaaaaaaaaaaaaaa', true, true],
    ['penalty', 'pen1aaaaaaaaaaaaaaaaaaaa', false, false],
    ['add-money', 'add1aaaaaaaaaaaaaaaaaaaa', false, true],
  ]);
});

test('list: фильтр по сотруднику идёт в запрос, а не режется после', async () => {
  const s = makeStrapi(seed());
  const r = await svc.list({ month: '2026-10', personal: 'per2bbbbbbbbbbbbbbbbbbbb' });
  assert.deepEqual(r.rows.map((x) => x.documentId), ['add1aaaaaaaaaaaaaaaaaaaa']);
  const fm = s.calls.filter((c) => c.op === 'findMany');
  assert.equal(fm.length, 10, '5 коллекций × (published + draft)');
  for (const c of fm) assert.deepEqual(c.q.filters.personal, { documentId: { $eq: 'per2bbbbbbbbbbbbbbbbbbbb' } });
  await expectErr(() => svc.list({ month: '2026-10', personal: "x'--" }), 400, 'personal_not_found');
});

test('remove: ручную запись удаляет целиком (обе версии) и пишет журнал', async () => {
  const s = makeStrapi(seed());
  const r = await svc.remove({ session: SESSION, kind: 'penalty', documentId: 'pen1aaaaaaaaaaaaaaaaaaaa' });
  assert.equal(r.deleted, 'pen1aaaaaaaaaaaaaaaaaaaa');
  assert.equal(s.rows.filter((x) => x.documentId === 'pen1aaaaaaaaaaaaaaaaaaaa').length, 0);
  await flush();
  assert.equal(s.logs[0].action, 'correction_delete');
  assert.match(s.logs[0].summary, /^Smazáno — pokuta: Yana Ivanova 500 Kč · 02\.10\.2026 · pozdě$/);
});

test('remove: запись движка (source) → 409 и остаётся; черновик тоже находится', async () => {
  const s = makeStrapi(seed());
  await expectErr(() => svc.remove({ session: SESSION, kind: 'payroll', documentId: 'pay1aaaaaaaaaaaaaaaaaaaa' }), 409, 'correction_engine_owned');
  await expectErr(() => svc.remove({ session: SESSION, kind: 'add-money', documentId: 'add1aaaaaaaaaaaaaaaaaaaa' }), 409, 'correction_engine_owned');
  assert.equal(s.calls.filter((c) => c.op === 'delete').length, 0);
  await flush();
  assert.equal(s.logs.length, 0);
});

test('remove: чужой тип / нет записи / мусорный id', async () => {
  makeStrapi(seed());
  // штраф по адресу аванса — не найдётся (коллекция определяется типом)
  await expectErr(() => svc.remove({ session: SESSION, kind: 'avans', documentId: 'pen1aaaaaaaaaaaaaaaaaaaa' }), 404, 'correction_not_found');
  await expectErr(() => svc.remove({ session: SESSION, kind: 'tax', documentId: 'pen1aaaaaaaaaaaaaaaaaaaa' }), 400, 'bad_kind');
  await expectErr(() => svc.remove({ session: SESSION, kind: 'penalty', documentId: '../x' }), 404, 'correction_not_found');
});

test('инварианты: у каждой коллекции поле описания и source совпадают со схемой', () => {
  const root = path.resolve(import.meta.dirname, '../src/api');
  for (const [kind, meta] of Object.entries(C.CORRECTION_KINDS)) {
    const name = meta.uid.split('.').pop();
    const schema = JSON.parse(fs.readFileSync(path.join(root, name, 'content-types', name, 'schema.json'), 'utf8'));
    assert.ok(schema.attributes[meta.text], `${kind}: нет поля ${meta.text}`);
    assert.equal(Boolean(schema.attributes.source), meta.hasSource, `${kind}: source`);
    assert.ok(schema.attributes.personal && schema.attributes.date && schema.attributes.sum, kind);
    assert.equal(schema.options.draftAndPublish, true, `${kind}: draftAndPublish`);
  }
});
