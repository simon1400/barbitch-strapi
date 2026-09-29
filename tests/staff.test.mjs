// Карточка сотрудника (services/staff.ts, s224): чистые функции, список и карточка без
// личных данных, «владелец скрыт от управляющей», личные данные отдельной ручкой
// (и они проходят через вырезание `oficial` в admin-session), запись секций с публикацией,
// смена должности (брони, роль входа), новая ставка с даты, файлы в закрытый каталог,
// заметки. Сервис — НАСТОЯЩИЙ, на заглушке document service с двумя версиями карточки;
// компоненты ведут себя как в Strapi (с `id` — правка на месте, без — пересоздание).
//
// Запуск: cd strapi && node --test tests/staff.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const toJs = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

// сброс кэша учёток — заглушка, считаем вызовы
const INVALIDATE_URL = dataUrl('export const invalidateAdminAccount = (id) => { (globalThis.__invalidated ||= []).push(id); };');
const CORE_URL = dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'));
let svcJs = toJs('src/api/booking-engine/services/staff.ts');
for (const [from, to] of [
  ["from '../../../utils/admin-account'", `from '${INVALIDATE_URL}'`],
  ["from './slots-core'", `from '${CORE_URL}'`],
  ["from 'crypto'", "from 'node:crypto'"],
  ["from 'fs'", "from 'node:fs'"],
  ["from 'path'", "from 'node:path'"],
  ["from 'bcryptjs'", `from '${pathToFileURL(require.resolve('bcryptjs')).href}'`],
]) {
  assert.ok(svcJs.includes(from), `импорт ${from} не найден`);
  svcJs = svcJs.split(from).join(to);
}
const S = await import(dataUrl(svcJs));
const svc = S.default;

// admin-session (настоящий) — ради stripSecret
const JWT_URL = dataUrl(toJs('src/utils/admin-jwt.ts').replace(/from 'crypto'/, "from 'node:crypto'"));
const ACCOUNT_URL = dataUrl(toJs('src/utils/admin-account.ts'));
const mw = await import(
  dataUrl(
    toJs('src/middlewares/admin-session.ts')
      .replace(/from '\.\.\/utils\/admin-jwt';/, `from '${JWT_URL}';`)
      .replace(/from '\.\.\/utils\/admin-account';/, `from '${ACCOUNT_URL}';`)
  )
);

const NOW = new Date('2026-10-05T10:00:00Z'); // понедельник, Прага 12:00
const OWNER = { id: 1, username: 'Dima', role: 'owner' };
const MANAGER = { id: 2, username: 'Mariia Medvedeva', role: 'manager' };
const OWNER2 = { id: 6, username: 'sexybitch', role: 'owner' };

const P = {
  veronika: 'veronika00000000000000001',
  yana: 'yana000000000000000000002',
  mariia: 'mariia0000000000000000003',
  dima: 'dima000000000000000000004',
  olga: 'olga000000000000000000005',
  newbie: 'newbie0000000000000000006',
};
const SECRET = { documentNumber: 'PAS-777111', addressInCz: 'Tajná 12, Brno', phone: '+420777000111' };

const clone = (v) => (v === undefined ? v : structuredClone(v));

function makeStrapi() {
  let seq = 1000;
  let clock = Date.parse('2026-10-01T08:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const files = new Map([
    [301, { id: 301, name: 'pas.pdf', mime: 'application/pdf', size: 120.5, url: 'https://ik.imagekit.io/x/pas.pdf' }],
    [302, { id: 302, name: 'visa.jpg', mime: 'image/jpeg', size: 80, url: 'https://ik.imagekit.io/x/visa.jpg' }],
  ]);
  const person = (documentId, name, extra = {}) => ({
    documentId,
    name,
    position: 'master',
    isActive: true,
    tier: 'senior',
    ratePercent: 40,
    excessThreshold: 0,
    noonaEmployeeId: `noona-${name.slice(0, 3)}`,
    bookingPriority: 0,
    calendarOrder: 1,
    hiredAt: null,
    leftAt: null,
    photo: null,
    services: [{ documentId: 's1' }, { documentId: 's2' }],
    rates: [],
    oficial: null,
    ...extra,
  });
  const seed = [
    person(P.veronika, 'Veronika', {
      calendarOrder: 3,
      rates: [{ id: 11, typeWork: 'dpp', rate: '150', hourlyRate: null, from: '2025-09-01', to: null }],
      oficial: {
        id: 71,
        name: 'Veronika Nováková',
        dateBirth: '09.11.1995',
        addressInCz: SECRET.addressInCz,
        addressInHome: 'Kyiv',
        documentNumber: SECRET.documentNumber,
        phone: SECRET.phone,
        email: 'v@example.com',
        documents: [files.get(301), files.get(302)],
      },
    }),
    person(P.yana, 'Yana', { calendarOrder: 5, services: [], oficial: { id: 72, name: 'Yana', dateBirth: '' } }),
    person(P.mariia, 'Mariia Medvedeva', {
      position: 'manager',
      ratePercent: null,
      noonaEmployeeId: 'noona-mar',
      services: [],
      rates: [
        { id: 21, typeWork: 'hpp', rate: '150', hourlyRate: null, from: '2025-08-01', to: '2026-09-30' },
        { id: 22, typeWork: 'hpp', rate: '19011', hourlyRate: null, from: '2026-10-01', to: null },
      ],
    }),
    person(P.dima, 'Dima', { position: 'administrator', services: [], noonaEmployeeId: null, rates: [] }),
    person(P.olga, 'Olga Eremina', { position: 'administrator', services: [], noonaEmployeeId: null }),
    person(P.newbie, 'Newbie', { position: 'administrator', services: [], noonaEmployeeId: null, calendarOrder: 0, oficial: null }),
  ];
  const store = {
    'api::personal.personal': [],
    'api::staff-document.staff-document': [],
    'api::staff-note.staff-note': [],
    'api::master-schedule.master-schedule': [{ documentId: 'sch1', templates: [{ from: '2026-10-01', days: {} }], personal: { documentId: P.veronika } }],
    'api::time-off.time-off': [
      { documentId: 'to1', type: 'vacation', startDate: '2026-10-20', endDate: '2026-10-24', personal: { documentId: P.veronika } },
      { documentId: 'to0', type: 'sick', startDate: '2026-09-01', endDate: '2026-09-03', personal: { documentId: P.veronika } },
    ],
    'api::booking.booking': [],
    'api::calendar-log.calendar-log': [],
    'api::time-block.time-block': [],
  };
  for (const p of seed) {
    const at = tick();
    store['api::personal.personal'].push({ ...clone(p), id: ++seq, published: false, updatedAt: at });
    store['api::personal.personal'].push({ ...clone(p), id: ++seq, published: true, updatedAt: at });
  }
  const accounts = [
    { id: 1, username: 'Dima', role: 'owner', isActive: true, password: 'HASH' },
    { id: 2, username: 'Mariia Medvedeva', role: 'manager', isActive: true, password: 'HASH' },
    { id: 3, username: 'Veronika', role: 'master', isActive: true, password: 'HASH' },
    { id: 5, username: 'Olga Eremina', role: 'administrator', isActive: false, password: 'HASH' },
    { id: 6, username: 'sexybitch', role: 'owner', isActive: true, password: 'HASH' },
  ];
  const logs = [];
  const calls = [];
  const uploads = [];
  const removed = [];
  const ikDeleted = [];
  let ikFail = null;

  const DP = new Set(['api::personal.personal']);
  const cond = (v, c) => {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      return Object.entries(c).every(([op, a]) => {
        if (op === '$eq') return v === a;
        if (op === '$gte') return v != null && v >= a;
        if (op === '$lte') return v != null && v <= a;
        if (op === '$in') return a.includes(v);
        if (op === '$eqi') return String(v).toLowerCase() === String(a).toLowerCase();
        // связь: { documentId: {...} }
        return v && typeof v === 'object' ? cond(v[op], a) : false;
      });
    }
    return v === c;
  };
  const match = (row, filters = {}) =>
    Object.entries(filters).every(([k, c]) => (k === '$or' ? c.some((f) => match(row, f)) : cond(row[k], c)));
  const rowsOf = (uid, status) =>
    store[uid].filter((r) => !DP.has(uid) || r.published === ((status ?? 'draft') === 'published'));
  const sortRows = (list, sort) => {
    const s = Array.isArray(sort) ? sort[0] : sort;
    if (!s) return list;
    const [f, dir] = s.split(':');
    return [...list].sort((a, b) => String(a[f] ?? '').localeCompare(String(b[f] ?? '')) * (dir === 'desc' ? -1 : 1));
  };
  const out = (r) => {
    const o = clone(r);
    delete o.published;
    return o;
  };

  const docs = (uid) => ({
    async findMany(q = {}) {
      calls.push(['findMany', uid, q.status]);
      return sortRows(rowsOf(uid, q.status).filter((r) => match(r, q.filters)), q.sort)
        .slice(0, q.limit ?? 10)
        .map(out);
    },
    async findOne(q) {
      calls.push(['findOne', uid, q.documentId]);
      const r = rowsOf(uid, q.status).find((x) => x.documentId === q.documentId);
      return r ? out(r) : null;
    },
    async count(q = {}) {
      return rowsOf(uid, q.status).filter((r) => match(r, q.filters)).length;
    },
    async create(q) {
      calls.push(['create', uid, clone(q.data), q.status]);
      const data = clone(q.data);
      if (typeof data.personal === 'string') data.personal = { documentId: data.personal };
      if (uid === 'api::admin-user.admin-user') {
        // учётка: без D&P, строка в тех же `accounts`, что читает db.query
        const row = { ...data, id: ++seq };
        accounts.push(row);
        return { id: row.id, documentId: `acc${seq}`, username: row.username };
      }
      if (DP.has(uid)) {
        // Strapi: компоненты получают id, связь медиатеки — объект файла
        if (data.rates) data.rates = data.rates.map((x) => ({ ...x, id: ++seq }));
        if (data.oficial) data.oficial = { ...data.oficial, id: ++seq, documents: (data.oficial.documents || []).map((id) => files.get(id)) };
        const documentId = `new${String(seq).padStart(22, '0')}`;
        const at = tick();
        const draftRow = { ...data, id: ++seq, documentId, published: false, createdAt: at, updatedAt: at };
        store[uid].push(draftRow);
        if (q.status === 'published') store[uid].push({ ...clone(draftRow), id: ++seq, published: true });
        return out(draftRow);
      }
      const row = { ...data, id: ++seq, documentId: `doc${String(seq).padStart(20, '0')}`, createdAt: tick(), updatedAt: tick() };
      store[uid].push(row);
      return out(row);
    },
    async update(q) {
      calls.push(['update', uid, q.documentId, clone(q.data)]);
      const r = rowsOf(uid, 'draft').find((x) => x.documentId === q.documentId);
      assert.ok(r, `update: нет черновика ${q.documentId}`);
      const data = clone(q.data);
      if ('oficial' in data) {
        const v = data.oficial;
        const docsFrom = (ids) => (ids || []).map((id) => files.get(id));
        if (v && v.id != null) {
          assert.equal(v.id, r.oficial?.id, 'компонент oficial не принадлежит карточке');
          const keepDocs = 'documents' in v ? docsFrom(v.documents) : r.oficial.documents;
          r.oficial = { ...r.oficial, ...v, documents: keepDocs };
        } else {
          r.oficial = v ? { ...v, id: ++seq, documents: docsFrom(v.documents) } : null;
        }
        delete data.oficial;
      }
      if ('rates' in data) {
        const ids = new Set((r.rates || []).map((x) => x.id));
        r.rates = data.rates.map((x) => {
          if (x.id != null) assert.ok(ids.has(x.id), 'чужой компонент rates');
          return { ...x, id: x.id ?? ++seq };
        });
        delete data.rates;
      }
      if ('photo' in data) data.photo = { id: data.photo, url: `https://ik.imagekit.io/x/${data.photo}.jpg`, formats: null };
      Object.assign(r, data, { updatedAt: tick() });
      return out(r);
    },
    async publish(q) {
      calls.push(['publish', uid, q.documentId]);
      const d = store[uid].find((x) => x.documentId === q.documentId && !x.published);
      const i = store[uid].findIndex((x) => x.documentId === q.documentId && x.published);
      if (i >= 0) store[uid].splice(i, 1);
      store[uid].push({ ...clone(d), id: ++seq, published: true });
      return { documentId: q.documentId };
    },
    async delete(q) {
      calls.push(['delete', uid, q.documentId]);
      for (let i = store[uid].length - 1; i >= 0; i--) if (store[uid][i].documentId === q.documentId) store[uid].splice(i, 1);
      return { documentId: q.documentId };
    },
  });

  globalThis.__invalidated = [];
  globalThis.strapi = {
    documents: (uid) => {
      assert.ok(store[uid] || uid === 'api::admin-user.admin-user', `неожиданный uid ${uid}`);
      return docs(uid);
    },
    db: {
      query: (uid) => {
        assert.equal(uid, 'api::admin-user.admin-user');
        return {
          async findMany(q = {}) {
            const sel = q.select;
            return accounts
              .filter((a) => !q.where || Object.entries(q.where).every(([k, v]) => a[k] === v))
              .map((a) => (sel ? Object.fromEntries(sel.map((k) => [k, a[k]])) : clone(a)));
          },
          async update({ where, data }) {
            calls.push(['account.update', where.id, data]);
            Object.assign(accounts.find((a) => a.id === where.id), data);
          },
        };
      },
    },
    service: (uid) => {
      assert.equal(uid, 'api::calendar-log.calendar-log');
      return { write: async (entry) => logs.push(entry) };
    },
    plugin: (name) => {
      if (name === 'imagekit') {
        // сервис плагина ImageKit: удаляет по provider_metadata.fileId
        return {
          config: (k) => (k === 'privateKey' ? 'private_test' : undefined),
          service: (n) => {
            assert.equal(n, 'upload');
            return {
              async delete(f) {
                if (ikFail) throw new Error(ikFail);
                ikDeleted.push(f.provider_metadata.fileId);
              },
            };
          },
        };
      }
      assert.equal(name, 'upload');
      return {
        service: () => ({
          async upload({ data, files: f }) {
            uploads.push({ data, file: { ...f } });
            return [{ id: 900 + uploads.length, url: 'https://ik.imagekit.io/x/p.jpg' }];
          },
          async findOne(id) {
            return files.get(id) || null;
          },
          async remove(file) {
            removed.push(file.id);
            files.delete(file.id);
          },
        }),
      };
    },
    log: { error() {}, info() {}, warn() {} },
  };
  const draft = (id) => store['api::personal.personal'].find((r) => r.documentId === id && !r.published);
  const pub = (id) => store['api::personal.personal'].find((r) => r.documentId === id && r.published);
  return { store, accounts, logs, calls, uploads, removed, ikDeleted, files, draft, pub, setIkFail: (v) => (ikFail = v) };
}

const expectErr = async (fn, status, code) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `status ${e.status} (${e.code}: ${e.message})`);
    assert.equal(e.code, code);
    return true;
  });
};

const hasKeyDeep = (v, key) =>
  Array.isArray(v) ? v.some((x) => hasKeyDeep(x, key)) : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => k === key || hasKeyDeep(x, key)) : false;

// ── чистые функции ─────────────────────────────────────────────────────────
test('birthToStore / birthToYmd: формат прода ДД.ММ.ГГГГ, мусор отклоняется', () => {
  assert.equal(S.birthToStore('1995-11-09', 2026), '09.11.1995');
  assert.equal(S.birthToStore(' 9.11.1995 ', 2026), '09.11.1995');
  assert.equal(S.birthToStore('09/11/1995', 2026), '09.11.1995');
  assert.equal(S.birthToStore('', 2026), '');
  for (const bad of ['1995-02-30', '31.04.1990', 'вчера', '1939-01-01', '2013-01-01', '11/1995']) {
    assert.throws(() => S.birthToStore(bad, 2026), (e) => e.code === 'bad_birth', bad);
  }
  assert.equal(S.birthToYmd('09.11.1995'), '1995-11-09');
  assert.equal(S.birthToYmd('09.11.1995 '), '1995-11-09'); // на проде есть хвостовой пробел
  assert.equal(S.birthToYmd('30.02.1995'), null);
  assert.equal(S.birthToYmd('как-нибудь'), null);
});

test('normalizePrivate: только известные поля, нормализация, список изменённых', () => {
  const cur = { name: 'A', phone: '+420777000111', email: 'a@b.cz', documents: [{ id: 1 }] };
  const r = S.normalizePrivate({ phone: '777 000 111', email: ' A@B.CZ ', addressInCz: '  Nová   1 ' }, cur, 2026);
  assert.equal(r.next.phone, '+420777000111');
  assert.equal(r.next.email, 'a@b.cz');
  assert.equal(r.next.addressInCz, 'Nová 1');
  assert.deepEqual(r.changed, ['addressInCz']); // телефон и e-mail те же после нормализации
  assert.equal(r.next.name, 'A');
  assert.ok(!('documents' in r.next), 'сканы этой секцией не пишутся');
  for (const key of ['documents', 'oficial', 'id', '__proto__x']) {
    assert.throws(() => S.normalizePrivate({ [key]: 'x' }, cur, 2026), (e) => e.code === 'bad_field', key);
  }
  assert.throws(() => S.normalizePrivate({}, cur, 2026), (e) => e.code === 'nothing_to_save');
  assert.throws(() => S.normalizePrivate({ phone: '12' }, cur, 2026), (e) => e.code === 'bad_phone');
  assert.throws(() => S.normalizePrivate({ email: 'nope' }, cur, 2026), (e) => e.code === 'bad_email');
  assert.throws(() => S.normalizePrivate({ name: { $gt: '' } }, cur, 2026), (e) => e.code === 'bad_field');
  assert.throws(() => S.normalizePrivate({ addressInHome: 'x'.repeat(201) }, cur, 2026), (e) => e.code === 'too_long');
  assert.throws(() => S.normalizePrivate({ bankAccount: '<script>' }, cur, 2026), (e) => e.code === 'bad_bank');
  assert.equal(S.normalizePrivate({ bankAccount: '19-2000145399/0800' }, cur, 2026).next.bankAccount, '19-2000145399/0800');
  assert.equal(S.normalizePrivate({ bankAccount: 'cz65 0800 0000 1920 0014 5399' }, cur, 2026).next.bankAccount, 'CZ65 0800 0000 1920 0014 5399');
  // стереть поле можно (личные данные не обязательны — решение владельца)
  assert.deepEqual(S.normalizePrivate({ phone: '' }, cur, 2026).changed, ['phone']);
});

test('normalizeBasic / normalizeBooking / normalizePay: границы и лишние поля', () => {
  const cur = { position: 'master', tier: null, hiredAt: null, bookingPriority: 0, ratePercent: 40, excessThreshold: 0 };
  assert.deepEqual(S.normalizeBasic({ tier: 'senior' }, cur, '2026-10-05').changes, []); // null = senior
  const b = S.normalizeBasic({ position: 'administrator', hiredAt: '2024-03-01' }, cur, '2026-10-05');
  assert.deepEqual(b.patch, { position: 'administrator', hiredAt: '2024-03-01' });
  assert.equal(b.changes.length, 2);
  for (const [data, code] of [
    [{ position: 'owner' }, 'bad_position'],
    [{ tier: 'middle' }, 'bad_tier'],
    [{ hiredAt: '2014-12-31' }, 'bad_date'],
    [{ hiredAt: '2027-10-07' }, 'bad_date'], // сегодня + 366 = 06.10.2027 ещё можно
    [{ name: 'X' }, 'bad_field'],
    [{ isActive: false }, 'bad_field'],
    [{ ratePercent: 99 }, 'bad_field'],
    [{}, 'nothing_to_save'],
    [[], 'bad_data'],
  ]) {
    assert.throws(() => S.normalizeBasic(data, cur, '2026-10-05'), (e) => e.code === code, JSON.stringify(data));
  }
  assert.equal(S.normalizeBasic({ hiredAt: '' }, { hiredAt: '2024-01-01' }, '2026-10-05').patch.hiredAt, null);
  assert.deepEqual(S.normalizeBooking({ bookingPriority: '5' }, cur).patch, { bookingPriority: 5 });
  assert.throws(() => S.normalizeBooking({ bookingPriority: 1.5 }, cur), (e) => e.code === 'bad_priority');
  assert.throws(() => S.normalizeBooking({ calendarOrder: 1 }, cur), (e) => e.code === 'bad_field');
  assert.deepEqual(S.normalizePay({ ratePercent: 45 }, cur).changes, [{ key: 'ratePercent', from: 40, to: 45 }]);
  for (const v of [101, -1, '40%', 40.5, null]) assert.throws(() => S.normalizePay({ ratePercent: v }, cur), (e) => e.code === 'bad_percent', String(v));
  assert.throws(() => S.normalizePay({ rates: [] }, cur), (e) => e.code === 'bad_field');
});

test('rateOn: то же правило, что у зарплат (граничный день — новая ставка)', () => {
  const rates = [
    { typeWork: 'dpp', rate: '150', from: '2025-09-01', to: '2026-10-01' },
    { typeWork: 'dpp', rate: '180', from: '2026-10-01', to: null },
  ];
  assert.equal(S.rateOn(rates, '2026-09-30').rate, 150);
  assert.equal(S.rateOn(rates, '2026-10-01').rate, 180);
  assert.equal(S.rateOn(rates, '2025-08-31'), null);
  assert.equal(S.rateOn([], '2026-10-01'), null);
});

test('planNewRate: закрывает действующие днём раньше, прошлое не правит', () => {
  const rates = [
    { id: 1, typeWork: 'dpp', rate: '120', from: '2025-01-01', to: '2025-08-31' },
    { id: 2, typeWork: 'dpp', rate: '150', from: '2025-09-01', to: null },
  ];
  const p = S.planNewRate(rates, { typeWork: 'dpp', rate: '180', from: '2026-11-01' }, '2026-10-05');
  assert.deepEqual(p.rates.map((r) => [r.id, r.from, r.to]), [
    [1, '2025-01-01', '2025-08-31'],
    [2, '2025-09-01', '2026-10-31'],
    [undefined, '2026-11-01', null],
  ]);
  assert.equal(p.closed.length, 1);
  assert.equal(p.rates[1].rate, '150', 'прежняя сумма не трогается');
  // запись с концом в будущем тоже закрывается
  const q = S.planNewRate([{ id: 3, typeWork: 'hpp', rate: '19011', from: '2026-10-01', to: '2026-12-31' }], { typeWork: 'hpp', rate: 20000, hourlyRate: 150, from: '2026-11-15' }, '2026-10-05');
  assert.equal(q.rates[0].to, '2026-11-14');
  assert.equal(q.added.hourlyRate, 150);
  for (const [input, code] of [
    [{ typeWork: 'dpp', rate: 180, from: '2026-09-30' }, 'rate_in_past'],
    [{ typeWork: 'dpp', rate: 180, from: '2025-09-01' }, 'rate_in_past'],
    [{ typeWork: 'dpp', rate: 0, from: '2026-11-01' }, 'bad_rate'],
    [{ typeWork: 'dpp', rate: 180, hourlyRate: 150, from: '2026-11-01' }, 'hourly_only_hpp'],
    [{ typeWork: 'ico', rate: 180, from: '2026-11-01' }, 'bad_type_work'],
    [{ typeWork: 'dpp', rate: 180, from: '2027-10-07' }, 'date_too_far'],
    [{ typeWork: 'dpp', rate: 180, from: '01.11.2026' }, 'bad_date'],
  ]) {
    assert.throws(() => S.planNewRate(rates, input, '2026-10-05'), (e) => e.code === code, JSON.stringify(input));
  }
  // начало не позже последней записи — 409
  const later = [{ id: 4, typeWork: 'dpp', rate: '150', from: '2026-12-01', to: null }];
  assert.throws(() => S.planNewRate(later, { typeWork: 'dpp', rate: 180, from: '2026-11-01' }, '2026-10-05'), (e) => e.code === 'rate_overlap' && e.status === 409);
  assert.throws(() => S.planNewRate(later, { typeWork: 'dpp', rate: 180, from: '2026-12-01' }, '2026-10-05'), (e) => e.code === 'rate_overlap');
  // текущий месяц — можно
  assert.equal(S.planNewRate([], { typeWork: 'dpp', rate: 180, from: '2026-10-01' }, '2026-10-05').rates.length, 1);
});

test('missingFlags: бейджи по должности, ушедшим пусто', () => {
  const ctx = { account: null, servicesCount: 0, hasSchedule: false, privateMissing: ['phone'], today: '2026-10-05' };
  assert.deepEqual(S.missingFlags({ position: 'master', ratePercent: null }, ctx), [
    'no_account', 'not_in_calendar', 'no_services', 'no_schedule', 'no_rate', 'private_incomplete',
  ]);
  const okMaster = { position: 'master', ratePercent: 40, noonaEmployeeId: 'x' };
  assert.deepEqual(S.missingFlags(okMaster, { account: { isActive: true }, servicesCount: 3, hasSchedule: true, privateMissing: [], today: '2026-10-05' }), []);
  assert.deepEqual(S.missingFlags(okMaster, { account: { isActive: false }, servicesCount: 3, hasSchedule: true, privateMissing: [], today: '2026-10-05' }), ['account_disabled']);
  const admin = { position: 'administrator', rates: [{ typeWork: 'dpp', rate: 150, from: '2026-11-01' }] };
  assert.deepEqual(S.missingFlags(admin, { account: { isActive: true }, privateMissing: [], today: '2026-10-05' }), ['no_rate']);
  assert.deepEqual(S.missingFlags({ ...admin, isActive: false }, ctx), []);
  assert.deepEqual(S.missingFlags({ ...admin, name: '❌ Anna' }, ctx), []);
});

test('detectFile / safeFileName / contentDisposition', () => {
  assert.equal(S.detectFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  assert.equal(S.detectFile(Buffer.from('89504e470d0a1a0a0000', 'hex')).mime, 'image/png');
  assert.equal(S.detectFile(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')).mime, 'image/webp');
  assert.equal(S.detectFile(Buffer.from('%PDF-1.7\n')).mime, 'application/pdf');
  assert.equal(S.detectFile(Buffer.from('MZ\x90\x00')), null); // exe с расширением .pdf
  assert.equal(S.detectFile(Buffer.from('<svg xmlns=')), null); // svg — нет (скрипты)
  assert.equal(S.detectFile(Buffer.alloc(0)), null);
  assert.equal(S.safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(S.safeFileName('C:\\Users\\a\\Pas "nový".pdf'), 'Pas nový.pdf');
  assert.equal(S.safeFileName('', 'pdf'), 'dokument.pdf');
  assert.equal(S.safeFileName('x'.repeat(300) + '.pdf').length, S.MAX_FILE_NAME);
  assert.ok(S.safeFileName('x'.repeat(300) + '.pdf').endsWith('.pdf'));
  const cd = S.contentDisposition('Povolení k pobytu.pdf');
  assert.match(cd, /^inline; filename="Povolen_ k pobytu\.pdf"; filename\*=UTF-8''Povolen%C3%AD%20k%20pobytu\.pdf$/);
});

test('normalizeDocMeta / normalizeNoteText', () => {
  assert.deepEqual(S.normalizeDocMeta({}, { create: true, fileName: 'sken.pdf' }), { kind: 'other', title: 'sken' });
  assert.deepEqual(S.normalizeDocMeta({ kind: 'passport', title: ' Pas ', validUntil: '2030-01-31' }, { create: true, fileName: 'a.pdf' }), {
    kind: 'passport', title: 'Pas', validUntil: '2030-01-31',
  });
  assert.deepEqual(S.normalizeDocMeta({ validUntil: '' }), { validUntil: null });
  assert.throws(() => S.normalizeDocMeta({ kind: 'constructor' }), (e) => e.code === 'bad_kind');
  assert.throws(() => S.normalizeDocMeta({ title: '' }), (e) => e.code === 'title_required');
  assert.throws(() => S.normalizeDocMeta({ validUntil: '31.01.2030' }), (e) => e.code === 'bad_date');
  assert.throws(() => S.normalizeDocMeta({}), (e) => e.code === 'nothing_to_save');
  // multipart-поля приходят объектом без прототипа
  const mp = Object.assign(Object.create(null), { kind: 'health', title: 'Průkaz' });
  assert.equal(S.normalizeDocMeta(mp, { create: true }).kind, 'health');
  assert.equal(S.normalizeNoteText('  a\r\nb  '), 'a\nb');
  assert.throws(() => S.normalizeNoteText('   '), (e) => e.code === 'note_required');
  assert.throws(() => S.normalizeNoteText('x'.repeat(2001)), (e) => e.code === 'too_long');
});

// ── чтение ─────────────────────────────────────────────────────────────────
test('список: без личных данных, признаки, владелец скрыт от управляющей', async () => {
  makeStrapi();
  const asOwner = await svc.list({ session: OWNER, now: NOW });
  const json = JSON.stringify(asOwner);
  for (const v of [...Object.values(SECRET), 'Veronika Nováková', '09.11.1995', 'HASH']) assert.ok(!json.includes(v), `утечка: ${v}`);
  assert.ok(!hasKeyDeep(asOwner, 'oficial'));
  assert.equal(asOwner.today, '2026-10-05');
  assert.ok(asOwner.rows.some((r) => r.name === 'Dima'), 'владелец видит свою карточку');
  const byName = Object.fromEntries(asOwner.rows.map((r) => [r.name, r]));
  assert.deepEqual(byName.Veronika.flags, []);
  assert.equal(byName.Veronika.servicesCount, 2);
  assert.deepEqual(byName.Yana.flags, ['no_account', 'no_services', 'no_schedule', 'private_incomplete']);
  assert.deepEqual(byName['Olga Eremina'].flags, ['account_disabled', 'no_rate', 'private_incomplete']);
  assert.equal(byName['Olga Eremina'].account.isActive, false);
  assert.deepEqual(byName.Veronika.account, { id: 3, role: 'master', isActive: true }, 'в списке логин не нужен');
  assert.ok(!hasKeyDeep(asOwner, 'password'));

  const asManager = await svc.list({ session: MANAGER, now: NOW });
  assert.ok(!asManager.rows.some((r) => r.name === 'Dima'), 'карточка с именем учётки owner скрыта');
  assert.equal(asManager.rows.length, asOwner.rows.length - 1);
});

test('карточка: учётка без пароля, ставки, ближайшее отсутствие; 404 для чужого/скрытого/мусора', async () => {
  const st = makeStrapi();
  const c = await svc.card({ session: MANAGER, id: P.veronika, now: NOW });
  assert.deepEqual(c.account, { id: 3, username: 'Veronika', role: 'master', isActive: true, linked: false });
  assert.ok(!hasKeyDeep(c, 'password') && !hasKeyDeep(c, 'oficial'));
  assert.ok(!JSON.stringify(c).includes(SECRET.documentNumber));
  assert.deepEqual(c.privateMissing, []);
  assert.equal(c.pay.currentRate.rate, 150);
  assert.equal(c.booking.hasSchedule, true);
  assert.deepEqual(c.nextTimeOff, { type: 'vacation', startDate: '2026-10-20', endDate: '2026-10-24' });
  assert.equal(c.self, false);
  assert.equal(c.published, true);
  const own = await svc.card({ session: MANAGER, id: P.mariia, now: NOW });
  assert.equal(own.self, true);
  assert.deepEqual(own.pay.rates.map((r) => r.rate), [150, 19011]);
  assert.equal(own.pay.currentRate.rate, 19011);
  await expectErr(() => svc.card({ session: MANAGER, id: P.dima, now: NOW }), 404, 'staff_not_found');
  assert.equal((await svc.card({ session: OWNER, id: P.dima, now: NOW })).name, 'Dima');
  const before = st.calls.length;
  for (const bad of ['', 'nope', '../x', { $ne: 1 }, 'x'.repeat(41)]) {
    await expectErr(() => svc.card({ session: OWNER, id: bad, now: NOW }), 404, 'staff_not_found');
  }
  assert.equal(st.calls.length, before, 'мусорный id не доходит до базы');
  await expectErr(() => svc.card({ session: OWNER, id: 'missing00000000000000009', now: NOW }), 404, 'staff_not_found');
});

test('личные данные: ключ `private`, проходят через вырезание `oficial` в admin-session целиком', async () => {
  makeStrapi();
  const r = await svc.privateData({ session: MANAGER, id: P.veronika });
  assert.equal(r.private.documentNumber, SECRET.documentNumber);
  assert.equal(r.private.dateBirthYmd, '1995-11-09');
  assert.deepEqual(r.legacyFiles.map((f) => [f.id, f.name, f.size]), [[301, 'pas.pdf', 120500], [302, 'visa.jpg', 80000]]);
  assert.deepEqual(r.documents, []);
  const copy = structuredClone(r);
  assert.equal(mw.stripSecret(copy), false, 'middleware ничего не вырезал');
  assert.deepEqual(copy, r);
  // тот же путь не упоминает `oficial` в query — не 403
  assert.equal(mw.queryTouchesSecret(''), false);
  await expectErr(() => svc.privateData({ session: MANAGER, id: P.dima }), 404, 'staff_not_found');
  // карточка без компонента — пустые строки, все поля «не заполнены»
  const empty = await svc.privateData({ session: OWNER, id: P.newbie });
  assert.equal(empty.private.name, '');
  assert.equal(empty.missing.length, 7);
});

// ── запись секций ──────────────────────────────────────────────────────────
test('личные данные: правка на месте, старые сканы сохраняются, обе версии, журнал без значений', async () => {
  const st = makeStrapi();
  const base = st.draft(P.veronika).updatedAt;
  const r = await svc.patch({
    session: MANAGER,
    id: P.veronika,
    body: { section: 'private', base, data: { phone: '777 123 456', bankAccount: '123-456/0100', dateBirth: '1995-11-10' } },
    now: NOW,
  });
  assert.equal(r.unchanged, false);
  assert.equal(r.private.phone, '+420777123456');
  assert.equal(r.private.dateBirth, '10.11.1995');
  const upd = st.calls.find((c) => c[0] === 'update');
  assert.equal(upd[3].oficial.id, 71, 'компонент правится по id');
  assert.deepEqual(upd[3].oficial.documents, [301, 302], 'сканы переданы как были');
  const i = st.calls.findIndex((c) => c[0] === 'update');
  assert.deepEqual(st.calls[i + 1], ['publish', 'api::personal.personal', P.veronika], 'сразу публикация');
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) {
    assert.equal(v.oficial.phone, '+420777123456');
    assert.equal(v.oficial.documentNumber, SECRET.documentNumber, 'остальные поля не тронуты');
    assert.deepEqual(v.oficial.documents.map((f) => f.id), [301, 302]);
  }
  assert.equal(st.logs.length, 1);
  const log = JSON.stringify(st.logs[0]);
  assert.equal(st.logs[0].entityType, 'staff');
  assert.equal(st.logs[0].summary, 'Osobní údaje změněny: Veronika · datum narození · telefon · číslo účtu');
  for (const v of ['777', '123-456', '1995', SECRET.documentNumber]) assert.ok(!log.includes(v), `значение в журнале: ${v}`);
  // устаревшая base — 409, данные целы
  await expectErr(
    () => svc.patch({ session: MANAGER, id: P.veronika, body: { section: 'private', base, data: { phone: '' } }, now: NOW }),
    409,
    'staff_changed'
  );
  assert.equal(st.draft(P.veronika).oficial.phone, '+420777123456');
  await expectErr(() => svc.patch({ session: MANAGER, id: P.veronika, body: { section: 'private', data: { phone: '' } }, now: NOW }), 400, 'base_required');
  // то же значение — без записи
  const n = st.calls.length;
  const same = await svc.patch({ session: MANAGER, id: P.veronika, body: { section: 'private', base: r.updatedAt, data: { phone: '+420 777 123 456' } }, now: NOW });
  assert.equal(same.unchanged, true);
  assert.ok(!st.calls.slice(n).some((c) => c[0] === 'update' || c[0] === 'publish'));
});

test('личные данные: карточке без компонента он создаётся', async () => {
  const st = makeStrapi();
  const r = await svc.patch({
    session: OWNER,
    id: P.newbie,
    body: { section: 'private', base: st.draft(P.newbie).updatedAt, data: { name: 'New Bie', email: 'n@b.cz' } },
    now: NOW,
  });
  assert.equal(r.private.name, 'New Bie');
  assert.deepEqual(r.missing, ['dateBirth', 'addressInCz', 'addressInHome', 'documentNumber', 'phone']);
  assert.equal(st.pub(P.newbie).oficial.email, 'n@b.cz');
});

test('основное: смена должности мастера — запрет при будущих бронях, иначе роль входа следом', async () => {
  const st = makeStrapi();
  st.store['api::booking.booking'].push(
    { documentId: 'b1', status: 'active', date: '2026-10-07', startsAt: '2026-10-07T08:00:00.000Z', clientNameRaw: 'Klára', employee: { documentId: P.veronika } },
    { documentId: 'b2', status: 'active', date: '2026-10-05', startsAt: '2026-10-05T07:00:00.000Z', clientNameRaw: 'Ráno', employee: { documentId: P.veronika } }, // уже прошла
    { documentId: 'b3', status: 'cancelled', date: '2026-10-08', startsAt: '2026-10-08T08:00:00.000Z', employee: { documentId: P.veronika } },
    { documentId: 'b4', status: 'active', date: '2026-10-09', startsAt: '2026-10-09T12:00:00.000Z', noonaEmployeeId: 'noona-Ver' }
  );
  const base = st.draft(P.veronika).updatedAt;
  await assert.rejects(
    () => svc.patch({ session: MANAGER, id: P.veronika, body: { section: 'basic', base, data: { position: 'administrator' } }, now: NOW }),
    (e) => {
      assert.equal(e.code, 'future_bookings');
      assert.equal(e.status, 409);
      assert.deepEqual(e.details.bookings.map((b) => [b.documentId, b.time]), [['b1', '10:00'], ['b4', '14:00']]);
      return true;
    }
  );
  assert.equal(st.draft(P.veronika).position, 'master');
  assert.equal(st.accounts.find((a) => a.id === 3).role, 'master');
  st.store['api::booking.booking'].length = 0;
  const r = await svc.patch({ session: MANAGER, id: P.veronika, body: { section: 'basic', base, data: { position: 'administrator', hiredAt: '2025-09-01' } }, now: NOW });
  assert.equal(r.position, 'administrator');
  assert.equal(st.pub(P.veronika).position, 'administrator');
  assert.equal(st.pub(P.veronika).hiredAt, '2025-09-01');
  assert.equal(st.accounts.find((a) => a.id === 3).role, 'administrator');
  assert.deepEqual(globalThis.__invalidated, [3], 'кэш учётки сброшен — сессия гаснет сразу');
  assert.match(st.logs.at(-1).summary, /^Karta zaměstnance upravena: Veronika · pozice: mistr → administrátor · nástup: — → 01\.09\.2025 · role přihlášení: master → administrator$/);
});

test('основное: в мастера — ключ колонки = documentId и место в конце; себе и владельцу — нельзя', async () => {
  const st = makeStrapi();
  const r = await svc.patch({ session: OWNER, id: P.newbie, body: { section: 'basic', base: st.draft(P.newbie).updatedAt, data: { position: 'master' } }, now: NOW });
  assert.equal(r.booking.noonaEmployeeId, P.newbie);
  assert.equal(r.booking.calendarOrder, 6, 'max(5) + 1');
  assert.equal(st.pub(P.newbie).noonaEmployeeId, P.newbie);
  assert.ok(r.flags.includes('no_account'));
  // ключ уже есть — не трогаем
  const keep = await svc.patch({ session: OWNER, id: P.olga, body: { section: 'basic', base: st.draft(P.olga).updatedAt, data: { position: 'master' } }, now: NOW });
  assert.equal(keep.booking.noonaEmployeeId, P.olga);
  assert.equal(st.accounts.find((a) => a.id === 5).role, 'master');
  await expectErr(
    () => svc.patch({ session: MANAGER, id: P.mariia, body: { section: 'basic', base: st.draft(P.mariia).updatedAt, data: { position: 'master' } }, now: NOW }),
    409,
    'self_position'
  );
  await expectErr(
    () => svc.patch({ session: OWNER2, id: P.dima, body: { section: 'basic', base: st.draft(P.dima).updatedAt, data: { position: 'master' } }, now: NOW }),
    409,
    'owner_account'
  );
  assert.equal(st.accounts.find((a) => a.id === 1).role, 'owner');
  // уровень себе менять можно — роль не трогается
  const tier = await svc.patch({ session: MANAGER, id: P.mariia, body: { section: 'basic', base: st.draft(P.mariia).updatedAt, data: { tier: 'junior' } }, now: NOW });
  assert.equal(tier.tier, 'junior');
  assert.equal(st.accounts.find((a) => a.id === 2).role, 'manager');
});

test('запись и оплата: приоритет только мастеру, доля — обе версии; неизвестная секция', async () => {
  const st = makeStrapi();
  const r = await svc.patch({ session: OWNER, id: P.veronika, body: { section: 'booking', base: st.draft(P.veronika).updatedAt, data: { bookingPriority: 7 } }, now: NOW });
  assert.equal(r.booking.bookingPriority, 7);
  assert.equal(st.draft(P.veronika).bookingPriority, 7);
  assert.equal(st.pub(P.veronika).bookingPriority, 7);
  await expectErr(
    () => svc.patch({ session: OWNER, id: P.olga, body: { section: 'booking', base: st.draft(P.olga).updatedAt, data: { bookingPriority: 1 } }, now: NOW }),
    409,
    'not_master'
  );
  const pay = await svc.patch({ session: OWNER, id: P.veronika, body: { section: 'pay', base: r.updatedAt, data: { ratePercent: 45, excessThreshold: 30000 } }, now: NOW });
  assert.equal(pay.pay.ratePercent, 45);
  assert.equal(st.pub(P.veronika).ratePercent, 45);
  assert.equal(st.logs.at(-1).summary, 'Mzdové podmínky upraveny: Veronika · podíl mistra: 40 % → 45 % · práh: 0 → 30000');
  for (const section of ['', 'oficial', 'account', 'constructor']) {
    await expectErr(() => svc.patch({ session: OWNER, id: P.veronika, body: { section, base: pay.updatedAt, data: {} }, now: NOW }), 400, 'bad_section');
  }
  await expectErr(() => svc.patch({ session: MANAGER, id: P.dima, body: { section: 'pay', base: 'x', data: { ratePercent: 1 } }, now: NOW }), 404, 'staff_not_found');
  // s229 §5а.2: зарплатная группа — в карточке, обе версии, журнал
  assert.deepEqual(pay.pay.group, { dualRole: false, dualRoleUntil: null, managerSince: null });
  const g = await svc.patch({ session: OWNER, id: P.veronika, body: { section: 'pay', base: pay.updatedAt, data: { dualRole: true, dualRoleUntil: '2026-06' } }, now: NOW });
  assert.deepEqual(g.pay.group, { dualRole: true, dualRoleUntil: '2026-06', managerSince: null });
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) assert.deepEqual([v.dualRole, v.dualRoleUntil], ['yes', '2026-06']);
  assert.equal(st.logs.at(-1).summary, 'Mzdové podmínky upraveny: Veronika · souběh mistr + administrátor: ne → ano · souběh do: — → 2026-06');
  const off = await svc.patch({ session: OWNER, id: P.veronika, body: { section: 'pay', base: g.updatedAt, data: { dualRole: false } }, now: NOW });
  assert.deepEqual(off.pay.group, { dualRole: false, dualRoleUntil: null, managerSince: null });
  assert.deepEqual([st.pub(P.veronika).dualRole, st.pub(P.veronika).dualRoleUntil], [null, null], 'снятие — обе версии, «до» вместе с признаком');
  await expectErr(() => svc.patch({ session: OWNER, id: P.veronika, body: { section: 'pay', base: off.updatedAt, data: { managerSince: '2026-10' } }, now: NOW }), 409, 'not_manager');
  const m = await svc.patch({ session: OWNER, id: P.mariia, body: { section: 'pay', base: st.draft(P.mariia).updatedAt, data: { managerSince: '2026-10' } }, now: NOW });
  assert.equal(m.pay.group.managerSince, '2026-10');
  assert.equal(st.pub(P.mariia).managerSince, '2026-10');
});

test('новая ставка: закрывает прежнюю днём раньше, обе версии, id прежних записей сохранены', async () => {
  const st = makeStrapi();
  const r = await svc.addRate({
    session: MANAGER,
    id: P.veronika,
    body: { base: st.draft(P.veronika).updatedAt, typeWork: 'dpp', rate: 180, from: '2026-11-01' },
    now: NOW,
  });
  assert.deepEqual(r.pay.rates.map((x) => [x.rate, x.from, x.to]), [[150, '2025-09-01', '2026-10-31'], [180, '2026-11-01', null]]);
  assert.equal(r.pay.currentRate.rate, 150, 'сегодня ещё старая');
  const upd = st.calls.find((c) => c[0] === 'update');
  assert.equal(upd[3].rates[0].id, 11);
  assert.equal(st.pub(P.veronika).rates.length, 2);
  assert.equal(st.logs.at(-1).action, 'staff_rate');
  assert.equal(st.logs.at(-1).summary, 'Nová sazba: Veronika · DPP 180 Kč/h od 01.11.2026 · DPP 150 Kč/h do 31.10.2026');
  await expectErr(
    () => svc.addRate({ session: MANAGER, id: P.veronika, body: { base: r.updatedAt, typeWork: 'dpp', rate: 200, from: '2026-11-01' }, now: NOW }),
    409,
    'rate_overlap'
  );
  await expectErr(
    () => svc.addRate({ session: MANAGER, id: P.veronika, body: { base: 'старая', typeWork: 'dpp', rate: 200, from: '2026-12-01' }, now: NOW }),
    409,
    'staff_changed'
  );
});

// ── файлы ──────────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-test-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let tmpSeq = 0;
const upload = (bytes, name) => {
  const filepath = path.join(tmpRoot, `upload-${++tmpSeq}`);
  fs.writeFileSync(filepath, bytes);
  return { files: { files: { filepath, originalFilename: name, mimetype: 'application/octet-stream', size: bytes.length } } };
};
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);

test('документ: закрытый каталог, права 600, выдача только своей карточке, правка, удаление', async () => {
  const st = makeStrapi();
  const dir = path.join(tmpRoot, 'store');
  fs.mkdirSync(dir, { mode: 0o755 }); // как созданный руками на сервере
  process.env.STAFF_FILES_DIR = dir;
  const res = await svc.uploadFile({
    session: MANAGER,
    id: P.veronika,
    body: { target: 'document', kind: 'passport', title: 'Pas', validUntil: '2030-05-31' },
    ...upload(PDF, '../../pas "scan".pdf'),
    now: NOW,
  });
  assert.equal(res.document.kind, 'passport');
  assert.equal(res.document.fileName, 'pas scan.pdf');
  assert.equal(res.document.mime, 'application/pdf');
  assert.ok(!('storedName' in res.document), 'имя на диске наружу не отдаётся');
  const row = st.store['api::staff-document.staff-document'][0];
  assert.match(row.storedName, /^[a-f0-9]{32}$/);
  assert.deepEqual(row.personal, { documentId: P.veronika });
  const onDisk = path.join(dir, row.storedName);
  assert.ok(fs.readFileSync(onDisk).equals(PDF));
  assert.equal(fs.statSync(onDisk).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), [row.storedName], 'без хвостов .part');
  assert.equal(st.logs.at(-1).summary, 'Nový dokument: Veronika · Pas · Pas');

  const list = await svc.privateData({ session: MANAGER, id: P.veronika });
  assert.equal(list.documents.length, 1);
  assert.ok(!hasKeyDeep(list, 'storedName'));

  const dl = await svc.download({ session: MANAGER, id: P.veronika, fileId: row.documentId });
  const chunks = [];
  for await (const c of dl.stream) chunks.push(c);
  assert.ok(Buffer.concat(chunks).equals(PDF));
  assert.equal(dl.mime, 'application/pdf');
  assert.equal(dl.size, PDF.length);
  assert.match(dl.disposition, /^inline; filename="pas scan\.pdf"/);
  // чужая карточка с тем же id документа — 404
  await expectErr(() => svc.download({ session: MANAGER, id: P.yana, fileId: row.documentId }), 404, 'file_not_found');
  await expectErr(() => svc.download({ session: MANAGER, id: P.veronika, fileId: '../x' }), 404, 'file_not_found');

  const upd = await svc.updateFile({ session: MANAGER, id: P.veronika, fileId: row.documentId, body: { validUntil: '2031-01-31' } });
  assert.equal(upd.document.validUntil, '2031-01-31');
  assert.equal(st.logs.at(-1).summary, 'Dokument upraven: Veronika · Pas · platnost: 31.05.2030 → 31.01.2031');

  await svc.deleteFile({ session: MANAGER, id: P.veronika, fileId: row.documentId });
  assert.equal(st.store['api::staff-document.staff-document'].length, 0);
  assert.ok(!fs.existsSync(onDisk), 'файл удалён с диска');
  assert.equal(st.logs.at(-1).action, 'staff_file_delete');
});

test('загрузка: сигнатура, размер, хранилище не настроено, фото — только картинка', async () => {
  const st = makeStrapi();
  process.env.STAFF_FILES_DIR = path.join(tmpRoot, 'store2');
  const exe = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(50)]);
  await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'document' }, ...upload(exe, 'pas.pdf'), now: NOW }), 400, 'bad_file_type');
  const big = upload(PDF, 'big.pdf');
  big.files.files.size = S.MAX_FILE_BYTES + 1;
  await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'document' }, ...big, now: NOW }), 413, 'file_too_big');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'document' }, files: {}, now: NOW }), 400, 'file_required');
  const two = upload(PDF, 'a.pdf');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'document' }, files: { files: [two.files.files, two.files.files] }, now: NOW }), 400, 'file_required');
  await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'avatar' }, ...upload(PDF, 'a.pdf'), now: NOW }), 400, 'bad_target');
  await expectErr(() => svc.uploadFile({ session: MANAGER, id: P.dima, body: { target: 'document' }, ...upload(PDF, 'a.pdf'), now: NOW }), 404, 'staff_not_found');
  for (const env of ['', 'relative/dir']) {
    process.env.STAFF_FILES_DIR = env;
    await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'document' }, ...upload(PDF, 'a.pdf'), now: NOW }), 503, 'storage_not_configured');
  }
  assert.equal(st.store['api::staff-document.staff-document'].length, 0);
  // фото: PDF нельзя; картинка — в медиатеку, тип по сигнатуре, обе версии
  await expectErr(() => svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'photo' }, ...upload(PDF, 'x.jpg'), now: NOW }), 400, 'photo_not_image');
  const r = await svc.uploadFile({ session: OWNER, id: P.veronika, body: { target: 'photo' }, ...upload(JPG, 'IMG_1.HEIC'), now: NOW });
  assert.equal(st.uploads.length, 1);
  assert.equal(st.uploads[0].file.mimetype, 'image/jpeg');
  assert.equal(st.uploads[0].file.originalFilename, 'Veronika.jpg');
  assert.equal(r.photo.id, 901);
  assert.equal(st.pub(P.veronika).photo.id, 901);
  assert.equal(st.logs.at(-1).summary, 'Nová fotka: Veronika');
});

// ── заметки ────────────────────────────────────────────────────────────────
test('заметки: добавить; править и удалять — автор или владелец', async () => {
  const st = makeStrapi();
  const a = await svc.addNote({ session: MANAGER, id: P.veronika, body: { text: 'Opozdila se 2×' } });
  assert.equal(a.notes.length, 1);
  assert.equal(a.notes[0].authorName, 'Mariia Medvedeva');
  assert.equal(a.notes[0].canEdit, true);
  assert.ok(!JSON.stringify(st.logs).includes('Opozdila'), 'текст заметки в журнал не пишется');
  const b = await svc.addNote({ session: OWNER, id: P.veronika, body: { text: 'Od listopadu junior → senior?' } });
  const ownerNote = b.notes.find((n) => n.authorName === 'Dima');
  // для управляющей заметка владельца не редактируется
  const asManager = await svc.card({ session: MANAGER, id: P.veronika, now: NOW });
  assert.equal(asManager.notes.find((n) => n.documentId === ownerNote.documentId).canEdit, false);
  await expectErr(() => svc.updateNote({ session: MANAGER, id: P.veronika, noteId: ownerNote.documentId, body: { text: 'x' } }), 403, 'note_not_yours');
  await expectErr(() => svc.deleteNote({ session: MANAGER, id: P.veronika, noteId: ownerNote.documentId }), 403, 'note_not_yours');
  // владелец — любую
  const mine = a.notes[0].documentId;
  const u = await svc.updateNote({ session: OWNER, id: P.veronika, noteId: mine, body: { text: 'Opozdila se 3×' } });
  assert.equal(u.notes.find((n) => n.documentId === mine).text, 'Opozdila se 3×');
  // заметка другой карточки по этому пути — 404
  await expectErr(() => svc.deleteNote({ session: OWNER, id: P.yana, noteId: mine }), 404, 'note_not_found');
  const d = await svc.deleteNote({ session: MANAGER, id: P.veronika, noteId: mine });
  assert.equal(d.notes.length, 1);
  await expectErr(() => svc.addNote({ session: OWNER, id: P.veronika, body: { text: '  ' } }), 400, 'note_required');
});

test('схема: новые коллекции без REST-роутов, личные данные не обязательны', () => {
  for (const api of ['staff-document', 'staff-note']) {
    assert.ok(!fs.existsSync(path.join(root, `src/api/${api}/routes`)), `${api}: REST-роутов быть не должно`);
    assert.ok(!fs.existsSync(path.join(root, `src/api/${api}/controllers`)), `${api}: контроллера быть не должно`);
    const sch = JSON.parse(fs.readFileSync(path.join(root, `src/api/${api}/content-types/${api}/schema.json`), 'utf8'));
    assert.equal(sch.options.draftAndPublish, false);
  }
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'src/api/staff-document/content-types/staff-document/schema.json'), 'utf8'));
  assert.deepEqual(doc.attributes.kind.enum, Object.keys(S.DOC_KINDS));
  const personal = JSON.parse(fs.readFileSync(path.join(root, 'src/api/personal/content-types/personal/schema.json'), 'utf8'));
  assert.ok(!personal.attributes.oficial.required);
  assert.equal(personal.attributes.hiredAt.type, 'date');
  const oficial = JSON.parse(fs.readFileSync(path.join(root, 'src/components/content/oficial-data.json'), 'utf8'));
  for (const [k, a] of Object.entries(oficial.attributes)) assert.ok(!a.required, `${k} required`);
  for (const k of Object.keys(S.PRIVATE_FIELDS)) assert.ok(oficial.attributes[k], `поле ${k} есть в компоненте`);
});

// ── шаг 4 (s225): новый сотрудник, учётка, переименование, уход, стирание ───
const bcrypt = require('bcryptjs');

test('normalizeName / assertNameFree / genPassword', () => {
  assert.equal(S.normalizeName('  Nataliia   Hobedashvilu '), 'Nataliia Hobedashvilu');
  assert.equal(S.normalizeName("Zlata O'Neil-Nováková"), "Zlata O'Neil-Nováková");
  assert.equal(S.normalizeName('Юлия Попченко'), 'Юлия Попченко');
  for (const [bad, code] of [['', 'name_required'], ['  ', 'name_required'], ['A', 'bad_name'], ['x'.repeat(61), 'bad_name'],
    ['❌ Olga', 'bad_name'], ['Olga ❌', 'bad_name'], ['Ann/1', 'bad_name'], ['-Ann', 'bad_name'], ['Ann<script>', 'bad_name'], [{ $ne: 1 }, 'bad_name']]) {
    assert.throws(() => S.normalizeName(bad), (e) => e.code === code, String(bad));
  }
  const cards = [{ documentId: 'a', name: 'Veronika' }];
  const accs = [{ id: 1, username: 'sexybitch' }];
  assert.throws(() => S.assertNameFree('VERONIKA', cards, accs), (e) => e.code === 'name_taken' && e.status === 409);
  assert.throws(() => S.assertNameFree('SexyBitch', cards, accs), (e) => e.code === 'name_taken');
  S.assertNameFree('veronika', cards, accs, { exceptDocId: 'a' }); // смена регистра своего имени
  S.assertNameFree('sexybitch', [], accs, { exceptAccountId: 1 });
  // пароль: 12 символов из алфавита без похожих, есть строчная/заглавная/цифра
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pw = S.genPassword();
    assert.match(pw, /^[a-km-zA-HJ-NP-Z2-9]{12}$/);
    assert.ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw), pw);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
  // генератор, дающий сначала одни строчные, — перебирает, пока не будет всех трёх видов
  let n = 0;
  const pw = S.genPassword((max) => (n++ < 12 ? 0 : n % max));
  assert.ok(/[A-Z]/.test(pw) && /\d/.test(pw));
});

test('s229 §5а.2: зарплатная группа в секции «Оплата» — формат, связки, журнал; запрета имён больше нет', () => {
  assert.equal(S.PAYROLL_LOCKED_NAMES, undefined, 'список имён снят — группы в карточке');
  // карточка читает поля группы (заглушка базы отдаёт всё — поэтому проверка по исходнику)
  const svcSrc = fs.readFileSync(path.join(root, 'src/api/booking-engine/services/staff.ts'), 'utf8');
  const cardFields = /const CARD_FIELDS = \[([\s\S]*?)\];/.exec(svcSrc)?.[1] || '';
  for (const f of ['dualRole', 'dualRoleUntil', 'managerSince']) assert.ok(cardFields.includes(`'${f}'`), `CARD_FIELDS без ${f}`);
  assert.equal(S.isNameLocked, undefined);
  const mgr = { position: 'manager', dualRole: 'yes', dualRoleUntil: '2026-06', managerSince: null };
  assert.deepEqual(S.payrollGroupOf(mgr), { dualRole: true, dualRoleUntil: '2026-06', managerSince: null });
  assert.deepEqual(S.payrollGroupOf({ dualRole: 'no', dualRoleUntil: '2026-13', managerSince: 'x' }), { dualRole: false, dualRoleUntil: null, managerSince: null });
  // управляющая с месяца
  let r = S.normalizePay({ managerSince: '2026-10' }, mgr);
  assert.deepEqual(r.patch, { managerSince: '2026-10' });
  assert.deepEqual(r.changes, [{ key: 'managerSince', from: null, to: '2026-10' }]);
  assert.equal(S.changeParts(r.changes)[0], 'vedoucí od: — → 2026-10');
  // снять совмещение — «до» снимается вместе с ним
  r = S.normalizePay({ dualRole: false }, mgr);
  assert.deepEqual(r.patch, { dualRole: null, dualRoleUntil: null });
  assert.deepEqual(S.changeParts(r.changes), ['souběh mistr + administrátor: ano → ne', 'souběh do: 2026-06 → —']);
  // без изменений — пустой список
  assert.deepEqual(S.normalizePay({ dualRole: true, dualRoleUntil: '2026-06' }, mgr).changes, []);
  // совмещение без «до» (Oleksandra)
  r = S.normalizePay({ dualRole: true }, { position: 'administrator' });
  assert.deepEqual([r.patch, r.changes.length], [{ dualRole: 'yes' }, 1]);
  const bad = (data, cur, code) => assert.throws(() => S.normalizePay(data, cur), (e) => e.code === code, JSON.stringify(data));
  bad({ dualRole: 'yes' }, mgr, 'bad_dual_role');
  bad({ dualRoleUntil: '2026-6' }, mgr, 'bad_month');
  bad({ dualRoleUntil: '1999-01' }, mgr, 'bad_month');
  bad({ managerSince: '2026-13' }, mgr, 'bad_month');
  bad({ dualRoleUntil: '2026-06' }, { position: 'master' }, 'bad_month');
  bad({ dualRole: false, dualRoleUntil: '2026-06' }, mgr, 'bad_month');
  bad({ managerSince: '2026-10' }, { position: 'master' }, 'not_manager');
  bad({ name: 'x' }, mgr, 'bad_field');
  // снять «управляющая с» можно при любой должности
  assert.deepEqual(S.normalizePay({ managerSince: '' }, { position: 'master', managerSince: '2026-10' }).patch, { managerSince: null });
});

test('normalizeCreate: обязательны имя и должность; доля — только мастеру; ставка — с текущего месяца', () => {
  const T = '2026-10-05';
  const min = S.normalizeCreate({ name: ' Anna  Nová ', position: 'administrator' }, T);
  assert.deepEqual(min, { name: 'Anna Nová', position: 'administrator', tier: 'senior', hiredAt: T, ratePercent: null, rate: null, private: null, account: true });
  const full = S.normalizeCreate({
    name: 'Kira', position: 'master', tier: 'junior', hiredAt: '2026-10-12', ratePercent: '40',
    rate: { typeWork: 'dpp', rate: 170, from: '2026-10-01' }, private: { phone: '777 111 222', email: '', name: null }, account: false,
  }, T);
  assert.equal(full.tier, 'junior');
  assert.equal(full.ratePercent, 40);
  assert.deepEqual(full.rate, { typeWork: 'dpp', rate: 170, hourlyRate: null, from: '2026-10-01', to: null });
  assert.equal(full.private.phone, '+420777111222');
  assert.equal(full.private.email, '', 'пустые поля формы — пусто');
  assert.equal(full.account, false);
  assert.equal(S.normalizeCreate({ name: 'Kira', position: 'master', private: { phone: '' } }, T).private, null);
  for (const [body, code] of [
    [null, 'bad_data'],
    [{ position: 'master' }, 'name_required'],
    [{ name: 'Kira' }, 'bad_position'],
    [{ name: 'Kira', position: 'owner' }, 'bad_position'],
    [{ name: 'Kira', position: 'constructor' }, 'bad_position'],
    [{ name: 'Kira', position: 'administrator', tier: 'junior' }, 'bad_tier'],
    [{ name: 'Kira', position: 'administrator', ratePercent: 40 }, 'bad_field'],
    [{ name: 'Kira', position: 'master', ratePercent: 101 }, 'bad_percent'],
    [{ name: 'Kira', position: 'master', rate: { typeWork: 'dpp', rate: 170, from: '2026-09-30' } }, 'rate_in_past'],
    [{ name: 'Kira', position: 'master', hiredAt: '2014-12-31' }, 'bad_date'],
    [{ name: 'Kira', position: 'master', private: { documents: [1] } }, 'bad_field'],
    [{ name: 'Kira', position: 'master', private: 'x' }, 'bad_data'],
    [{ name: 'Kira', position: 'master', isActive: false }, 'bad_field'],
    [{ name: 'Kira', position: 'master', oficial: {} }, 'bad_field'],
    [{ name: 'Kira', position: 'master', account: 'yes' }, 'bad_field'],
  ]) {
    assert.throws(() => S.normalizeCreate(body, T), (e) => e.code === code, `${JSON.stringify(body)} → ${code}`);
  }
});

test('normalizeLeftAt / planLeave / eraseDueDate', () => {
  const T = '2026-10-05';
  assert.equal(S.normalizeLeftAt('', null, T), T);
  assert.equal(S.normalizeLeftAt('2026-08-31', '2025-01-01', T), '2026-08-31');
  assert.throws(() => S.normalizeLeftAt('2026-10-06', null, T), (e) => e.code === 'leave_in_future');
  assert.throws(() => S.normalizeLeftAt('2024-12-31', '2025-01-01', T), (e) => e.code === 'bad_date');
  assert.throws(() => S.normalizeLeftAt('2026-02-30', null, T), (e) => e.code === 'bad_date');
  const rates = [
    { id: 1, typeWork: 'dpp', rate: '150', hourlyRate: null, from: '2025-01-01', to: '2025-12-31' },
    { id: 2, typeWork: 'dpp', rate: '170', hourlyRate: null, from: '2026-01-01', to: null },
  ];
  const r = S.planLeave(rates, '2026-09-30');
  assert.deepEqual(r.rates.map((x) => [x.id, x.to]), [[1, '2025-12-31'], [2, '2026-09-30']]);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].wasTo, null);
  // закрытая позже даты ухода — подрезается; закрытая раньше — не трогается
  const r2 = S.planLeave([{ id: 3, typeWork: 'hpp', rate: '19011', from: '2026-01-01', to: '2026-12-31' }], '2026-10-05');
  assert.equal(r2.rates[0].to, '2026-10-05');
  assert.throws(() => S.planLeave(rates, '2025-12-31'), (e) => e.code === 'rate_after_leave' && e.status === 409);
  assert.deepEqual(S.planLeave([], '2026-10-05'), { rates: [], closed: [] });
  assert.equal(S.eraseDueDate('2023-10-05'), '2026-10-05');
  assert.equal(S.eraseDueDate('2024-02-29'), '2027-02-28');
  assert.equal(S.eraseDueDate(null), null);
  assert.equal(S.eraseDueDate('ерунда'), null);
});

test('новый мастер: обе версии, ключ колонки = documentId, место в конце, учётка с хэшем, пароль один раз', async () => {
  const st = makeStrapi();
  const r = await svc.create({
    session: MANAGER,
    body: { name: '  Kira   Nová ', position: 'master', tier: 'junior', ratePercent: 40, private: { phone: '777 111 222' } },
    now: NOW,
  });
  const id = r.documentId;
  assert.equal(r.name, 'Kira Nová');
  assert.equal(r.tier, 'junior');
  assert.equal(r.booking.noonaEmployeeId, id);
  assert.equal(r.booking.calendarOrder, 6, 'max(5) + 1');
  assert.equal(r.hiredAt, '2026-10-05', 'по умолчанию — сегодня');
  assert.equal(r.pay.ratePercent, 40);
  for (const v of [st.draft(id), st.pub(id)]) {
    assert.equal(v.isActive, true, 'isActive явно');
    assert.equal(v.noonaEmployeeId, id);
    assert.equal(v.bookingPriority, 0);
    assert.equal(v.oficial.phone, '+420777111222');
  }
  const create = st.calls.find((c) => c[0] === 'create' && c[1] === 'api::personal.personal');
  assert.equal(create[3], 'published');
  const acc = st.accounts.find((a) => a.username === 'Kira Nová');
  assert.equal(acc.role, 'master');
  assert.equal(acc.isActive, true);
  assert.match(acc.password, /^\$2[aby]\$10\$/, 'в базу — только хэш');
  assert.ok(bcrypt.compareSync(r.password, acc.password), 'пароль из ответа подходит');
  assert.equal(acc.personalDocId, id, 's229: учётка сразу связана с карточкой');
  assert.deepEqual(r.account, { id: acc.id, username: 'Kira Nová', role: 'master', isActive: true, linked: true });
  assert.deepEqual(r.flags, ['no_services', 'no_schedule', 'private_incomplete'], 'чек-лист «что осталось»');
  assert.equal(st.logs.length, 1);
  assert.equal(st.logs[0].action, 'staff_create');
  assert.equal(st.logs[0].summary, 'Nový zaměstnanec: Kira Nová · mistr · junior · nástup 05.10.2026 · podíl 40 % · osobní údaje vyplněny · přístup: master');
  const log = JSON.stringify(st.logs);
  assert.ok(!log.includes(r.password) && !log.includes('777'), 'ни пароля, ни личных данных в журнале');
  // повтор — имя занято (карточкой и логином, без учёта регистра)
  await expectErr(() => svc.create({ session: MANAGER, body: { name: 'kira nová', position: 'master' }, now: NOW }), 409, 'name_taken');
  await expectErr(() => svc.create({ session: MANAGER, body: { name: 'SEXYBITCH', position: 'administrator' }, now: NOW }), 409, 'name_taken');
});

test('новый администратор: ставка, без учётки; сбой учётки откатывает карточку', async () => {
  const st = makeStrapi();
  const r = await svc.create({
    session: OWNER,
    body: { name: 'Anna', position: 'administrator', rate: { typeWork: 'dpp', rate: 170, from: '2026-10-01' }, account: false },
    now: NOW,
  });
  assert.equal(r.password, null);
  assert.equal(r.account, null);
  assert.equal(r.booking.noonaEmployeeId, null, 'не мастеру колонка не нужна');
  assert.equal(r.pay.currentRate.rate, 170);
  assert.equal(st.pub(r.documentId).rates[0].rate, 170);
  assert.ok(r.flags.includes('no_account'));
  assert.ok(!st.calls.some((c) => c[0] === 'update'), 'не мастеру второй записи нет');

  // сбой при создании учётки — карточки не остаётся, повтор с тем же именем возможен
  const accountsBefore = st.accounts.length;
  const real = globalThis.strapi.documents;
  globalThis.strapi.documents = (uid) => (uid === 'api::admin-user.admin-user' ? { create: async () => { throw new Error('db down'); } } : real(uid));
  await assert.rejects(() => svc.create({ session: OWNER, body: { name: 'Bella', position: 'master' }, now: NOW }), /db down/);
  globalThis.strapi.documents = real;
  assert.ok(!st.store['api::personal.personal'].some((p) => p.name === 'Bella'), 'обе версии удалены');
  assert.equal(st.accounts.length, accountsBefore);
  const again = await svc.create({ session: OWNER, body: { name: 'Bella', position: 'master' }, now: NOW });
  assert.equal(again.name, 'Bella');
});

test('учётка: создать / отключить (сессия гаснет) / включить / сбросить пароль; себя, владельца, ушедшего — нельзя', async () => {
  const st = makeStrapi();
  // создать — у Yana учётки нет
  const c = await svc.account({ session: MANAGER, id: P.yana, body: { action: 'create' }, now: NOW });
  const yana = st.accounts.find((a) => a.username === 'Yana');
  assert.equal(yana.role, 'master');
  assert.ok(bcrypt.compareSync(c.password, yana.password));
  assert.equal(c.account.username, 'Yana');
  await expectErr(() => svc.account({ session: MANAGER, id: P.yana, body: { action: 'create' }, now: NOW }), 409, 'account_exists');
  // отключить
  globalThis.__invalidated = [];
  const d = await svc.account({ session: MANAGER, id: P.veronika, body: { action: 'disable' }, now: NOW });
  assert.equal(d.account.isActive, false);
  assert.equal(st.accounts.find((a) => a.id === 3).isActive, false);
  assert.deepEqual(globalThis.__invalidated, [3], 'кэш учётки сброшен');
  const again = await svc.account({ session: MANAGER, id: P.veronika, body: { action: 'disable' }, now: NOW });
  assert.equal(again.unchanged, true);
  // включить (Olga — карточка активна, учётка отключена)
  const e = await svc.account({ session: MANAGER, id: P.olga, body: { action: 'enable' }, now: NOW });
  assert.equal(e.account.isActive, true);
  // сброс пароля
  const oldHash = st.accounts.find((a) => a.id === 3).password;
  const p = await svc.account({ session: OWNER, id: P.veronika, body: { action: 'reset_password' }, now: NOW });
  const newHash = st.accounts.find((a) => a.id === 3).password;
  assert.notEqual(newHash, oldHash);
  assert.ok(bcrypt.compareSync(p.password, newHash));
  assert.ok(!JSON.stringify(st.logs).includes(p.password));
  assert.deepEqual(st.logs.map((l) => l.summary.split(':')[0]), [
    'Nový přístup do administrace', 'Přístup do administrace vypnut', 'Přístup do administrace zapnut', 'Nové heslo do administrace',
  ]);
  // запреты
  await expectErr(() => svc.account({ session: MANAGER, id: P.mariia, body: { action: 'disable' }, now: NOW }), 409, 'self_account');
  await expectErr(() => svc.account({ session: MANAGER, id: P.dima, body: { action: 'disable' }, now: NOW }), 404, 'staff_not_found');
  await expectErr(() => svc.account({ session: OWNER, id: P.dima, body: { action: 'reset_password' }, now: NOW }), 409, 'owner_account');
  await expectErr(() => svc.account({ session: OWNER, id: P.newbie, body: { action: 'disable' }, now: NOW }), 404, 'account_not_found');
  for (const action of ['', 'role', 'delete', 'constructor']) {
    await expectErr(() => svc.account({ session: OWNER, id: P.veronika, body: { action }, now: NOW }), 400, 'bad_action');
  }
  st.draft(P.olga).isActive = false;
  await expectErr(() => svc.account({ session: OWNER, id: P.olga, body: { action: 'enable' }, now: NOW }), 409, 'staff_left');
  await expectErr(() => svc.account({ session: OWNER, id: P.olga, body: { action: 'reset_password' }, now: NOW }), 409, 'staff_left');
  // ушедшему можно только отключить
  const off = await svc.account({ session: OWNER, id: P.olga, body: { action: 'disable' }, now: NOW });
  assert.equal(off.account.isActive, false);
});

test('переименование: карточка (обе версии) + логин одним действием; запреты; откат при сбое логина', async () => {
  const st = makeStrapi();
  globalThis.__invalidated = [];
  const base = st.draft(P.veronika).updatedAt;
  const r = await svc.rename({ session: MANAGER, id: P.veronika, body: { name: ' Veronika   Nováková ', base }, now: NOW });
  assert.equal(r.name, 'Veronika Nováková');
  assert.equal(r.accountRenamed, true);
  assert.equal(st.pub(P.veronika).name, 'Veronika Nováková');
  assert.equal(st.accounts.find((a) => a.id === 3).username, 'Veronika Nováková');
  assert.deepEqual(globalThis.__invalidated, [3], 'сессия со старым логином гаснет');
  assert.deepEqual(r.account, { id: 3, username: 'Veronika Nováková', role: 'master', isActive: true, linked: false });
  assert.equal(st.logs.at(-1).summary, 'Přejmenování: Veronika Nováková · Veronika → Veronika Nováková · login změněn');
  // устаревшая base
  await expectErr(() => svc.rename({ session: MANAGER, id: P.veronika, body: { name: 'X Y', base }, now: NOW }), 409, 'staff_changed');
  const b = () => st.draft(P.veronika).updatedAt;
  // то же имя — без записи
  const n = st.calls.length;
  assert.equal((await svc.rename({ session: MANAGER, id: P.veronika, body: { name: 'Veronika Nováková', base: b() }, now: NOW })).unchanged, true);
  assert.equal(st.calls.slice(n).filter((c) => c[0] === 'update').length, 0);
  await expectErr(() => svc.rename({ session: MANAGER, id: P.veronika, body: { name: 'yana', base: b() }, now: NOW }), 409, 'name_taken');
  await expectErr(() => svc.rename({ session: MANAGER, id: P.veronika, body: { name: 'Sexybitch', base: b() }, now: NOW }), 409, 'name_taken');
  await expectErr(() => svc.rename({ session: MANAGER, id: P.mariia, body: { name: 'Mariia M', base: st.draft(P.mariia).updatedAt }, now: NOW }), 409, 'self_rename');
  await expectErr(() => svc.rename({ session: OWNER, id: P.dima, body: { name: 'Dmitrij', base: st.draft(P.dima).updatedAt }, now: NOW }), 409, 'self_rename');
  await expectErr(() => svc.rename({ session: OWNER2, id: P.dima, body: { name: 'Dmitrij', base: st.draft(P.dima).updatedAt }, now: NOW }), 409, 'owner_account');
  await expectErr(() => svc.rename({ session: OWNER, id: P.yana, body: { name: '❌ Yana', base: st.draft(P.yana).updatedAt }, now: NOW }), 400, 'bad_name');
  // без учётки — только карточка
  const y = await svc.rename({ session: OWNER, id: P.yana, body: { name: 'Yana Ková', base: st.draft(P.yana).updatedAt }, now: NOW });
  assert.equal(y.accountRenamed, false);
  assert.equal(y.name, 'Yana Ková');
  // сбой записи логина — имя карточки возвращается
  const q = globalThis.strapi.db.query;
  globalThis.strapi.db.query = (uid) => ({ ...q(uid), update: async () => { throw new Error('unique violation'); } });
  await assert.rejects(
    () => svc.rename({ session: OWNER, id: P.olga, body: { name: 'Olga E', base: st.draft(P.olga).updatedAt }, now: NOW }),
    /unique violation/
  );
  globalThis.strapi.db.query = q;
  assert.equal(st.draft(P.olga).name, 'Olga Eremina');
  assert.equal(st.pub(P.olga).name, 'Olga Eremina');
  assert.equal(st.accounts.find((a) => a.id === 5).username, 'Olga Eremina');
  // ушедшего не переименовывают
  st.draft(P.olga).isActive = false;
  await expectErr(() => svc.rename({ session: OWNER, id: P.olga, body: { name: 'Olga E', base: st.draft(P.olga).updatedAt }, now: NOW }), 409, 'staff_left');
});

test('завершить работу: предпросмотр, запрет при бронях, карточка/учётка/ставки/блоки плана', async () => {
  const st = makeStrapi();
  st.store['api::booking.booking'].push(
    { documentId: 'b1', status: 'active', date: '2026-10-07', startsAt: '2026-10-07T08:00:00.000Z', clientNameRaw: 'Klára', employee: { documentId: P.veronika } }
  );
  const KEY = `own|plan|${P.veronika}`;
  st.store['api::time-block.time-block'].push(
    { documentId: 'tb-past', noonaKey: KEY, date: '2026-10-04' },
    { documentId: 'tb-today', noonaKey: KEY, date: '2026-10-05' },
    { documentId: 'tb-next', noonaKey: KEY, date: '2026-10-10' },
    { documentId: 'tb-own', noonaKey: 'own|abc', date: '2026-10-10' },
    { documentId: 'tb-other', noonaKey: `own|plan|${P.yana}`, date: '2026-10-10' }
  );
  const pre = await svc.leavePreview({ session: MANAGER, id: P.veronika, now: NOW });
  assert.deepEqual(pre.blockers, ['future_bookings']);
  assert.deepEqual(pre.bookings.map((b) => b.documentId), ['b1']);
  assert.equal(pre.planBlocks, 2);
  assert.deepEqual(pre.openRates.map((r) => r.rate), [150]);
  assert.equal(pre.account.username, 'Veronika');
  const base = st.draft(P.veronika).updatedAt;
  await assert.rejects(
    () => svc.leave({ session: MANAGER, id: P.veronika, body: { base }, now: NOW }),
    (e) => e.code === 'future_bookings' && e.status === 409 && e.details.bookings.length === 1
  );
  assert.equal(st.draft(P.veronika).isActive, true, 'ничего не записано');
  assert.equal(st.accounts.find((a) => a.id === 3).isActive, true);

  st.store['api::booking.booking'][0].status = 'cancelled';
  await expectErr(() => svc.leave({ session: MANAGER, id: P.veronika, body: { base, leftAt: '2026-10-06' }, now: NOW }), 400, 'leave_in_future');
  globalThis.__invalidated = [];
  const r = await svc.leave({ session: MANAGER, id: P.veronika, body: { base }, now: NOW });
  assert.equal(r.isActive, false);
  assert.equal(r.left, true);
  assert.equal(r.leftAt, '2026-10-05');
  assert.equal(r.planBlocksDeleted, 2);
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) {
    assert.equal(v.isActive, false);
    assert.equal(v.leftAt, '2026-10-05');
    assert.deepEqual(v.rates.map((x) => [x.id, x.to]), [[11, '2026-10-05']], 'ставка закрыта датой ухода, id прежний');
  }
  assert.equal(st.accounts.find((a) => a.id === 3).isActive, false);
  assert.deepEqual(globalThis.__invalidated, [3]);
  assert.deepEqual(st.store['api::time-block.time-block'].map((b) => b.documentId), ['tb-past', 'tb-own', 'tb-other']);
  assert.deepEqual(r.flags, [], 'ушедшему бейджей нет');
  assert.deepEqual(r.erase, { dueAt: '2029-10-05', due: false, erasedAt: null });
  assert.equal(st.logs.at(-1).action, 'staff_leave');
  assert.equal(st.logs.at(-1).summary, 'Ukončení spolupráce: Veronika · od 05.10.2026 · DPP 150 Kč/h do 05.10.2026 · přístup vypnut · bloky plánu: −2');
  // повтор, себе, владельцу, ставка после ухода
  await expectErr(() => svc.leave({ session: MANAGER, id: P.veronika, body: { base: st.draft(P.veronika).updatedAt }, now: NOW }), 409, 'staff_left');
  assert.deepEqual((await svc.leavePreview({ session: MANAGER, id: P.veronika, now: NOW })).blockers, ['staff_left']);
  await expectErr(() => svc.leave({ session: MANAGER, id: P.mariia, body: { base: st.draft(P.mariia).updatedAt }, now: NOW }), 409, 'self_leave');
  await expectErr(() => svc.leave({ session: OWNER2, id: P.dima, body: { base: st.draft(P.dima).updatedAt }, now: NOW }), 409, 'owner_account');
  await expectErr(
    () => svc.leave({ session: OWNER, id: P.mariia, body: { base: st.draft(P.mariia).updatedAt, leftAt: '2026-09-30' }, now: NOW }),
    409,
    'rate_after_leave'
  );
  // прошлой датой (Olga ушла раньше), учётка уже отключена — не трогается
  const n = st.calls.filter((c) => c[0] === 'account.update').length;
  const o = await svc.leave({ session: OWNER, id: P.olga, body: { base: st.draft(P.olga).updatedAt, leftAt: '2026-08-31' }, now: NOW });
  assert.equal(o.leftAt, '2026-08-31');
  assert.equal(st.calls.filter((c) => c[0] === 'account.update').length, n);
});

test('стирание через 3 года: личные данные, сканы, старые файлы медиатеки, заметки; остальное цело', async () => {
  const st = makeStrapi();
  const dir = path.join(tmpRoot, 'store-erase');
  fs.mkdirSync(dir, { mode: 0o700 });
  process.env.STAFF_FILES_DIR = dir;
  const stored = 'ab'.repeat(16);
  fs.writeFileSync(path.join(dir, stored), PDF);
  st.store['api::staff-document.staff-document'].push(
    { documentId: 'sd1', kind: 'passport', title: 'Pas', storedName: stored, personal: { documentId: P.veronika } },
    { documentId: 'sd2', kind: 'other', title: 'Cizí', storedName: 'cd'.repeat(16), personal: { documentId: P.yana } }
  );
  st.store['api::staff-note.staff-note'].push(
    { documentId: 'n1', text: 'tajné', personal: { documentId: P.veronika } },
    { documentId: 'n2', text: 'jiná', personal: { documentId: P.yana } }
  );
  await expectErr(() => svc.erase({ session: OWNER, id: P.veronika, body: { confirmName: 'Veronika', base: st.draft(P.veronika).updatedAt }, now: NOW }), 409, 'staff_not_left');
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) v.isActive = false;
  await expectErr(() => svc.erase({ session: OWNER, id: P.veronika, body: { confirmName: 'Veronika', base: st.draft(P.veronika).updatedAt }, now: NOW }), 409, 'left_at_missing');
  st.draft(P.veronika).leftAt = '2023-10-06';
  await expectErr(() => svc.erase({ session: OWNER, id: P.veronika, body: { confirmName: 'Veronika', base: st.draft(P.veronika).updatedAt }, now: NOW }), 409, 'erase_too_early');
  assert.equal((await svc.card({ session: OWNER, id: P.veronika, now: NOW })).erase.due, false);
  st.draft(P.veronika).leftAt = '2023-10-05';
  assert.equal((await svc.card({ session: OWNER, id: P.veronika, now: NOW })).erase.due, true);
  await expectErr(() => svc.erase({ session: OWNER, id: P.veronika, body: { confirmName: 'Veronik', base: st.draft(P.veronika).updatedAt }, now: NOW }), 400, 'confirm_mismatch');
  await expectErr(() => svc.erase({ session: OWNER, id: P.veronika, body: { base: st.draft(P.veronika).updatedAt }, now: NOW }), 400, 'confirm_mismatch');
  assert.equal(st.draft(P.veronika).oficial.documentNumber, SECRET.documentNumber, 'до подтверждения ничего не стёрто');

  st.files.get(301).provider_metadata = { fileId: 'ik-e301' };
  // файл 302 без fileId → поиск в ImageKit (заглушка: не найден) — в сеть тест не ходит
  const ikCalls = [];
  const fetchImpl = async (url) => {
    ikCalls.push(url);
    return { ok: true, status: 200, json: async () => [] };
  };
  const r = await svc.erase({ session: MANAGER, id: P.veronika, body: { confirmName: ' veronika ', base: st.draft(P.veronika).updatedAt }, now: NOW, fetchImpl });
  assert.equal(ikCalls.length, 1);
  assert.ok(ikCalls[0].startsWith('https://api.imagekit.io/v1/files?'));
  assert.deepEqual(r.erased, { documents: 1, legacyFiles: 2, notes: 1 });
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) {
    assert.equal(v.oficial.id, 71, 'компонент стёрт на месте');
    for (const k of Object.keys(S.PRIVATE_FIELDS)) assert.equal(v.oficial[k], '', k);
    assert.deepEqual(v.oficial.documents, []);
    assert.equal(v.privateErasedAt, NOW.toISOString());
    assert.equal(v.name, 'Veronika', 'имя остаётся');
    assert.equal(v.ratePercent, 40, 'деньги остаются');
    assert.deepEqual(v.rates.map((x) => x.id), [11]);
  }
  assert.ok(!fs.existsSync(path.join(dir, stored)), 'скан удалён с диска');
  assert.deepEqual(st.store['api::staff-document.staff-document'].map((d) => d.documentId), ['sd2'], 'чужие документы целы');
  assert.deepEqual(st.store['api::staff-note.staff-note'].map((d) => d.documentId), ['n2']);
  assert.deepEqual(st.removed, [301, 302], 'старые сканы удалены из медиатеки (ImageKit)');
  assert.deepEqual(st.ikDeleted, ['ik-e301'], 'и из самого ImageKit — по fileId');
  assert.equal(r.erase.erasedAt, NOW.toISOString());
  const priv = await svc.privateData({ session: OWNER, id: P.veronika });
  assert.equal(priv.missing.length, 7);
  assert.deepEqual(priv.legacyFiles, []);
  assert.equal(st.logs.at(-1).action, 'staff_erase');
  assert.equal(st.logs.at(-1).summary, 'Osobní údaje smazány: Veronika');
  assert.deepEqual(st.logs.at(-1).details, {});
  assert.ok(!JSON.stringify(st.logs).includes(SECRET.documentNumber));
});

test('схема: privateErasedAt; lifecycle не хеширует готовый хэш повторно', () => {
  const personal = JSON.parse(fs.readFileSync(path.join(root, 'src/api/personal/content-types/personal/schema.json'), 'utf8'));
  assert.equal(personal.attributes.privateErasedAt.type, 'datetime');
  assert.ok(!personal.attributes.privateErasedAt.required);
  const code = fs.readFileSync(path.join(root, 'src/api/admin-user/content-types/admin-user/lifecycles.ts'), 'utf8');
  const re = new RegExp(/const BCRYPT_HASH = \/(.+)\/\n/.exec(code)[1]);
  assert.ok(re.test(bcrypt.hashSync('x', 10)), 'хэш распознаётся');
  for (const plain of ['$2secret', '$2b$10$short', 'password']) assert.ok(!re.test(plain), plain);
  assert.match(code, /async beforeCreate[\s\S]*?if \(data\.password && !isBcryptHash\(data\.password\)\)/);
  assert.match(code, /async beforeUpdate[\s\S]*?if \(!isBcryptHash\(data\.password\)\)/);
});

// ── s227: напоминания для «Сегодня», дата ухода ушедшим ────────────────────
test('buildReminders: срок документов 30 дней и просроченные, заменённые не напоминают; стирание; ушедшие без даты', () => {
  const T = '2026-10-05';
  const cards = [
    { documentId: 'a', name: 'Anna', left: false, leftAt: null, erasedAt: null, hasPrivate: true },
    { documentId: 'b', name: 'Bára', left: false, leftAt: null, erasedAt: null, hasPrivate: true },
    { documentId: 'x', name: 'Xenie', left: true, leftAt: '2023-10-05', erasedAt: null, hasPrivate: true },
    { documentId: 'y', name: 'Yvona', left: true, leftAt: '2023-10-06', erasedAt: null, hasPrivate: true },
    { documentId: 'z', name: 'Zora', left: true, leftAt: '2020-01-01', erasedAt: '2024-01-01T00:00:00Z', hasPrivate: false },
    // стёрто, потом кто-то снова добавил заметку — повторно не напоминаем (стирание разовое)
    { documentId: 't', name: 'Tereza', left: true, leftAt: '2020-01-01', erasedAt: '2024-01-01T00:00:00Z', hasPrivate: true },
    { documentId: 'w', name: 'Wanda', left: true, leftAt: null, erasedAt: null, hasPrivate: true },
    { documentId: 'v', name: 'Vilma', left: true, leftAt: null, erasedAt: null, hasPrivate: false },
    { documentId: 'u', name: 'Uršula', left: true, leftAt: '2022-01-01', erasedAt: null, hasPrivate: false },
  ];
  const d = (documentId, personal, kind, validUntil, createdAt = '2026-01-01') => ({ documentId, personal, kind, title: kind, validUntil, createdAt });
  const docs = [
    d('d1', 'a', 'passport', '2026-11-04'), // ровно +30 — да
    d('d2', 'a', 'health', '2026-11-05'), // +31 — нет
    d('d3', 'b', 'residence', '2026-09-30'), // просрочен — да
    d('d4', 'b', 'passport', '2026-10-10'), // заменён новым паспортом — нет
    d('d5', 'b', 'passport', '2031-10-10'),
    d('d6', 'b', 'contract', '2026-10-20', '2026-01-01'), // заменён бессрочным договором, загруженным позже — нет
    d('d7', 'b', 'contract', null, '2026-06-01'),
    d('d8', 'b', 'other', '2026-10-06'), // «другой» не заменяется другим «другим»
    d('d9', 'b', 'other', '2027-10-06'),
    d('d10', 'x', 'passport', '2026-10-06'), // ушедшей — нет
    d('d11', 'a', 'license', null), // бессрочный — нет
  ];
  const r = S.buildReminders(cards, docs, T);
  assert.equal(r.horizonDays, 30);
  assert.deepEqual(r.documents.map((x) => [x.documentId, x.daysLeft]), [['d3', -5], ['d8', 1], ['d1', 30]]);
  assert.deepEqual(r.documents[0], { personal: 'b', name: 'Bára', documentId: 'd3', kind: 'residence', title: 'residence', validUntil: '2026-09-30', daysLeft: -5 });
  assert.deepEqual(r.erase, [{ personal: 'x', name: 'Xenie', leftAt: '2023-10-05', dueAt: '2026-10-05' }], 'Yvona — завтра; Zora и Tereza стёрты; Uršula — нечего стирать');
  assert.deepEqual(r.leftWithoutDate, [{ personal: 'w', name: 'Wanda' }], 'Vilma без данных не нужна');
});

test('напоминания: сервис — владелец скрыт от управляющей, признак «есть что стирать», без значений личных данных', async () => {
  const st = makeStrapi();
  for (const v of [st.draft(P.dima), st.pub(P.dima)]) v.oficial = { id: 90, name: 'Dima D.', documents: [] };
  for (const id of [P.olga, P.yana, P.newbie]) for (const v of [st.draft(id), st.pub(id)]) v.isActive = false;
  st.draft(P.olga).leftAt = '2023-09-01'; // данных нет, но есть заметка — есть что стирать
  st.draft(P.yana).leftAt = null; // имя в компоненте — есть данные, даты нет
  st.store['api::staff-note.staff-note'].push({ documentId: 'n1', text: 'x', personal: { documentId: P.olga } });
  st.store['api::staff-document.staff-document'].push(
    { documentId: 'sd1', kind: 'passport', title: 'Pas', validUntil: '2026-10-20', createdAt: '2026-01-01', personal: { documentId: P.veronika } },
    { documentId: 'sd2', kind: 'passport', title: 'Pas', validUntil: '2026-10-21', createdAt: '2026-01-01', personal: { documentId: P.dima } }
  );
  const own = await svc.reminders({ session: OWNER, now: NOW });
  assert.deepEqual(own.documents.map((x) => [x.name, x.daysLeft]), [['Veronika', 15], ['Dima', 16]]);
  assert.deepEqual(own.erase.map((x) => x.name), ['Olga Eremina']);
  assert.deepEqual(own.leftWithoutDate.map((x) => x.name), ['Yana'], 'Newbie без данных не попадает');
  const json = JSON.stringify(own);
  for (const v of [...Object.values(SECRET), 'Veronika Nováková', '09.11.1995', 'tajné']) assert.ok(!json.includes(v), `утечка: ${v}`);
  const mgr = await svc.reminders({ session: MANAGER, now: NOW });
  assert.deepEqual(mgr.documents.map((x) => x.name), ['Veronika'], 'документ владельца скрыт');
});

test('основное: дата ухода — только ушедшим, не в будущем и не раньше приёма; журнал', async () => {
  const st = makeStrapi();
  await expectErr(
    () => svc.patch({ session: OWNER, id: P.veronika, body: { section: 'basic', data: { leftAt: '2026-01-01' }, base: st.draft(P.veronika).updatedAt }, now: NOW }),
    409,
    'staff_not_left'
  );
  for (const v of [st.draft(P.olga), st.pub(P.olga)]) {
    v.isActive = false;
    v.hiredAt = '2024-02-01';
  }
  const base = () => st.draft(P.olga).updatedAt;
  for (const [leftAt, code] of [['', 'bad_date'], ['2026-10-06', 'leave_in_future'], ['2024-01-31', 'bad_date'], ['1.1.2025', 'bad_date']]) {
    await expectErr(() => svc.patch({ session: OWNER, id: P.olga, body: { section: 'basic', data: { leftAt }, base: base() }, now: NOW }), 400, code);
  }
  const r = await svc.patch({ session: MANAGER, id: P.olga, body: { section: 'basic', data: { leftAt: '2025-06-30' }, base: base() }, now: NOW });
  assert.equal(r.leftAt, '2025-06-30');
  assert.equal(st.pub(P.olga).leftAt, '2025-06-30', 'обе версии');
  assert.equal(r.erase.dueAt, '2028-06-30');
  assert.equal(st.logs.at(-1).summary, 'Karta zaměstnance upravena: Olga Eremina · odchod: — → 30.06.2025');
  await expectErr(
    () => svc.patch({ session: OWNER, id: P.olga, body: { section: 'basic', data: { hiredAt: '2025-07-01' }, base: base() }, now: NOW }),
    400,
    'bad_date'
  );
  assert.equal(S.normalizeBasic({ hiredAt: '2025-06-30' }, st.draft(P.olga), '2026-10-05').patch.hiredAt, '2025-06-30');
});

// ── s228: перенос старых сканов из медиатеки в закрытый каталог ─────────────
test('legacySizeMatches / legacyTitle', () => {
  // Strapi: КБ по 1000 байт, два знака (прод: 122582 б → 122.58)
  assert.equal(S.legacySizeMatches(122582, 122.58), true);
  assert.equal(S.legacySizeMatches(7447296, 7447.3), true);
  assert.equal(S.legacySizeMatches(122582, 119.71), false, 'КиБ (÷1024) — не наш формат');
  assert.equal(S.legacySizeMatches(1166577, 3192.55), false, 'пережатая копия CDN');
  assert.equal(S.legacySizeMatches(122590, 122.58), false);
  assert.equal(S.legacyOriginalUrl('https://ik.imagekit.io/njc0tvfgn/a%20b.jpg'), 'https://ik.imagekit.io/njc0tvfgn/a%20b.jpg?tr=orig-true');
  assert.equal(S.legacyOriginalUrl('https://ik.imagekit.io/x/p.pdf?tr=w-100'), 'https://ik.imagekit.io/x/p.pdf?tr=orig-true');
  assert.equal(S.legacyOriginalUrl('https://example.com/p.pdf'), 'https://example.com/p.pdf');
  assert.equal(S.legacySizeMatches(0, 1), false);
  assert.equal(S.legacySizeMatches(100, null), false);
  assert.equal(S.legacyTitle('Pas  Veronika.PDF'), 'Pas Veronika');
  assert.equal(S.legacyTitle('.pdf'), 'Jiný doklad');
});

test('перенос старого скана: проверка, копия в каталог, отвязка в обеих версиях, удаление из медиатеки; черновик-только не публикуется', async () => {
  const st = makeStrapi();
  const dir = path.join(tmpRoot, 'store-legacy');
  fs.mkdirSync(dir, { mode: 0o700 });
  process.env.STAFF_FILES_DIR = dir;
  // файлы медиатеки: 301 — PDF (ImageKit), 302 — JPEG с провайдером local
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(123393, 5)]);
  const jpg = Buffer.concat([JPG, Buffer.alloc(81920 - JPG.length, 2)]);
  st.files.get(301).size = +(pdf.length / 1000).toFixed(2);
  st.files.get(301).provider = 'imagekit';
  st.files.get(301).provider_metadata = { fileId: 'ik301' };
  st.files.get(302).size = +(81920 / 1000).toFixed(2);
  st.files.get(302).provider = 'local'; // так на проде у одного файла: провайдер local, лежит в ImageKit
  st.files.get(302).provider_metadata = { fileId: 'ik302' };
  st.files.get(302).formats = { thumbnail: { url: 'https://ik.imagekit.io/x/t.jpg', provider_metadata: { fileId: 'ik302t' } } };
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) {
    v.oficial.documents = v.oficial.documents.map((f) => st.files.get(f.id));
  }
  // CDN отдаёт оригинал только с tr=orig-true; по обычной ссылке — «пережатую» копию
  const bodies = {
    'https://ik.imagekit.io/x/pas.pdf?tr=orig-true': pdf,
    'https://ik.imagekit.io/x/visa.jpg?tr=orig-true': jpg,
    'https://ik.imagekit.io/x/visa.jpg': jpg.subarray(0, 40000),
  };
  const fetched = [];
  let ikList = [];
  const ikQueries = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://api.imagekit.io/v1/files?')) {
      ikQueries.push({ q: new URL(url).searchParams.get('searchQuery'), auth: init?.headers?.Authorization });
      return { ok: true, status: 200, json: async () => ikList };
    }
    fetched.push(url);
    const b = bodies[url];
    return b ? { ok: true, status: 200, arrayBuffer: async () => b } : { ok: false, status: 404 };
  };
  const run = (fileId, body = {}, session = OWNER, id = P.veronika) => svc.migrateLegacyFile({ session, id, fileId, body, fetchImpl });

  await expectErr(() => run(999), 404, 'legacy_not_found');
  await expectErr(() => run('abc'), 404, 'legacy_not_found');
  await expectErr(() => run(301, {}, OWNER, P.yana), 404, 'legacy_not_found');

  const dry = await run(301, { dryRun: true });
  assert.deepEqual(dry, { dryRun: true, fileId: 301, fileName: 'pas.pdf', title: 'pas', mime: 'application/pdf', size: pdf.length });
  assert.equal(fs.readdirSync(dir).length, 0, 'проверка ничего не пишет');
  assert.equal(st.store['api::staff-document.staff-document'].length, 0);
  assert.deepEqual(st.removed, []);

  const r = await run(301, {}, MANAGER);
  assert.equal(r.dryRun, false);
  assert.equal(r.published, true);
  assert.equal(r.removed, true);
  assert.equal(r.cdnLeft, false);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{32}$/);
  assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(path.join(dir, files[0])).equals(pdf), 'байты те же');
  const rec = st.store['api::staff-document.staff-document'][0];
  assert.deepEqual(
    { kind: rec.kind, title: rec.title, fileName: rec.fileName, mime: rec.mime, size: rec.size, storedName: rec.storedName, uploadedBy: rec.uploadedBy, personal: rec.personal },
    { kind: 'other', title: 'pas', fileName: 'pas.pdf', mime: 'application/pdf', size: pdf.length, storedName: files[0], uploadedBy: 'Mariia Medvedeva (перенос)', personal: { documentId: P.veronika } }
  );
  for (const v of [st.draft(P.veronika), st.pub(P.veronika)]) {
    assert.equal(v.oficial.id, 71, 'компонент правится на месте');
    assert.deepEqual(v.oficial.documents.map((f) => f.id), [302], 'остальные старые сканы на месте');
    assert.equal(v.oficial.documentNumber, SECRET.documentNumber, 'личные данные не тронуты');
  }
  assert.deepEqual(st.removed, [301]);
  assert.deepEqual(st.ikDeleted, ['ik301'], 'удалён в ImageKit явно — upload.remove этого не делает');
  assert.equal(st.logs.at(-1).summary, 'Dokument přenesen z knihovny médií: Veronika · pas');
  assert.ok(!JSON.stringify(st.logs.at(-1)).includes(SECRET.documentNumber));
  await expectErr(() => run(301), 404, 'legacy_not_found'); // повтор — уже перенесён

  // размер не совпал — ничего не записано и не удалено
  st.files.get(302).size = 81.93;
  st.draft(P.veronika).oficial.documents = [st.files.get(302)];
  await expectErr(() => run(302), 409, 'legacy_size_mismatch');
  await expectErr(() => run(302, { dryRun: true, acceptSizeBytes: 81921 }), 409, 'legacy_size_mismatch');
  await expectErr(() => run(302, { dryRun: true, acceptSizeBytes: '81920' }), 409, 'legacy_size_mismatch');
  assert.equal((await run(302, { dryRun: true, acceptSizeBytes: 81920 })).size, 81920, 'подтверждённый размер — ровно скачанный');
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.deepEqual(st.removed, [301]);

  // карточка без опубликованной версии: пишется только черновик, publish не зовётся; провайдер local — CDN-копия остаётся
  st.files.get(302).size = 81.92;
  st.draft(P.veronika).oficial.documents = [st.files.get(302)];
  // сбой ImageKit: скан уже в закрытом каталоге и отвязан, но запись медиатеки остаётся — видно, что CDN не чист
  st.setIkFail('ImageKit 500')
  const rFail = await run(302);
  assert.equal(rFail.removed, false);
  assert.equal(rFail.cdnLeft, true);
  assert.ok(st.files.has(302), 'запись медиатеки не удалена, пока CDN не удалён');
  st.setIkFail(null);
  // повтор по тому же файлу: запись медиатеки есть, в карточке уже отвязан → 404; проверяем удаление отдельно
  st.draft(P.veronika).oficial.documents = [st.files.get(302)];
  const pubIdx0 = st.store['api::personal.personal'].findIndex((x) => x.documentId === P.veronika && x.published);
  if (pubIdx0 >= 0) st.store['api::personal.personal'].splice(pubIdx0, 1);
  const publishesBefore = st.calls.filter((c) => c[0] === 'publish').length;
  const r2 = await run(302);
  assert.equal(r2.published, false);
  assert.equal(r2.cdnLeft, false, 'провайдер local, но fileId есть — удалён в ImageKit');
  assert.deepEqual(st.ikDeleted, ['ik301', 'ik302', 'ik302t'], 'вместе с уменьшенной копией');
  // файл без fileId (старый local) — из медиатеки удалён, но CDN-копию искать руками
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(992, 3)]);
  st.files.set(305, { id: 305, name: 'old.png', mime: 'image/png', size: 1, url: 'https://ik.imagekit.io/x/old.png', provider: 'local' });
  bodies['https://ik.imagekit.io/x/old.png?tr=orig-true'] = png;
  st.draft(P.veronika).oficial.documents = [st.files.get(305)];
  const r3 = await run(305);
  assert.equal(r3.removed, true);
  assert.equal(r3.cdnLeft, true, 'без fileId удалить в ImageKit нечем');
  assert.equal(st.ikDeleted.length, 3);

  // метаданные старого формата (Cloudinary public_id): fileId ищется в ImageKit по точному пути ссылки
  const pdf2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(991, 4)]);
  const clUrl = 'https://ik.imagekit.io/njc0tvfgn/strapi-uploads/Dohoda%20o.pdf';
  st.files.set(306, { id: 306, name: 'Dohoda o.pdf', mime: 'application/pdf', size: 1, url: clUrl, provider: 'imagekit', provider_metadata: { public_id: 'Dohoda_o', resource_type: 'image' } });
  bodies[`${clUrl}?tr=orig-true`] = pdf2;
  ikList = [
    { fileId: 'other-folder', filePath: '/jine/Dohoda o.pdf' },
    { fileId: 'found-306', filePath: '/strapi-uploads/Dohoda o.pdf' },
  ];
  st.draft(P.veronika).oficial.documents = [st.files.get(306)];
  const r4 = await run(306);
  assert.equal(r4.cdnLeft, false);
  assert.equal(st.ikDeleted.at(-1), 'found-306', 'только точное совпадение пути');
  assert.equal(ikQueries.at(-1).q, 'name = "Dohoda o.pdf"');
  assert.equal(ikQueries.at(-1).auth, `Basic ${Buffer.from('private_test:').toString('base64')}`);
  // два точных совпадения — наугад не удаляется: из медиатеки убран, CDN — руками
  st.files.set(309, { id: 309, name: 'Dohoda o.pdf', mime: 'application/pdf', size: 1, url: clUrl, provider: 'imagekit', provider_metadata: { public_id: 'x' } });
  ikList = [{ fileId: 'a', filePath: '/strapi-uploads/Dohoda o.pdf' }, { fileId: 'b', filePath: '/strapi-uploads/Dohoda o.pdf' }];
  st.draft(P.veronika).oficial.documents = [st.files.get(309)];
  const r5 = await run(309);
  assert.equal(r5.cdnLeft, true);
  assert.equal(st.ikDeleted.length, 4, 'ничего лишнего не удалено');
  assert.equal(st.calls.filter((c) => c[0] === 'publish').length, publishesBefore, 'черновик-только не публикуется');
  assert.ok(!st.pub(P.veronika), 'опубликованной версии как не было, так и нет');
  assert.deepEqual(st.draft(P.veronika).oficial.documents, []);
  assert.ok(st.store['api::staff-document.staff-document'].some((d) => d.fileName === 'visa.jpg' && d.mime === 'image/jpeg'));

  // сбой скачивания и неподдерживаемый тип
  st.files.set(303, { id: 303, name: 'x.docx', mime: 'application/msword', size: 1.02, url: 'https://ik.imagekit.io/x/x.docx', provider: 'imagekit' });
  st.files.set(304, { id: 304, name: 'gone.pdf', mime: 'application/pdf', size: 1, url: 'https://ik.imagekit.io/x/gone.pdf', provider: 'imagekit' });
  bodies['https://ik.imagekit.io/x/x.docx?tr=orig-true'] = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(1020, 1)]);
  st.draft(P.veronika).oficial.documents = [st.files.get(303), st.files.get(304)];
  await expectErr(() => run(303), 409, 'bad_file_type');
  await expectErr(() => run(304), 502, 'legacy_download_failed');
  assert.ok(fetched.every((u) => u.endsWith('?tr=orig-true')), 'всегда качается оригинал');
  assert.deepEqual(st.draft(P.veronika).oficial.documents.map((f) => f.id), [303, 304], 'при ошибке карточка не тронута');
});

// ───────────────────────── s229: связь учётки с карточкой (§5а.1) ─────────────────────────
test('s229: учётка — по связи, хоть логин и не совпадает с именем; «это вы» — по связи сессии', async () => {
  const st = makeStrapi();
  const vera = st.accounts.find((a) => a.id === 3);
  vera.username = 'Veronika Stará';
  vera.personalDocId = P.veronika;
  st.accounts.find((a) => a.id === 2).personalDocId = P.mariia;
  // одноимённая с Yana учётка, связанная с ДРУГОЙ карточкой, — не её
  st.accounts.push({ id: 7, username: 'Yana', role: 'master', isActive: true, password: 'HASH', personalDocId: 'someone-else' });

  const c = await svc.card({ session: OWNER, id: P.veronika, now: NOW });
  assert.deepEqual(c.account, { id: 3, username: 'Veronika Stará', role: 'master', isActive: true, linked: true });
  const list = await svc.list({ session: OWNER, now: NOW });
  assert.equal(list.rows.find((r) => r.documentId === P.yana).account, null, 'чужая учётка по имени не подтягивается');
  assert.deepEqual(list.rows.find((r) => r.documentId === P.veronika).account, { id: 3, role: 'master', isActive: true });
  // создать учётку Yana: логин занят учёткой другой карточки — 409, а не 500 уникальности
  await expectErr(() => svc.account({ session: OWNER, id: P.yana, body: { action: 'create' }, now: NOW }), 409, 'name_taken');

  // управляющая переименована в логине, связь та же — «это вы» и запреты себе держатся
  const mgr = { ...MANAGER, username: 'Mariia Nová', personalDocId: P.mariia };
  assert.equal((await svc.card({ session: mgr, id: P.mariia, now: NOW })).self, true);
  assert.equal((await svc.card({ session: mgr, id: P.veronika, now: NOW })).self, false);
  await expectErr(() => svc.account({ session: mgr, id: P.mariia, body: { action: 'disable' }, now: NOW }), 409, 'self_account');
  await expectErr(() => svc.leave({ session: mgr, id: P.mariia, body: { base: st.draft(P.mariia).updatedAt }, now: NOW }), 409, 'self_leave');
  // связь сессии с другой карточкой: совпадение имени больше не делает «собой»
  const other = { ...MANAGER, personalDocId: P.veronika };
  assert.equal((await svc.card({ session: other, id: P.mariia, now: NOW })).self, false);

  // переименование связанной: логин меняется, связь остаётся
  globalThis.__invalidated = [];
  const r = await svc.rename({ session: OWNER, id: P.veronika, body: { name: 'Veronika Nová', base: st.draft(P.veronika).updatedAt }, now: NOW });
  assert.equal(r.accountRenamed, true);
  assert.equal(vera.username, 'Veronika Nová');
  assert.equal(vera.personalDocId, P.veronika);
  assert.deepEqual(r.account, { id: 3, username: 'Veronika Nová', role: 'master', isActive: true, linked: true });
});
