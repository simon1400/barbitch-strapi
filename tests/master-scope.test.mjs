// Роль master — только свои деньги (s229, план «Карточка сотрудника» §15.4).
//
//   1. middleware admin-session: мастеру из коллекций открыт БЕЛЫЙ список (календарь и
//      кабинет); денежные и прочие коллекции — 403; кастомные ручки не задеты;
//   2. `/api/personals` мастеру — только известные ключи query, без populate и без
//      фильтра/сортировки по деньгам; в ответе процент — только у своей карточки;
//   3. сервис `my-month` (кабинет мастера): карточка — всегда своя (связь / имя),
//      те же выборки, что раньше делал браузер (опубликованные, поля, даты).
//
// Запуск: cd strapi && node --test tests/master-scope.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const toJs = (code) =>
  ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const JWT_URL = dataUrl(toJs(src('src/utils/admin-jwt.ts')).replace(/from 'crypto'/, "from 'node:crypto'"));
const ACCOUNT_URL = dataUrl(toJs(src('src/utils/admin-account.ts')));
const IDENTITY_URL = dataUrl(toJs(src('src/utils/staff-identity.ts')));
const jwt = await import(JWT_URL);
const account = await import(ACCOUNT_URL);
const mw = await import(
  dataUrl(
    toJs(src('src/middlewares/admin-session.ts'))
      .replace(/from '\.\.\/utils\/admin-jwt';/, `from '${JWT_URL}';`)
      .replace(/from '\.\.\/utils\/admin-account';/, `from '${ACCOUNT_URL}';`)
  )
);
const ERR_URL = dataUrl('export class EngineError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }');
let mmJs = toJs(src('src/api/booking-engine/services/my-month.ts'));
for (const [from, to] of [
  ["from '../../../utils/staff-identity'", `from '${IDENTITY_URL}'`],
  ["from './booking-engine'", `from '${ERR_URL}'`],
]) {
  assert.ok(mmJs.includes(from), `my-month: импорт ${from} не найден`);
  mmJs = mmJs.split(from).join(to);
}
const MM = await import(dataUrl(mmJs));

// все коллекции проекта — из настоящих схем
const CONTENT_TYPES = {};
for (const dir of fs.readdirSync(path.join(root, 'src/api'))) {
  const ctDir = path.join(root, 'src/api', dir, 'content-types');
  if (!fs.existsSync(ctDir)) continue;
  for (const name of fs.readdirSync(ctDir)) {
    const schema = JSON.parse(fs.readFileSync(path.join(ctDir, name, 'schema.json'), 'utf8'));
    CONTENT_TYPES[`api::${dir}.${name}`] = { uid: `api::${dir}.${name}`, info: schema.info };
  }
}
CONTENT_TYPES['plugin::upload.file'] = { uid: 'plugin::upload.file', info: { pluralName: 'files', singularName: 'file' } };

const ROLE_IDS = { owner: 1, manager: 2, administrator: 3, master: 4 };
let ACCOUNTS;
beforeEach(() => {
  ACCOUNTS = new Map(Object.entries(ROLE_IDS).map(([role, id]) => [id, { id, role, username: `u-${role}`, isActive: true, personalDocId: null }]));
  account.invalidateAdminAccount();
});
globalThis.strapi = {
  log: { info() {}, warn() {}, error() {} },
  contentTypes: CONTENT_TYPES,
  db: { query: () => ({ findOne: async ({ where }) => ({ ...ACCOUNTS.get(where.id) }) }) },
};

async function run(role, method, pathName, { querystring = '', response = { data: [] }, username } = {}) {
  const ctx = {
    path: pathName,
    method,
    status: 200,
    body: undefined,
    state: {},
    request: {
      path: pathName,
      method,
      querystring,
      header: role ? { authorization: `Bearer ${jwt.signSession({ id: ROLE_IDS[role], username: username ?? `u-${role}`, role })}` } : {},
    },
  };
  let passed = false;
  await mw.default({}, { strapi: globalThis.strapi })(ctx, async () => {
    passed = true;
    ctx.body = typeof response === 'function' ? response() : structuredClone(response);
  });
  return { passed, status: ctx.status, code: ctx.body?.error?.code, body: ctx.body };
}

// ───────────────────────── 1. белый список коллекций ─────────────────────────
const MONEY = [
  'penalties', 'add-moneys', 'payrolls', 'services-provided', 'avanses', 'salaries', 'taxes', 'work-times',
  'costs', 'card-profits', 'extra-profits', 'cashs', 'qr-pays', 'vouchers', 'stocks', 'time-offs',
  'calendar-logs', 'client-login-tokens', 'push-subscriptions', 'loyalty-transactions', 'notes', 'users',
];
const OPEN = ['personals', 'salon-hours', 'time-blocks', 'shifts', 'salon-services'];

test('мастеру: денежные и прочие коллекции — 403; календарь и кабинет — открыты', async () => {
  for (const c of MONEY) {
    for (const p of [`/api/${c}`, `/api/${c}/abc`, `/API/${c.toUpperCase()}`]) {
      const r = await run('master', 'GET', p, { querystring: 'filters[personal][name][$eq]=Kolegyně' });
      assert.equal(r.passed, false, `master ${p} прошёл`);
      assert.equal(r.status, 403);
      assert.equal(r.code, 'forbidden_for_master');
    }
  }
  for (const c of ['salon-hours', 'time-blocks', 'shifts', 'salon-services']) {
    const r = await run('master', 'GET', `/api/${c}`, { querystring: 'filters[date][$eq]=2026-10-05' });
    assert.equal(r.passed, true, `master ${c}`);
  }
  // кастомные ручки — свои гейты, middleware их не режет
  for (const p of ['/api/engine/admin/my-month', '/api/engine/admin/calendar/day', '/api/engine/push/subscribe', '/api/admin-users/check-status/4']) {
    assert.equal((await run('master', 'GET', p)).passed, true, p);
  }
  // прежние запреты s182 — тем же кодом
  for (const c of ['bookings', 'clients', 'redemptions']) assert.equal((await run('master', 'GET', `/api/${c}`)).code, 'forbidden_for_master');
});

test('остальным ролям белый список не мешает', async () => {
  for (const role of ['owner', 'manager', 'administrator']) {
    for (const c of ['penalties', 'add-moneys', 'payrolls', 'services-provided', 'vouchers', 'costs']) {
      assert.equal((await run(role, 'GET', `/api/${c}`)).passed, true, `${role} ${c}`);
    }
  }
  // без сессии (сайт) — не наше дело
  assert.equal((await run(null, 'GET', '/api/penalties')).passed, true);
});

test('contentCollectionsOf: plural и singular типов api::*, пользователи плагина; чужие плагины — нет', () => {
  const set = mw.contentCollectionsOf(CONTENT_TYPES);
  for (const c of [...MONEY, ...OPEN, 'homepage', 'bookings']) assert.ok(set.has(c), c);
  assert.ok(!set.has('files'), 'плагин upload закрыт своим правилом');
  assert.ok(!set.has('engine'));
  // каждая коллекция белого списка существует (опечатка открыла бы... ничего, но закрыла бы экран)
  for (const c of mw.MASTER_COLLECTIONS) assert.ok(set.has(c), `нет коллекции ${c}`);
});

// ───────────────────────── 2. /api/personals мастеру ─────────────────────────
// ровно те запросы, что шлют экраны мастера (lib/personals.ts)
const CALENDAR_QUERY =
  'filters[isActive][$eq]=true&filters[position][$eq]=master&fields[0]=name&fields[1]=noonaEmployeeId&fields[2]=tier' +
  '&fields[3]=calendarOrder&fields[4]=ratePercent&pagination[pageSize]=100&status=published';
const RECIPIENTS_QUERY = 'filters[isActive][$eq]=true&fields[0]=name&fields[1]=position&pagination[pageSize]=100&status=published';

test('personals: запросы календаря проходят; populate, деньги, неизвестные ключи — 403', async () => {
  const admin = fs.readFileSync(path.join(root, '../admin/src/lib/personals.ts'), 'utf8');
  const q = (name) => {
    const m = new RegExp(`const ${name} =\\s*([\\s\\S]*?)\\n\\n`).exec(admin);
    return m[1].split('\n').map((l) => /'([^']*)'/.exec(l)?.[1] ?? '').join('').replace(/^\/api\/personals\?/, '');
  };
  assert.equal(q('QUERY'), CALENDAR_QUERY, 'запрос календаря в админке изменился — обнови белый список');
  assert.equal(q('RECIPIENTS_QUERY'), RECIPIENTS_QUERY);
  for (const qs of [CALENDAR_QUERY, RECIPIENTS_QUERY, '', 'sort[0]=calendarOrder:asc&sort[1]=name', 'filters[documentId][$in][0]=a&filters[documentId][$in][1]=b']) {
    assert.equal((await run('master', 'GET', '/api/personals', { querystring: qs })).passed, true, qs);
  }
  assert.equal((await run('master', 'GET', '/api/personals/abc', { querystring: 'fields[0]=name' })).passed, true);
  const denied = [
    'populate=*',
    'populate[offersDone][fields][0]=staffSalaries',
    'populate%5BoffersDone%5D=*',
    'filters[name][$eq]=Kolegyně&populate[penalties]=*',
    'fields[0]=excessThreshold',
    'fields=name,ratePercent,excessThreshold',
    'filters[ratePercent][$gte]=40',
    'sort=ratePercent:desc',
    'sort[0]=excessThreshold',
    'filters[$and][0][isActive][$eq]=true',
    'filters[offersDone][staffSalaries][$gt]=0',
    'filters%255BratePercent%255D%255B%2524gte%255D=40',
    'foo=bar',
  ];
  for (const qs of denied) {
    const r = await run('master', 'GET', '/api/personals', { querystring: qs });
    assert.equal(r.passed, false, `прошёл ${qs}`);
    assert.equal(r.code, 'forbidden_for_master', qs);
  }
  // oficial — прежний код s221
  assert.equal((await run('master', 'GET', '/api/personals', { querystring: 'populate=oficial' })).code, 'personal_data_closed');
  // руководство и администратор — как раньше
  for (const role of ['owner', 'manager', 'administrator']) {
    assert.equal((await run(role, 'GET', '/api/personals', { querystring: 'populate[offersDone]=*' })).passed, true, role);
  }
});

const ROWS = () => ({
  data: [
    { id: 1, documentId: 'card-me', name: 'Kira Nová', noonaEmployeeId: 'e1', tier: 'senior', calendarOrder: 1, ratePercent: 45, excessThreshold: 9000, bookingPriority: 2, hiredAt: '2025-01-01', rates: [{ rate: 1 }] },
    { id: 2, documentId: 'card-other', name: 'Lena Druhá', noonaEmployeeId: 'e2', tier: 'junior', calendarOrder: 2, ratePercent: 35, excessThreshold: 5000, offersDone: [{ staffSalaries: '500' }] },
  ],
  meta: { pagination: { total: 2 } },
});

test('personals: процент — только у своей карточки (по связи; без связи — по имени); остальным ответ не трогается', async () => {
  ACCOUNTS.get(ROLE_IDS.master).personalDocId = 'card-me';
  let r = await run('master', 'GET', '/api/personals', { querystring: CALENDAR_QUERY, response: ROWS() });
  assert.deepEqual(r.body.data[0], { id: 1, documentId: 'card-me', name: 'Kira Nová', noonaEmployeeId: 'e1', tier: 'senior', calendarOrder: 1, ratePercent: 45 });
  assert.deepEqual(r.body.data[1], { id: 2, documentId: 'card-other', name: 'Lena Druhá', noonaEmployeeId: 'e2', tier: 'junior', calendarOrder: 2 });
  assert.equal(r.body.meta.pagination.total, 2);
  // связь важнее имени: логин совпадает с чужой карточкой — процента чужой нет
  const login = (u) => {
    ACCOUNTS.get(ROLE_IDS.master).username = u;
    account.invalidateAdminAccount();
  };
  login('Lena Druhá');
  r = await run('master', 'GET', '/api/personals', { response: ROWS(), username: 'Lena Druhá' });
  assert.equal(r.passed, true, r.code);
  assert.equal(r.body.data[0].ratePercent, 45);
  assert.equal('ratePercent' in r.body.data[1], false);
  // без связи — по имени (регистр и пробелы не важны)
  ACCOUNTS.get(ROLE_IDS.master).personalDocId = null;
  login(' lena druhá ');
  r = await run('master', 'GET', '/api/personals', { response: ROWS(), username: ' lena druhá ' });
  assert.equal(r.passed, true, r.code);
  assert.equal('ratePercent' in r.body.data[0], false);
  assert.equal(r.body.data[1].ratePercent, 35);
  // одиночная карточка
  login('x');
  r = await run('master', 'GET', '/api/personals/card-other', { response: { data: ROWS().data[1] }, username: 'x' });
  assert.deepEqual(Object.keys(r.body.data).sort(), ['calendarOrder', 'documentId', 'id', 'name', 'noonaEmployeeId', 'tier']);
  for (const role of ['owner', 'manager', 'administrator']) {
    const o = await run(role, 'GET', '/api/personals', { response: ROWS() });
    assert.deepEqual(o.body, ROWS(), role);
  }
});

// ───────────────────────── 3. my-month ─────────────────────────
const FROM = '2026-08-31T22:00:00.000Z';
const TO = '2026-09-30T21:59:59.999Z';

const stubDocs = ({ cards, penalties = [], extra = [], payrolls = [] }) => {
  const calls = [];
  const rel = (rows, f) =>
    rows.filter((r) => r.personalDocId === f.personal.documentId.$eq && r.date >= f.date.$gte.slice(0, 10) && r.date <= f.date.$lte.slice(0, 10));
  return {
    calls,
    documents: (uid) => ({
      async findMany(q) {
        calls.push({ uid, ...structuredClone(q) });
        if (uid === 'api::personal.personal') {
          const f = q.filters;
          return cards.filter((c) =>
            f.documentId ? c.documentId === f.documentId.$eq : c.name.toLowerCase() === f.name.$eqi.toLowerCase()
          );
        }
        if (uid === 'api::penalty.penalty') return rel(penalties, q.filters);
        if (uid === 'api::add-money.add-money') return rel(extra, q.filters);
        if (uid === 'api::payroll.payroll') return rel(payrolls, q.filters);
        throw new Error(`неожиданный uid ${uid}`);
      },
    }),
  };
};

test('my-month: своя карточка по связи, те же выборки, что делал браузер', async () => {
  const st = stubDocs({
    cards: [
      { documentId: 'card-me', name: 'Kira Nová', noonaEmployeeId: 'e1', offersDone: [{ id: 7, documentId: 'x', date: '2026-09-03', clientName: 'A', staffSalaries: '535.5', tip: '10', price: 999 }] },
      { documentId: 'card-other', name: 'Kira Login', noonaEmployeeId: 'e2', offersDone: [{ id: 8, date: '2026-09-03', staffSalaries: '1' }] },
    ],
    penalties: [{ personalDocId: 'card-me', date: '2026-09-10', sum: '200' }, { personalDocId: 'card-other', date: '2026-09-10', sum: '999' }],
    extra: [{ id: 3, personalDocId: 'card-me', date: '2026-09-12', sum: '44', title: 'Dozápis' }],
    payrolls: [{ personalDocId: 'card-me', date: '2026-09-15', sum: '1000' }],
  });
  const svc = MM.default({ strapi: st });
  const r = await svc.get({ session: { username: 'Kira Login', role: 'master', personalDocId: 'card-me' }, from: FROM, to: TO });
  assert.deepEqual(r, {
    personal: { name: 'Kira Nová', noonaEmployeeId: 'e1', offersDone: [{ id: 7, date: '2026-09-03', clientName: 'A', staffSalaries: '535.5', tip: '10' }] },
    penalties: [{ sum: '200' }],
    extra: [{ id: 3, sum: '44', date: '2026-09-12', title: 'Dozápis' }],
    payrolls: [{ sum: '1000' }],
  });
  const card = st.calls.find((c) => c.uid === 'api::personal.personal');
  assert.equal(card.status, 'published', 'как REST: опубликованная версия');
  assert.deepEqual(card.filters, { documentId: { $eq: 'card-me' } });
  assert.deepEqual(card.fields, ['name', 'noonaEmployeeId']);
  assert.deepEqual(card.populate, { offersDone: { sort: ['date:desc'], filters: { date: { $gte: FROM, $lte: TO } }, fields: ['date', 'clientName', 'staffSalaries', 'tip'] } });
  for (const [uid, fields] of [['api::penalty.penalty', ['sum']], ['api::add-money.add-money', ['sum', 'date', 'title']], ['api::payroll.payroll', ['sum']]]) {
    const c = st.calls.find((x) => x.uid === uid);
    assert.equal(c.status, 'published', uid);
    assert.deepEqual(c.fields, fields, uid);
    assert.deepEqual(c.filters, { personal: { documentId: { $eq: 'card-me' } }, date: { $gte: FROM, $lte: TO } }, uid);
  }
});

test('my-month: без связи — по имени; карточки нет — пусто, коллекции не читаются; кривой диапазон — 400', async () => {
  const st = stubDocs({ cards: [{ documentId: 'card-me', name: 'Kira Nová', noonaEmployeeId: null, offersDone: [] }], penalties: [{ personalDocId: 'card-me', date: '2026-09-01', sum: '5' }] });
  const svc = MM.default({ strapi: st });
  const r = await svc.get({ session: { username: 'kira nová', role: 'master' }, from: FROM, to: TO });
  assert.equal(r.personal.name, 'Kira Nová');
  assert.deepEqual(r.penalties, [{ sum: '5' }]);
  const noneSt = stubDocs({ cards: [] });
  const none = MM.default({ strapi: noneSt });
  const empty = await none.get({ session: { username: 'Dima', role: 'owner' }, from: FROM, to: TO });
  assert.deepEqual(empty, { personal: null, penalties: [], extra: [], payrolls: [] });
  assert.deepEqual(noneSt.calls.map((c) => c.uid), ['api::personal.personal'], 'без карточки деньги не читаются');
  for (const [f, t] of [
    ['2026-09-01', TO],
    [FROM, 'x'],
    [TO, FROM],
    ['2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'],
    [undefined, undefined],
    [FROM + '&x', TO],
  ]) {
    await assert.rejects(() => svc.get({ session: { username: 'x', role: 'master' }, from: f, to: t }), (e) => e.status === 400 && e.code === 'bad_range', `${f} ${t}`);
  }
});

test('my-month: роут и гейт — любой сотрудник, данные только свои (исходники)', () => {
  const routes = src('src/api/booking-engine/routes/booking-engine.ts');
  assert.match(routes, /admin\('GET', '\/engine\/admin\/my-month', 'booking-engine\.adminMyMonth'\)/);
  const ctl = src('src/api/booking-engine/controllers/booking-engine.ts');
  const body = ctl.slice(ctl.indexOf('async adminMyMonth'), ctl.indexOf('async adminBirthdays'));
  assert.match(body, /requireStaff\(ctx\)/);
  assert.match(body, /myMonthSvc\(\)\.get\(\{ session, from: ctx\.query\?\.from, to: ctx\.query\?\.to \}\)/);
  assert.ok(!/employee|personal=|docId/i.test(body.replace(/personalDocId/g, '')), 'чей месяц — не из запроса');
});
