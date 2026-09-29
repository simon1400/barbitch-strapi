// «Кто я» по связи учётки с карточкой (s229, план «Карточка сотрудника» §5а.1).
//
//   1. utils/staff-identity: связь есть — карточка ТОЛЬКО по documentId (на имя не откатываемся),
//      связи нет — прежний поиск по имени без учёта регистра;
//   2. карточка сотрудника: учётка карточки — по связи, у несвязанных — по имени;
//      «это вы» — по связи из сессии;
//   3. все места, где сервер искал «себя» по имени, идут через помощник (инварианты исходников).
//
// Запуск: cd strapi && node --test tests/staff-identity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const toJs = (code) =>
  ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const I = await import(dataUrl(toJs(src('src/utils/staff-identity.ts'))));

// staff.ts — только чистые функции (тот же набор подмен, что в staff.test.mjs)
let staffJs = toJs(src('src/api/booking-engine/services/staff.ts'));
for (const [from, to] of [
  ["from '../../../utils/admin-account'", `from '${dataUrl('export const invalidateAdminAccount = () => {};')}'`],
  ["from './slots-core'", `from '${dataUrl(toJs(src('src/api/booking-engine/services/slots-core.ts')))}'`],
  ["from '../../../utils/staff-identity'", `from '${dataUrl(toJs(src('src/utils/staff-identity.ts')))}'`],
  ["from 'crypto'", "from 'node:crypto'"],
  ["from 'fs'", "from 'node:fs'"],
  ["from 'path'", "from 'node:path'"],
  ["from 'bcryptjs'", `from '${pathToFileURL(require.resolve('bcryptjs')).href}'`],
]) {
  assert.ok(staffJs.includes(from), `staff.ts: импорт ${from} не найден`);
  staffJs = staffJs.split(from).join(to);
}
const S = await import(dataUrl(staffJs));

const stubStrapi = (rows) => {
  const calls = [];
  return {
    calls,
    documents: (uid) => ({
      async findMany(q) {
        calls.push({ uid, ...q });
        return rows.filter((r) =>
          Object.entries(q.filters || {}).every(([k, cond]) => {
            if (cond && typeof cond === 'object' && '$eq' in cond) return r[k] === cond.$eq;
            if (cond && typeof cond === 'object' && '$eqi' in cond) return String(r[k]).toLowerCase() === String(cond.$eqi).toLowerCase();
            return r[k] === cond;
          })
        ).slice(0, q.limit ?? 100);
      },
    }),
  };
};

const CARDS = [
  { documentId: 'card-vika', name: 'Viktoriia Tsybuliak', position: 'administrator', noonaEmployeeId: null },
  { documentId: 'card-vera', name: 'Veronika Simonova', position: 'master', noonaEmployeeId: 'noona-vera' },
  { documentId: 'card-eva', name: 'Evelina Rishko', position: 'master', noonaEmployeeId: 'noona-eva' },
];

test('findSessionPersonal: связь — только по documentId, без связи — по имени без регистра', async () => {
  const st = stubStrapi(CARDS);
  // связь есть, логин давно другой (переименование) — карточка всё равно своя
  let r = await I.findSessionPersonal(st, { username: 'Evelina Shtaiger', personalDocId: 'card-eva' }, { fields: ['name', 'noonaEmployeeId'] });
  assert.equal(r.noonaEmployeeId, 'noona-eva');
  assert.deepEqual(st.calls.at(-1).filters, { documentId: { $eq: 'card-eva' } });
  assert.equal(st.calls.at(-1).uid, 'api::personal.personal');
  assert.deepEqual(st.calls.at(-1).fields, ['name', 'noonaEmployeeId']);
  // связь на несуществующую карточку — null, НЕ откат на имя (имя совпадает с чужой карточкой)
  r = await I.findSessionPersonal(st, { username: 'Veronika Simonova', personalDocId: 'card-gone' });
  assert.equal(r, null);
  // без связи — по имени, без регистра и лишних пробелов (как до s229)
  r = await I.findSessionPersonal(st, { username: '  veronika simonova ' });
  assert.equal(r.documentId, 'card-vera');
  assert.deepEqual(st.calls.at(-1).filters, { name: { $eqi: 'veronika simonova' } });
  // статус и доп. фильтр вызывающего сохраняются; связь их не перетирает и не перетирается ими
  r = await I.findSessionPersonal(st, { username: 'x', personalDocId: 'card-vera' }, { status: 'published', filters: { position: 'administrator' } });
  assert.equal(r, null, 'карточка мастера — не администратор');
  assert.equal(st.calls.at(-1).status, 'published');
  r = await I.findSessionPersonal(st, { username: 'x', personalDocId: 'card-vika' }, { filters: { documentId: { $eq: 'card-vera' } } });
  assert.equal(r.documentId, 'card-vika', 'фильтр «кто я» имеет приоритет над фильтром вызывающего');
  // пустая сессия / пустое имя — в базу не ходим
  const before = st.calls.length;
  assert.equal(await I.findSessionPersonal(st, null), null);
  assert.equal(await I.findSessionPersonal(st, { username: '   ' }), null);
  assert.equal(await I.findSessionPersonal(st, { username: '', personalDocId: '  ' }), null);
  assert.equal(st.calls.length, before);
  assert.equal(I.sessionPersonalDocId({ personalDocId: 42 }), '', 'только строка');
});

test('accountForCard: связь важнее имени; учётка чужой карточки по имени не берётся', () => {
  const accounts = [
    { id: 1, username: 'Evelina Shtaiger', personalDocId: 'card-eva' },
    { id: 2, username: 'Veronika Simonova', personalDocId: null },
    { id: 3, username: 'Viktoriia Tsybuliak', personalDocId: 'card-other' },
  ];
  assert.equal(S.accountForCard(CARDS[2], accounts).id, 1, 'по связи, хотя логин другой');
  assert.equal(S.accountForCard(CARDS[1], accounts).id, 2, 'без связи — по имени');
  assert.equal(S.accountForCard(CARDS[0], accounts), null, 'одноимённая учётка связана с другой карточкой');
  assert.equal(S.accountForCard({ documentId: 'x', name: '' }, accounts), null);
  assert.equal(S.accountForCard(null, accounts), null);
  // регистр и пробелы у несвязанных — как раньше
  assert.equal(S.accountForCard({ documentId: 'z', name: 'VERONIKA  simonova' }, accounts).id, 2);
});

test('isSelfCard: по связи сессии; без связи — по id учётки, без учётки — по имени', () => {
  const card = { documentId: 'card-eva', name: 'Evelina Rishko' };
  assert.equal(S.isSelfCard({ id: 9, username: 'Evelina Shtaiger', personalDocId: 'card-eva' }, card, null), true);
  assert.equal(S.isSelfCard({ id: 9, username: 'Evelina Rishko', personalDocId: 'card-other' }, card, { id: 9 }), false, 'связь решает');
  assert.equal(S.isSelfCard({ id: 9, username: 'Nobody' }, card, { id: 9 }), true);
  assert.equal(S.isSelfCard({ id: 8, username: 'Evelina Rishko' }, card, { id: 9 }), false);
  assert.equal(S.isSelfCard({ id: 8, username: 'evelina rishko' }, card, null), true);
});

test('инварианты исходников: «кто я» — только через помощник, поиска себя по имени не осталось', () => {
  const engineCtl = src('src/api/booking-engine/controllers/booking-engine.ts');
  const engineSvc = src('src/api/booking-engine/services/booking-engine.ts');
  const upsell = src('src/api/booking-engine/services/upsell.ts');
  const staff = src('src/api/booking-engine/services/staff.ts');
  const adminUser = src('src/api/admin-user/controllers/admin-user.ts');
  const jwt = src('src/utils/admin-jwt.ts');

  assert.ok(!/resolvePersonalByName/.test(engineCtl), 'старый поиск пуш-подписки по имени');
  assert.ok(!/verifySession\(tokenFromCtx\(ctx\)\)/.test(engineCtl), 'гейты движка — только через sessionFromCtx');
  assert.match(engineCtl, /resolveSessionPersonalDocId\(session\)/);
  const own = engineSvc.slice(engineSvc.indexOf('async _ownNoonaIdForSession'), engineSvc.indexOf('async _redemptionKcByBooking'));
  assert.match(own, /findSessionPersonal\(strapi, session/);
  assert.ok(!/\$eqi/.test(own), 'свои брони мастера — не по имени');
  const adm = upsell.slice(upsell.indexOf('async _adminPersonalDocId'), upsell.indexOf('async create('));
  assert.match(adm, /findSessionPersonal\(strapi, session/);
  assert.match(adm, /position: 'administrator'/, 'комиссия — только карточке администратора');
  assert.match(upsell, /this\._adminPersonalDocId\(session\)/);
  assert.match(upsell, /discount->>'adminPersonalDocId' = \?/, 'свои дозаписи — по карточке');
  assert.ok(!/accountForName/.test(staff), 'учётка карточки — через accountForCard');
  assert.ok(!/lower\(session\?\.username\) === lower\(doc\.name\)/.test(staff), '«это вы» — через isSelfCard');
  assert.match(staff, /_createAccount\(input\.name, ROLE_BY_POSITION\[input\.position\], documentId\)/);
  assert.match(staff, /_createAccount\(doc\.name, role, documentId\)/);
  assert.match(staff, /ACCOUNT_SELECT = \[[^\]]*'personalDocId'/);
  assert.match(adminUser, /linkedDocId \? \{ documentId: linkedDocId \} : \{ name: username \}/);
  assert.match(adminUser, /\.\.\.\(personalDocId \? \{ personalDocId \} : \{\}\),\n\s+\}\)/, 'связь — в подписанный токен');
  assert.match(jwt, /requireManagement = \(ctx: any\): VerifiedSession \| null => \{\n\s+const session = sessionFromCtx\(ctx\)/);
  const schema = JSON.parse(src('src/api/admin-user/content-types/admin-user/schema.json'));
  assert.deepEqual(schema.attributes.personalDocId, { type: 'string' });
  assert.ok(schema.attributes.masterPersonal, 'связь совместителя не тронута');
});
