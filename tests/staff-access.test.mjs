// Закрытие учёток и карточек сотрудников от сессий админки (s223, план
// «Карточка сотрудника» §2 / §3.6 / §3.9, шаг 1).
//
//   1. `/api/admin-users` — сессиям только вход, свой статус, кабинет администратора;
//   2. `/api/personals` — мастеру запись закрыта, остальным — три ключа экранов админки;
//   3. сессия сверяется с учёткой в базе: отключена / роль / логин сменились → 401
//      на ЛЮБОМ /api/**, в т.ч. на ручках движка (кэш 30 с, сброс при правке учётки);
//   4. путь сравнивается без учёта регистра — роутер Strapi регистр игнорирует.
//
// Гоняется НАСТОЯЩИЙ middleware (транспилированный) с настоящими подписанными
// сессиями; база — заглушка `strapi.db.query(...).findOne`, которая считает запросы.
//
// Запуск: cd strapi && node --test tests/staff-access.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = import.meta.dirname;
const src = (p) => fs.readFileSync(path.resolve(here, '..', p), 'utf8');
const toJs = (code) =>
  ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const JWT_URL = dataUrl(toJs(src('src/utils/admin-jwt.ts')).replace(/from 'crypto'/, "from 'node:crypto'"));
const ACCOUNT_URL = dataUrl(toJs(src('src/utils/admin-account.ts')));
const jwt = await import(JWT_URL);
const account = await import(ACCOUNT_URL);
const mwCode = src('src/middlewares/admin-session.ts')
  .replace(/from '\.\.\/utils\/admin-jwt';/, `from '${JWT_URL}';`)
  .replace(/from '\.\.\/utils\/admin-account';/, `from '${ACCOUNT_URL}';`);
assert.ok(!/from '\.\.\/utils\//.test(mwCode), 'в middleware остался неподменённый импорт utils');
const mw = await import(dataUrl(toJs(mwCode)));

// ── заглушка базы учёток ──
const ROLES = ['owner', 'manager', 'administrator', 'master'];
const ROLE_IDS = { owner: 1, manager: 2, administrator: 3, master: 4 };
let ACCOUNTS;
let dbCalls = 0;
let dbFail = null;
const logged = [];
const resetAccounts = () => {
  ACCOUNTS = new Map(ROLES.map((role) => [ROLE_IDS[role], { id: ROLE_IDS[role], role, username: `u-${role}`, isActive: true }]));
  dbCalls = 0;
  dbFail = null;
  account.invalidateAdminAccount();
};
globalThis.strapi = {
  log: { info() {}, warn() {}, error: (m) => logged.push(m) },
  db: {
    query: (uid) => {
      assert.equal(uid, 'api::admin-user.admin-user');
      return {
        findOne: async ({ where, select }) => {
          dbCalls += 1;
          assert.deepEqual(select.slice().sort(), ['id', 'isActive', 'role', 'username'], 'пароль не читается');
          if (dbFail) throw dbFail;
          const a = ACCOUNTS.get(where.id);
          return a ? { ...a } : null;
        },
      };
    },
  },
};
beforeEach(resetAccounts);

const token = (role, over = {}) => jwt.signSession({ id: ROLE_IDS[role], username: `u-${role}`, role, ...over });

async function run(role, method, pathName, { body, querystring = '', tokenOver, response = { data: [] } } = {}) {
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
      body,
      header: role ? { authorization: `Bearer ${token(role, tokenOver)}` } : {},
    },
  };
  const auth0 = ctx.request.header.authorization;
  let passed = false;
  await mw.default({}, { strapi: globalThis.strapi })(ctx, async () => {
    passed = true;
    ctx.body = response;
  });
  return { passed, status: ctx.status, code: ctx.body?.error?.code, reason: ctx.body?.error?.reason, ctx, auth0 };
}

// ───────────────────────── 1. учётки ─────────────────────────
test('admin-users: штатный REST закрыт всем сессиям (чтение, запись, удаление)', async () => {
  const denied = [
    ['GET', '/api/admin-users'],
    ['GET', '/api/admin-users/5'],
    ['PUT', '/api/admin-users/5'],
    ['POST', '/api/admin-users'],
    ['DELETE', '/api/admin-users/5'],
    // кастомные сегменты не тем методом / без id — попали бы в штатный `/:id`
    ['PUT', '/api/admin-users/login'],
    ['DELETE', '/api/admin-users/check-status'],
    ['GET', '/api/admin-users/check-status'],
    ['GET', '/api/admin-users/administrator-data'],
    ['GET', '/api/admin-users/login'],
    ['POST', '/api/admin-users/login/x'],
    ['GET', '/api/admin-users/check-status/5/x'],
    // пустой id: роутер (strict: false) отдал бы это штатному `GET /admin-users/:id`
    ['GET', '/api/admin-users/check-status/'],
    ['GET', '/api/admin-users/administrator-data/'],
    // регистр: роутер Strapi пускает оба варианта в тот же роут
    ['PUT', '/api/Admin-Users/5'],
    ['GET', '/api/ADMIN-USERS'],
    ['PUT', '/API/admin-users/5'],
  ];
  for (const role of ROLES) {
    for (const [method, p] of denied) {
      const r = await run(role, method, p, { body: { data: { role: 'owner', password: 'x' } } });
      assert.equal(r.passed, false, `${role} ${method} ${p} прошёл`);
      assert.equal(r.status, 403, `${role} ${method} ${p}`);
      assert.equal(r.code, 'staff_data_closed');
    }
  }
});

test('admin-users: вход, свой статус и кабинет администратора работают как раньше', async () => {
  for (const role of ROLES) {
    for (const [method, p] of [
      ['POST', '/api/admin-users/login'],
      ['GET', '/api/admin-users/check-status/3'],
      ['HEAD', '/api/admin-users/check-status/3'],
      ['GET', '/api/admin-users/administrator-data/Vika%20Tsybuliak'],
    ]) {
      const r = await run(role, method, p);
      assert.equal(r.passed, true, `${role} ${method} ${p} не прошёл (${r.code})`);
    }
  }
  // вход без сессии (обычный случай) middleware не трогает
  assert.equal((await run(null, 'POST', '/api/admin-users/login', { body: { username: 'a', password: 'b' } })).passed, true);
});

// ───────────────────────── 2. карточки ─────────────────────────
test('personals: мастер не пишет в карточки ничего', async () => {
  for (const [method, p, body] of [
    ['PUT', '/api/personals/abc', { data: { bookingPriority: 3 } }],
    ['PUT', '/api/personals/abc?status=published', { data: { calendarOrder: 10 } }],
    ['PUT', '/api/personals/abc', { data: { ratePercent: 60 } }],
    ['POST', '/api/personals', { data: { name: 'X' } }],
    ['DELETE', '/api/personals/abc', undefined],
  ]) {
    const r = await run('master', method, p, { body });
    assert.equal(r.passed, false, `master ${method} ${p}`);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'staff_data_closed');
  }
  // чтение — как было
  assert.equal((await run('master', 'GET', '/api/personals', { querystring: 'fields[0]=name' })).passed, true);
});

test('personals: руководство и администратор пишут только три ключа экранов админки', async () => {
  const allowed = [
    { data: { calendarOrder: 20 } }, // «Pořadí» календаря
    { data: { services: ['s1', 's2'] } }, // каталог
    { data: { services: [] } },
    { data: { bookingPriority: 5 } }, // приоритет мастеров
  ];
  const denied = [
    { data: { ratePercent: 99 } },
    { data: { isActive: false } },
    { data: { rates: [{ typeWork: 'hpp', rate: 500 }] } },
    { data: { excessThreshold: 0 } },
    { data: { position: 'manager' } },
    { data: { name: 'Nové jméno' } },
    { data: { noonaEmployeeId: 'x' } },
    { data: { tier: 'senior' } },
    { data: { bookingPriority: 1, ratePercent: 99 } }, // разрешённый ключ не проносит соседний
    { data: {} },
    { data: '{"ratePercent":99}' }, // multipart: data строкой
    { data: [{ bookingPriority: 1 }] },
    { data: null },
    { data: { bookingPriority: 1 }, ratePercent: 99 }, // лишний ключ верхнего уровня
    {},
    null,
    'ratePercent=99',
    JSON.parse('{"data":{"__proto__":{"ratePercent":99}}}'),
    JSON.parse('{"data":{"bookingPriority":1,"constructor":{"x":1}}}'),
  ];
  for (const role of ['owner', 'manager', 'administrator']) {
    for (const body of allowed) {
      for (const q of ['', '?status=published']) {
        const r = await run(role, 'PUT', `/api/personals/doc1${q}`, { body });
        assert.equal(r.passed, true, `${role} ${JSON.stringify(body)} не прошёл (${r.code})`);
      }
    }
    for (const body of denied) {
      const r = await run(role, 'PUT', '/api/personals/doc1', { body });
      assert.equal(r.passed, false, `${role} ${JSON.stringify(body)} прошёл`);
      assert.equal(r.status, 403);
      assert.equal(r.code, 'staff_data_closed');
    }
    for (const [method, p] of [
      ['POST', '/api/personals'],
      ['DELETE', '/api/personals/doc1'],
      ['PUT', '/api/personals'],
      ['PUT', '/api/personals/'],
      ['PUT', '/api/personals/doc1/x'],
      ['PATCH', '/api/personals/doc1'],
      ['PUT', '/api/Personals/doc1'], // регистр — тот же роут
    ]) {
      const body = method === 'PUT' && p === '/api/Personals/doc1' ? { data: { ratePercent: 99 } } : { data: { bookingPriority: 1 } };
      const r = await run(role, method, p, { body });
      assert.equal(r.passed, false, `${role} ${method} ${p} прошёл`);
      assert.equal(r.code, 'staff_data_closed');
    }
    // регистр пути не мешает разрешённой записи
    assert.equal((await run(role, 'PUT', '/api/PERSONALS/doc1', { body: { data: { calendarOrder: 1 } } })).passed, true);
  }
});

test('personals: запись oficial по-прежнему отвечает кодом s221', async () => {
  const r = await run('owner', 'PUT', '/api/personals/doc1', { body: { data: { oficial: { phone: '1' } } } });
  assert.equal(r.code, 'personal_data_closed');
});

test('соседние коллекции и ручки движка не задеты', async () => {
  for (const role of ROLES) {
    assert.equal((await run(role, 'POST', '/api/engine/admin/blocks')).passed, true);
    assert.equal((await run(role, 'GET', '/api/engine/admin/calendar/day')).passed, true);
    assert.equal((await run(role, 'POST', '/api/push-subscriptions/subscribe')).passed, true);
  }
  assert.equal((await run('administrator', 'POST', '/api/penalties', { body: { data: { sum: 1 } } })).passed, true);
  // панель Strapi не трогается вообще — ни правил, ни похода в базу
  const calls = dbCalls;
  for (const p of ['/admin/content-manager/collection-types/api::admin-user.admin-user/5', '/admin/content-manager/collection-types/api::personal.personal/x']) {
    assert.equal((await run('owner', 'PUT', p, { body: { role: 'owner' } })).passed, true);
  }
  assert.equal(dbCalls, calls, 'панель не должна ходить в сверку учёток');
});

// ───────────────── 3. регистр пути для старых правил (s182, s218, s221) ─────────────────
test('регистр пути: старые правила не обходятся заглавными буквами', async () => {
  for (const p of ['/api/Bookings', '/api/CLIENTS/1', '/API/redemptions']) {
    const r = await run('master', 'GET', p);
    assert.equal(r.passed, false, `master GET ${p}`);
    assert.equal(r.code, 'forbidden_for_master');
  }
  for (const role of ROLES) {
    for (const p of ['/api/Time-Blocks/x', '/api/SALON-HOURS', '/API/master-schedules/1']) {
      const r = await run(role, 'POST', p);
      assert.equal(r.passed, false, `${role} POST ${p}`);
      assert.equal(r.code, 'engine_only');
    }
    for (const p of ['/api/Upload/files', '/API/UPLOAD']) {
      const r = await run(role, 'GET', p);
      assert.equal(r.passed, false, `${role} GET ${p}`);
      assert.equal(r.code, 'personal_data_closed');
    }
  }
  // и `oficial` вырезается из ответа на `/API/...`
  const r = await run('manager', 'GET', '/API/personals', { response: { data: [{ name: 'A', oficial: { documentNumber: 'X1' } }] } });
  assert.equal(r.passed, true);
  assert.equal(JSON.stringify(r.ctx.body).includes('X1'), false);
});

// ───────────────────────── 4. сверка с учёткой ─────────────────────────
const SAMPLE_PATHS = [
  ['GET', '/api/personals'],
  ['GET', '/api/engine/admin/today'],
  ['GET', '/API/engine/admin/today'], // регистр — middleware не пропускает мимо
  ['POST', '/api/engine/admin/blocks'],
  ['GET', '/api/admin-users/check-status/1'],
  ['GET', '/api/admin-users/administrator-data/u-administrator'],
];

test('отключённая учётка: 401 на любом /api/**, включая ручки движка и check-status', async () => {
  for (const role of ROLES) {
    resetAccounts();
    ACCOUNTS.get(ROLE_IDS[role]).isActive = false;
    for (const [method, p] of SAMPLE_PATHS) {
      const r = await run(role, method, p);
      assert.equal(r.passed, false, `${role} ${method} ${p} прошёл с отключённой учёткой`);
      assert.equal(r.status, 401);
      assert.equal(r.code, 'session_revoked');
      assert.equal(r.reason, 'account_disabled');
      assert.equal(r.ctx.state.adminJwt, undefined, 'сессия не должна доехать до ручек');
      assert.equal(r.ctx.request.header.authorization, r.auth0, 'заголовок не должен подменяться на токен прокси');
    }
  }
});

test('isActive = NULL — тоже не пускает (вход требует true)', async () => {
  ACCOUNTS.get(1).isActive = null;
  assert.equal((await run('owner', 'GET', '/api/personals')).reason, 'account_disabled');
});

test('роль, логин сменились или учётка удалена — перезаход', async () => {
  ACCOUNTS.get(ROLE_IDS.master).role = 'administrator';
  let r = await run('master', 'GET', '/api/personals');
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'role_changed');
  // и в обратную сторону: повышение до owner в базе не делает токен мастера владельческим
  resetAccounts();
  ACCOUNTS.get(ROLE_IDS.manager).role = 'owner';
  assert.equal((await run('manager', 'GET', '/api/engine/admin/today')).reason, 'role_changed');
  resetAccounts();
  ACCOUNTS.get(ROLE_IDS.administrator).username = 'Viktoriia';
  r = await run('administrator', 'GET', '/api/personals');
  assert.equal(r.reason, 'username_changed');
  resetAccounts();
  ACCOUNTS.delete(ROLE_IDS.owner);
  assert.equal((await run('owner', 'GET', '/api/personals')).reason, 'account_missing');
  // подделать id в токене нельзя — подпись; а чужой id с верной подписью упрётся в логин
  resetAccounts();
  r = await run('master', 'GET', '/api/personals', { tokenOver: { id: ROLE_IDS.owner } });
  assert.equal(r.reason, 'role_changed');
});

test('активная учётка проходит; кэш 30 с — один запрос в базу на серию', async () => {
  for (const role of ROLES) {
    for (const [method, p] of SAMPLE_PATHS.filter(([, x]) => !x.includes('administrator-data'))) {
      const r = await run(role, method, p);
      assert.equal(r.passed, true, `${role} ${method} ${p} (${r.code}/${r.reason})`);
    }
  }
  assert.equal(dbCalls, ROLES.length, 'по одному чтению учётки на роль');
  // без сброса кэша отключение ловится не позже TTL (здесь — ещё не поймано)
  ACCOUNTS.get(ROLE_IDS.master).isActive = false;
  assert.equal((await run('master', 'GET', '/api/personals')).passed, true);
  // сброс (lifecycle admin-user / карточка сотрудника) — действует с первого запроса
  account.invalidateAdminAccount(ROLE_IDS.master);
  assert.equal((await run('master', 'GET', '/api/personals')).reason, 'account_disabled');
  // включили обратно — снова пускает сразу после сброса
  ACCOUNTS.get(ROLE_IDS.master).isActive = true;
  account.invalidateAdminAccount();
  assert.equal((await run('master', 'GET', '/api/personals')).passed, true);
});

test('кэш: истёкшая запись перечитывается; параллельные запросы — одно чтение', async () => {
  const t0 = 1_000_000;
  await account.loadAdminAccount(globalThis.strapi, 4, t0);
  await account.loadAdminAccount(globalThis.strapi, 4, t0 + account.ACCOUNT_CACHE_TTL_MS - 1);
  assert.equal(dbCalls, 1);
  await account.loadAdminAccount(globalThis.strapi, 4, t0 + account.ACCOUNT_CACHE_TTL_MS);
  assert.equal(dbCalls, 2);
  account.invalidateAdminAccount();
  dbCalls = 0;
  await Promise.all([1, 2, 3].map(() => run('master', 'GET', '/api/personals')));
  assert.equal(dbCalls, 1);
  // мусорный id в базу не ходит
  assert.equal(await account.loadAdminAccount(globalThis.strapi, 0), null);
  assert.equal(await account.loadAdminAccount(globalThis.strapi, 'x'), null);
  assert.equal(dbCalls, 1);
});

test('кэш: чтение, начатое до сброса, не кладёт устаревший ответ', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const realQuery = globalThis.strapi.db.query;
  globalThis.strapi.db.query = () => ({
    findOne: async () => {
      dbCalls += 1;
      await gate;
      return { id: 4, role: 'master', username: 'u-master', isActive: true };
    },
  });
  try {
    const slow = account.loadAdminAccount(globalThis.strapi, 4);
    ACCOUNTS.get(4).isActive = false;
    account.invalidateAdminAccount(4); // учётку отключили, пока шло чтение
    release();
    assert.equal((await slow).isActive, true);
  } finally {
    globalThis.strapi.db.query = realQuery;
  }
  // следующее чтение идёт в базу, а не в кэш со старым «активна»
  assert.equal((await run('master', 'GET', '/api/personals')).reason, 'account_disabled');
});

test('ошибка базы — 503, в кэш не попадает, следующий запрос проходит', async () => {
  dbFail = new Error('pool timeout');
  const r = await run('owner', 'GET', '/api/engine/admin/today');
  assert.equal(r.passed, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, 'session_check_failed');
  assert.ok(logged.some((m) => m.includes('pool timeout')));
  dbFail = null;
  assert.equal((await run('owner', 'GET', '/api/engine/admin/today')).passed, true);
});

test('без сессии сотрудника (сайт, вход, панель) — в базу не ходим, ничего не меняем', async () => {
  for (const [method, p] of [
    ['GET', '/api/engine/services'],
    ['POST', '/api/admin-users/login'],
    ['GET', '/api/personals'],
  ]) {
    assert.equal((await run(null, method, p)).passed, true);
  }
  // токен с чужой ролью (панель Strapi подписывает тем же секретом) — мимо
  const ctx = { path: '/api/personals', method: 'GET', state: {}, request: { path: '/api/personals', method: 'GET', header: { authorization: `Bearer ${jwt.signSession({ id: 9, username: 'x', role: 'editor' })}` } } };
  let passed = false;
  await mw.default({}, { strapi: globalThis.strapi })(ctx, async () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(dbCalls, 0);
});

test('sessionMismatch: таблица', () => {
  const s = { role: 'master', username: 'A' };
  assert.equal(account.sessionMismatch(s, { isActive: true, role: 'master', username: 'A' }), null);
  assert.equal(account.sessionMismatch(s, null), 'account_missing');
  assert.equal(account.sessionMismatch(s, { isActive: false, role: 'master', username: 'A' }), 'account_disabled');
  assert.equal(account.sessionMismatch(s, { isActive: 'true', role: 'master', username: 'A' }), 'account_disabled');
  assert.equal(account.sessionMismatch(s, { isActive: true, role: 'owner', username: 'A' }), 'role_changed');
  assert.equal(account.sessionMismatch(s, { isActive: true, role: 'master', username: 'a' }), 'username_changed');
});

test('lifecycle admin-user сбрасывает кэш при правке и удалении', () => {
  const code = src('src/api/admin-user/content-types/admin-user/lifecycles.ts');
  assert.match(code, /import \{ invalidateAdminAccount \} from '\.\.\/\.\.\/\.\.\/\.\.\/utils\/admin-account'/);
  for (const hook of ['afterUpdate', 'afterUpdateMany', 'afterDelete', 'afterDeleteMany']) {
    const m = new RegExp(`async ${hook}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\},`).exec(code);
    assert.ok(m, `${hook} не найден`);
    assert.match(m[1], /dropAccountCache\(\)/, `${hook} не сбрасывает кэш`);
  }
  assert.match(code, /const dropAccountCache = \(\) => invalidateAdminAccount\(\)/);
});
