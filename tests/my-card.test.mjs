// «Мои данные» (s231, фаза 2 карточки): GET /engine/admin/my-card — своя карточка, только чтение.
//   - карточка — по связи учётки (`personalDocId`), без связи — по имени; чужую не запросить;
//   - у владельца карточки нет — 404; учётка без связи и без совпадения имени — 404, не «первая попавшаяся»;
//   - личные данные под ключом `private` и проходят вырезание `oficial` в admin-session без изменений;
//   - документы — тип, название, срок; без storedName, имени файла, id и ссылки (сканы — только руководству);
//   - без заметок руководства, журнала, учётки; мастеру — доля, остальным — текущая ставка.
// Сервис — НАСТОЯЩИЙ staff.ts, настоящий utils/staff-identity, на маленькой заглушке базы.
//
// Запуск: cd strapi && node --test tests/my-card.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

let svcJs = toJs('src/api/booking-engine/services/staff.ts');
for (const [from, to] of [
  ["from '../../../utils/admin-account'", `from '${dataUrl('export const invalidateAdminAccount = () => {};')}'`],
  ["from '../../../utils/staff-identity'", `from '${dataUrl(toJs('src/utils/staff-identity.ts'))}'`],
  ["from './slots-core'", `from '${dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'))}'`],
  ["from 'crypto'", "from 'node:crypto'"],
  // s237: файлы — общие помощники закрытого хранилища
  ["from '../../../utils/private-files'", `from '${dataUrl(toJs('src/utils/private-files.ts'))}'`],
  ["from 'bcryptjs'", `from '${pathToFileURL(require.resolve('bcryptjs')).href}'`],
]) {
  assert.ok(svcJs.includes(from), `импорт ${from} не найден`);
  svcJs = svcJs.split(from).join(to);
}
const svc = (await import(dataUrl(svcJs))).default;

const JWT_URL = dataUrl(toJs('src/utils/admin-jwt.ts').replace(/from 'crypto'/, "from 'node:crypto'"));
const ACCOUNT_URL = dataUrl(toJs('src/utils/admin-account.ts'));
const mw = await import(
  dataUrl(
    toJs('src/middlewares/admin-session.ts')
      .replace(/from '\.\.\/utils\/admin-jwt';/, `from '${JWT_URL}';`)
      .replace(/from '\.\.\/utils\/admin-account';/, `from '${ACCOUNT_URL}';`)
  )
);

const NOW = new Date('2026-10-05T10:00:00Z');
const VERONIKA = 'veronika00000000000000001';
const YULIYA = 'yuliya0000000000000000002';
const KARINA = 'karina0000000000000000003';
const SECRET_V = { name: 'Veronika Nováková', documentNumber: 'PAS-777111', phone: '+420777000111', bankAccount: '19-2000145399/0800' };

function makeStrapi() {
  const personals = [
    {
      documentId: VERONIKA,
      name: 'Veronika',
      position: 'master',
      tier: 'senior',
      isActive: true,
      hiredAt: '2024-03-01',
      ratePercent: 40,
      photo: { id: 7, url: 'https://ik.imagekit.io/x/v.jpg', formats: null },
      rates: [{ id: 1, typeWork: 'dpp', rate: '150', from: '2025-01-01', to: null }],
      contracts: [
        { id: 11, type: 'dpp', from: '2024-03-01', to: '2025-12-31' },
        { id: 12, type: 'ico', from: '2026-01-01', to: null, ico: '27082440' },
      ],
      oficial: { id: 71, dateBirth: '09.11.1995', addressInCz: 'Tajná 12', addressInHome: 'Kyiv', email: 'v@example.com', ...SECRET_V },
      onboarding: { x: { at: 'a', by: 'b' } },
      notes: 'не должно попасть',
    },
    {
      documentId: YULIYA,
      name: 'Yuliya',
      position: 'administrator',
      isActive: true,
      hiredAt: null,
      ratePercent: null,
      photo: null,
      rates: [
        { id: 2, typeWork: 'dpp', rate: '150', from: '2025-01-01', to: '2026-09-30' },
        { id: 3, typeWork: 'hpp', rate: '19000', hourlyRate: '120', from: '2026-10-01', to: null },
      ],
      contracts: [],
      oficial: null,
    },
    { documentId: KARINA, name: 'Karina', position: 'master', isActive: true, ratePercent: 45, rates: [], contracts: [], oficial: { id: 72, phone: '+420600000000' } },
  ];
  const documents = [
    { documentId: 'd1', personal: { documentId: VERONIKA }, kind: 'passport', title: 'Pas', validUntil: '2030-01-01', storedName: 'a'.repeat(32), fileName: 'pas-scan.pdf', createdAt: '2026-01-02' },
    { documentId: 'd2', personal: { documentId: VERONIKA }, kind: 'health', title: 'ZP', validUntil: '2026-10-20', storedName: 'b'.repeat(32), fileName: 'zp.jpg', createdAt: '2026-01-01' },
    { documentId: 'd3', personal: { documentId: VERONIKA }, kind: 'residence', title: 'Pobyt', validUntil: '2026-10-01', storedName: 'c'.repeat(32), fileName: 'p.pdf', createdAt: '2025-01-01' },
    { documentId: 'd4', personal: { documentId: KARINA }, kind: 'passport', title: 'Pas Karina', validUntil: null, storedName: 'd'.repeat(32), fileName: 'k.pdf', createdAt: '2025-01-01' },
  ];
  const calls = [];
  const match = (row, filters = {}) =>
    Object.entries(filters).every(([k, c]) => {
      if (k === 'personal') return row.personal?.documentId === c.documentId.$eq;
      if (c.$eq !== undefined) return row[k] === c.$eq;
      if (c.$eqi !== undefined) return String(row[k]).toLowerCase() === String(c.$eqi).toLowerCase();
      throw new Error(`фильтр ${k} не поддержан`);
    });
  globalThis.strapi = {
    documents: (uid) => ({
      async findMany(q = {}) {
        calls.push([uid, structuredClone(q)]);
        if (uid === 'api::personal.personal') {
          assert.ok(!q.fields?.includes('notes'));
          return personals.filter((r) => match(r, q.filters)).slice(0, q.limit).map((r) => structuredClone(r));
        }
        if (uid === 'api::staff-document.staff-document') {
          // поля — как просил сервис (Strapi отдаёт только их + documentId)
          return documents
            .filter((r) => match(r, q.filters))
            .map((r) => ({ documentId: r.documentId, ...Object.fromEntries(q.fields.map((f) => [f, r[f]])) }));
        }
        throw new Error(`неожиданный uid ${uid}`);
      },
    }),
    log: { error() {}, info() {}, warn() {} },
  };
  return { calls };
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

test('мастер по связи: своя карточка, личные данные под `private`, документы без файлов, доля; без заметок/журнала/учётки', async () => {
  const st = makeStrapi();
  // логин не совпадает с именем — ищем по связи
  const r = await svc.myCard({ session: { id: 3, username: 'veronika-login', role: 'master', personalDocId: VERONIKA }, now: NOW });
  assert.equal(r.name, 'Veronika');
  assert.equal(r.private.documentNumber, SECRET_V.documentNumber);
  assert.equal(r.private.bankAccount, SECRET_V.bankAccount);
  assert.deepEqual(Object.keys(r.private).sort(), [
    'addressInCz', 'addressInHome', 'bankAccount', 'dateBirth', 'documentNumber', 'email', 'emergencyName', 'emergencyPhone', 'name', 'phone',
  ]);
  assert.deepEqual(r.documents, [
    { kind: 'passport', title: 'Pas', validUntil: '2030-01-01', state: 'ok', daysLeft: 1184 },
    { kind: 'health', title: 'ZP', validUntil: '2026-10-20', state: 'soon', daysLeft: 15 },
    { kind: 'residence', title: 'Pobyt', validUntil: '2026-10-01', state: 'expired', daysLeft: -4 },
  ]);
  for (const key of ['storedName', 'fileName', 'documentId', 'oficial', 'notes', 'history', 'account', 'onboarding', 'password']) {
    assert.ok(!hasKeyDeep(r, key), `ключа ${key} в ответе нет`);
  }
  assert.ok(!hasKeyDeep(r.documents, 'url') && !JSON.stringify(r.documents).includes('/files/'), 'ссылки на скан нет');
  assert.equal(r.contracts.current.type, 'ico');
  assert.equal(r.contracts.list.length, 2);
  assert.ok(!hasKeyDeep(r.contracts, 'id'), 'id компонентов наружу не идут');
  assert.deepEqual(r.pay, { ratePercent: 40, currentRate: null }, 'мастеру — только доля');
  assert.equal(r.hiredAt, '2024-03-01');
  assert.equal(r.photo.url, 'https://ik.imagekit.io/x/v.jpg');
  // запрос карточки — только по связи, документов — только своей
  const pq = st.calls.find(([uid]) => uid === 'api::personal.personal')[1];
  assert.deepEqual(pq.filters, { documentId: { $eq: VERONIKA } });
  const dq = st.calls.find(([uid]) => uid === 'api::staff-document.staff-document')[1];
  assert.deepEqual(dq.filters, { personal: { documentId: { $eq: VERONIKA } } });
  assert.ok(!dq.fields.includes('storedName') && !dq.fields.includes('fileName'), 'имя файла на диске даже не читается');
});

test('ответ проходит вырезание `oficial` в admin-session без изменений', async () => {
  makeStrapi();
  const r = await svc.myCard({ session: { id: 3, username: 'Veronika', role: 'master', personalDocId: VERONIKA }, now: NOW });
  const copy = structuredClone(r);
  assert.equal(mw.stripSecret(copy), false);
  assert.deepEqual(copy, r);
});

test('администратор без связи — по имени; текущая ставка HPP; карточка без личных данных — пустые строки', async () => {
  makeStrapi();
  const r = await svc.myCard({ session: { id: 5, username: 'yuliya', role: 'administrator' }, now: NOW });
  assert.equal(r.name, 'Yuliya');
  assert.deepEqual(r.pay, { ratePercent: null, currentRate: { typeWork: 'hpp', rate: 19000, hourlyRate: 120, from: '2026-10-01' } });
  assert.equal(r.private.phone, '');
  assert.deepEqual(r.documents, []);
  assert.equal(r.contracts.current, null);
  const mgr = await svc.myCard({ session: { id: 2, username: 'Yuliya', role: 'manager' }, now: NOW });
  assert.equal(mgr.name, 'Yuliya', 'управляющей — тоже (§8.4)');
});

test('чужую не получить: связь с другой карточкой побеждает имя; нет связи и имени — 404; владельцу — 404', async () => {
  makeStrapi();
  // логин «Karina», но связь — Veronika: отдаётся ТОЛЬКО связанная
  const r = await svc.myCard({ session: { id: 3, username: 'Karina', role: 'master', personalDocId: VERONIKA }, now: NOW });
  assert.equal(r.name, 'Veronika');
  assert.ok(!JSON.stringify(r).includes('Pas Karina'));
  // связь на несуществующую карточку — 404, на имя не откатываемся
  await expectErr(() => svc.myCard({ session: { id: 3, username: 'Karina', role: 'master', personalDocId: 'gone00000000000000000000' }, now: NOW }), 404, 'no_card');
  await expectErr(() => svc.myCard({ session: { id: 9, username: 'Nikdo', role: 'master' }, now: NOW }), 404, 'no_card');
  await expectErr(() => svc.myCard({ session: { id: 9, username: '', role: 'master' }, now: NOW }), 404, 'no_card');
  await expectErr(() => svc.myCard({ session: { id: 1, username: 'Veronika', role: 'owner' }, now: NOW }), 404, 'no_card');
  await expectErr(() => svc.myCard({ session: null, now: NOW }), 404, 'no_card');
});

test('docState: без срока, ок, скоро (≤ 30 дн.), истёк', async () => {
  const T = '2026-10-05';
  const S = await import(dataUrl(svcJs));
  assert.deepEqual(S.docState(null, T), { state: 'none', daysLeft: null });
  assert.deepEqual(S.docState('2026-11-04', T), { state: 'soon', daysLeft: 30 });
  assert.deepEqual(S.docState('2026-11-05', T), { state: 'ok', daysLeft: 31 });
  assert.deepEqual(S.docState('2026-10-05', T), { state: 'soon', daysLeft: 0 });
  assert.deepEqual(S.docState('2026-10-04', T), { state: 'expired', daysLeft: -1 });
});
