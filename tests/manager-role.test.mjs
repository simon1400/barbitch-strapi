// Гейты ролей после появления управляющей (s213, роль `manager`).
//
// Управляющая = владелец везде, КРОМЕ email-рассылки (решение владельца s212).
// Здесь гоняются НАСТОЯЩИЕ контроллеры (движок, рассылка, дубли клиентов,
// откат смены, синк отзывов) с настоящими подписанными сессиями каждой роли:
// импорт admin-jwt подменяется на транспилированный оригинал, классы ошибок из
// сервисов — на заглушки (сами сервисы тянуть незачем), `strapi` — глобальная
// заглушка, где любой сервис отвечает { ok: true }.
//
// Запуск: cd strapi && node --test tests/manager-role.test.mjs

import { test } from 'node:test';
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

// admin-jwt: `import crypto from 'crypto'` → node:crypto (data: URL не резолвит голые имена)
const jwtJs = toJs(src('src/utils/admin-jwt.ts')).replace(/from 'crypto'/, "from 'node:crypto'");
const JWT_URL = dataUrl(jwtJs);
const jwt = await import(JWT_URL);
// s229: «кто я» — общий помощник utils/staff-identity (без своих импортов)
const IDENTITY_URL = dataUrl(toJs(src('src/utils/staff-identity.ts')));

const ERR_STUB = (name) => `export class ${name} extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }`;

async function loadController(file, errImport, errName) {
  let code = src(file);
  const jwtImport = /from '\.\.\/\.\.\/\.\.\/utils\/admin-jwt';/;
  assert.ok(jwtImport.test(code), `${file}: импорт admin-jwt не найден`);
  code = code.replace(jwtImport, `from '${JWT_URL}';`);
  code = code.split("from '../../../utils/staff-identity'").join(`from '${IDENTITY_URL}'`);
  if (errImport) {
    assert.ok(code.includes(errImport), `${file}: импорт ${errName} не найден`);
    code = code.split(errImport).join(`import { ${errName} } from '${dataUrl(ERR_STUB(errName))}';`);
  }
  return (await import(dataUrl(toJs(code)))).default;
}

const anyService = new Proxy({}, { get: () => async () => ({ ok: true }) });
// s223: middleware сверяет сессию с учёткой в базе — у каждой роли своя активная учётка
const ROLE_IDS = { owner: 1, manager: 2, administrator: 3, master: 4 };
const ACCOUNTS = new Map(Object.entries(ROLE_IDS).map(([role, id]) => [id, { id, role, username: `u-${role}`, isActive: true }]));
globalThis.strapi = {
  service: () => anyService,
  log: { info() {}, error() {}, warn() {} },
  db: { query: () => ({ findOne: async ({ where }) => ACCOUNTS.get(where.id) ?? null }) },
};

const engine = await loadController(
  'src/api/booking-engine/controllers/booking-engine.ts',
  "import { EngineError } from '../services/booking-engine';",
  'EngineError'
);
const campaign = await loadController(
  'src/api/campaign/controllers/campaign.ts',
  "import { CampaignError } from '../services/campaign';",
  'CampaignError'
);
const dedupe = await loadController(
  'src/api/client-dedupe/controllers/client-dedupe.ts',
  "import { DedupeError } from '../services/client-dedupe';",
  'DedupeError'
);
const shiftRevert = await loadController('src/api/shift-revert/controllers/shift-revert.ts');
const reviewSync = await loadController('src/api/review-sync/controllers/review-sync.ts');

const token = (role) => jwt.signSession({ id: ROLE_IDS[role] ?? 99, username: `u-${role}`, role });
const ctxFor = (role) => ({
  status: 200,
  body: undefined,
  query: { month: '2026-10', date: '2026-10-01' },
  params: { id: 'x' },
  request: { header: role ? { authorization: `Bearer ${token(role)}` } : {}, body: { status: 'approved' } },
  badRequest(msg) { this.status = 400; this.body = msg; },
  internalServerError(msg) { this.status = 500; this.body = msg; },
  set() {},
});
async function statusOf(handler, role) {
  const ctx = ctxFor(role);
  await handler(ctx);
  return ctx.status;
}

const ROLES = ['owner', 'manager', 'administrator', 'master', null];

const CASES = [
  // [название, ручка, кому открыто]
  ['engine: одобрение блока', engine.adminSetBlockApproval, ['owner', 'manager']],
  ['engine: блоки ke schválení', engine.adminPendingBlocks, ['owner', 'manager']],
  ['engine: дашборд «Сегодня»', engine.adminToday, ['owner', 'manager']],
  ['engine: отчёт дозаписей', engine.adminUpsellReport, ['owner', 'manager']],
  ['engine: источники броней', engine.adminAttributionReport, ['owner', 'manager']],
  // корректировки зарплат (s215) — только руководство, администраторам и мастерам нет
  ['engine: корректировки — список', engine.adminCorrectionsList, ['owner', 'manager']],
  ['engine: корректировки — создать', engine.adminCorrectionCreate, ['owner', 'manager']],
  ['engine: корректировки — удалить', engine.adminCorrectionDelete, ['owner', 'manager']],
  // затраты (s236): руководство; администратору и мастеру — ничего (решение владельца);
  // правка/удаление гейтом — руководство, управляющей сервис отвечает 403 approval_required;
  // одобрение и отклонение запросов — только владелец
  ['engine: затраты — месяц', engine.adminCostsList, ['owner', 'manager']],
  ['engine: затраты — автодополнение', engine.adminCostsSuggest, ['owner', 'manager']],
  ['engine: затраты — добавить', engine.adminCostCreate, ['owner', 'manager']],
  ['engine: затраты — изменить', engine.adminCostUpdate, ['owner', 'manager']],
  ['engine: затраты — удалить', engine.adminCostDelete, ['owner', 'manager']],
  ['engine: затраты — запрос', engine.adminCostRequest, ['owner', 'manager']],
  ['engine: затраты — отозвать запрос', engine.adminCostRequestCancel, ['owner', 'manager']],
  ['engine: затраты — одобрить запрос', engine.adminCostRequestApprove, ['owner']],
  ['engine: затраты — отклонить запрос', engine.adminCostRequestReject, ['owner']],
  ['engine: затраты — повтор прошлого месяца', engine.adminCostsRecurring, ['owner', 'manager']],
  ['engine: затраты — пачка', engine.adminCostsBatch, ['owner', 'manager']],
  ['engine: затраты — «Сегодня»', engine.adminCostsAttention, ['owner', 'manager']],
  ['engine: затраты — загрузить чек', engine.adminCostFileUpload, ['owner', 'manager']],
  ['engine: затраты — скачать чек', engine.adminCostFileDownload, ['owner', 'manager']],
  ['engine: затраты — удалить чек', engine.adminCostFileDelete, ['owner', 'manager']],
  ['engine: затраты — сверка с кассой', engine.adminCostsCashCheck, ['owner', 'manager']],
  ['engine: затраты — «не затрата»', engine.adminCostsCashSkip, ['owner', 'manager']],
  ['engine: затраты — снять «не затрата»', engine.adminCostsCashUnskip, ['owner', 'manager']],
  ['engine: затраты — ZIP чеков месяца', engine.adminCostsReceiptsZip, ['owner', 'manager']],
  ['engine: отпуска — брони на эти дни', engine.adminTimeOffConflicts, ['owner', 'manager']],
  ['engine: отпуска — создать', engine.adminTimeOffCreate, ['owner', 'manager']],
  ['engine: отпуска — изменить', engine.adminTimeOffUpdate, ['owner', 'manager']],
  ['engine: отпуска — удалить', engine.adminTimeOffDelete, ['owner', 'manager']],
  // смены администраторов (s217)
  ['engine: смены — окно недель', engine.adminShiftsList, ['owner', 'manager']],
  ['engine: смены — сохранить неделю', engine.adminShiftSave, ['owner', 'manager']],
  ['engine: смены — удалить неделю', engine.adminShiftDelete, ['owner', 'manager']],
  // дни рождения сотрудников (s221): руководство и администраторы, мастеру нет
  ['engine: дни рождения', engine.adminBirthdays, ['owner', 'manager', 'administrator']],
  // кабинет мастера «мой месяц» (s229): любой сотрудник, данные — только свои (сервер решает чьи)
  ['engine: мой месяц', engine.adminMyMonth, ['owner', 'manager', 'administrator', 'master']],
  // карточка сотрудника (s224): только руководство — администраторам ничего (решение владельца)
  ['engine: сотрудники — список', engine.adminStaffList, ['owner', 'manager']],
  ['engine: сотрудники — карточка', engine.adminStaffCard, ['owner', 'manager']],
  ['engine: сотрудники — личные данные', engine.adminStaffPrivate, ['owner', 'manager']],
  ['engine: сотрудники — правка секции', engine.adminStaffPatch, ['owner', 'manager']],
  ['engine: сотрудники — новая ставка', engine.adminStaffRate, ['owner', 'manager']],
  ['engine: сотрудники — загрузка файла', engine.adminStaffFileUpload, ['owner', 'manager']],
  ['engine: сотрудники — скачать документ', engine.adminStaffFileDownload, ['owner', 'manager']],
  ['engine: сотрудники — правка документа', engine.adminStaffFileUpdate, ['owner', 'manager']],
  ['engine: сотрудники — удалить документ', engine.adminStaffFileDelete, ['owner', 'manager']],
  ['engine: сотрудники — новая заметка', engine.adminStaffNoteCreate, ['owner', 'manager']],
  ['engine: сотрудники — правка заметки', engine.adminStaffNoteUpdate, ['owner', 'manager']],
  ['engine: сотрудники — удалить заметку', engine.adminStaffNoteDelete, ['owner', 'manager']],
  ['engine: сотрудники — новый сотрудник', engine.adminStaffCreate, ['owner', 'manager']],
  ['engine: сотрудники — учётка', engine.adminStaffAccount, ['owner', 'manager']],
  ['engine: сотрудники — переименование', engine.adminStaffRename, ['owner', 'manager']],
  ['engine: сотрудники — предпросмотр ухода', engine.adminStaffLeavePreview, ['owner', 'manager']],
  ['engine: сотрудники — завершить работу', engine.adminStaffLeave, ['owner', 'manager']],
  ['engine: сотрудники — стереть личные данные', engine.adminStaffErase, ['owner', 'manager']],
  ['engine: сотрудники — напоминания «Сегодня»', engine.adminStaffReminders, ['owner', 'manager']],
  // фаза 2 карточки (s231): договоры, онбординг, каталог пунктов — только руководство;
  // «Мои данные» — любой сотрудник (своя карточка; владельцу сервис отвечает 404)
  ['engine: сотрудники — новый договор', engine.adminStaffContractCreate, ['owner', 'manager']],
  ['engine: сотрудники — правка договора', engine.adminStaffContractUpdate, ['owner', 'manager']],
  ['engine: сотрудники — удалить договор', engine.adminStaffContractDelete, ['owner', 'manager']],
  ['engine: сотрудники — отметка онбординга', engine.adminStaffOnboarding, ['owner', 'manager']],
  ['engine: сотрудники — каталог пунктов', engine.adminStaffChecklistItems, ['owner', 'manager']],
  ['engine: сотрудники — новый пункт', engine.adminStaffChecklistItemCreate, ['owner', 'manager']],
  ['engine: сотрудники — правка пункта', engine.adminStaffChecklistItemUpdate, ['owner', 'manager']],
  ['engine: мои данные', engine.adminMyCard, ['owner', 'manager', 'administrator', 'master']],
  ['engine: блок (админская ручка)', engine.adminCreateBlock, ['owner', 'manager', 'administrator']],
  // плановый график мастеров (s218): мастер сам себе ничего не меняет; администратор
  // смотрит и предлагает, шаблон / согласование / замена старых блоков — руководство
  ['engine: план — сетка месяца', engine.adminScheduleGrid, ['owner', 'manager', 'administrator']],
  ['engine: план — предпросмотр броней', engine.adminSchedulePreview, ['owner', 'manager', 'administrator']],
  ['engine: план — изменить дни', engine.adminScheduleDays, ['owner', 'manager', 'administrator']],
  ['engine: план — шаблон недели', engine.adminScheduleTemplate, ['owner', 'manager']],
  ['engine: план — решение по предложению', engine.adminScheduleDecide, ['owner', 'manager']],
  ['engine: план — старые серии', engine.adminScheduleLegacy, ['owner', 'manager']],
  ['engine: план — заменить старые серии', engine.adminScheduleLegacyReplace, ['owner', 'manager']],
  ['engine: правка блока', engine.adminPatchBlock, ['owner', 'manager', 'administrator']],
  ['engine: удаление блока', engine.adminDeleteBlock, ['owner', 'manager', 'administrator']],
  ['дубли клиентов', dedupe[Object.keys(dedupe)[0]], ['owner', 'manager', 'administrator']],
  ['откат смены', shiftRevert.revert, ['owner', 'manager']],
  ['синк отзывов', reviewSync.sync, ['owner', 'manager']],
  ['подтверждение ваучера', campaign.voucherConfirmation, ['owner', 'manager']],
  // 🟥 решение владельца: рассылка — только владелец
  ['email-рассылка', campaign.send, ['owner']],
];

for (const [name, handler, allowed] of CASES) {
  test(`гейт: ${name}`, async () => {
    assert.equal(typeof handler, 'function', `${name}: ручка не найдена`);
    for (const role of ROLES) {
      const st = await statusOf(handler, role);
      if (allowed.includes(role)) assert.notEqual(st, 401, `${name}: роль ${role} должна пройти, получила ${st}`);
      else assert.equal(st, 401, `${name}: роль ${role} НЕ должна пройти, получила ${st}`);
    }
  });
}

test('isManagementRole: только owner и manager', () => {
  assert.equal(jwt.isManagementRole('owner'), true);
  assert.equal(jwt.isManagementRole('manager'), true);
  for (const r of ['administrator', 'master', '', null, undefined, 'Manager']) assert.equal(jwt.isManagementRole(r), false, String(r));
});

test('admin-session пускает сессию manager к коллекциям (STAFF_ROLES)', () => {
  const m = /const STAFF_ROLES = new Set\(\[([^\]]*)\]\)/.exec(src('src/middlewares/admin-session.ts'));
  assert.ok(m, 'STAFF_ROLES не найден');
  const roles = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  for (const r of ['owner', 'manager', 'administrator', 'master']) assert.ok(roles.includes(r), r);
});

test('схемы: enum роли и position знают manager', () => {
  const role = JSON.parse(src('src/api/admin-user/content-types/admin-user/schema.json')).attributes.role.enum;
  const pos = JSON.parse(src('src/api/personal/content-types/personal/schema.json')).attributes.position.enum;
  assert.ok(role.includes('manager'));
  assert.ok(pos.includes('manager'));
  assert.ok(pos.includes('master') && pos.includes('administrator'));
});

test('сервисы: блоки и дозаписи считают manager руководством', () => {
  const be = src('src/api/booking-engine/services/booking-engine.ts').replace(/\r/g, '');
  assert.ok(
    be.includes("const isManagementSession = (session) => session?.role === 'owner' || session?.role === 'manager';"),
    'руководство = owner + manager'
  );
  assert.ok(be.includes('const isOwner = isManagementSession(session); // руководство (s213)'), 'блок manager не approved сразу');
  assert.ok(be.includes('const resetApproval = !isManagementSession(session) && block.approvalStatus'), 'правка блока manager сбрасывает approval');
  // s218: правка действующего блока не руководством — предложение, блок не перестаёт действовать
  assert.ok(
    be.includes('if (!isManagementSession(session) && effective) {' + String.fromCharCode(10) + '      return this._proposeBlockChange(block, data, session);'),
    'администратор правит действующий блок напрямую'
  );
  const up = src('src/api/booking-engine/services/upsell.ts');
  assert.ok(up.includes("const isOwner = session?.role === 'owner' || session?.role === 'manager';"), 'upsell mine/byAdmin');
});

test('сайт и движок: мастера только position=master', () => {
  const be = src('src/api/booking-engine/services/booking-engine.ts');
  const n = be.split("filters: { isActive: true, position: 'master', services: { documentId:").length - 1;
  assert.equal(n, 2, 'publicServiceEmployees + listEmployeesForService');
  for (const f of ['rebook.ts', 'upsell.ts']) {
    assert.ok(src(`src/api/booking-engine/services/${f}`).includes("filters: { isActive: true, position: 'master' },"), f);
  }
});

// ── s218: сессии сотрудников не пишут блоки / часы / план в обход движка ──
const ACCOUNT_URL = dataUrl(toJs(src('src/utils/admin-account.ts')));
const mwCode = src('src/middlewares/admin-session.ts')
  .replace(/from '\.\.\/utils\/admin-jwt';/, `from '${JWT_URL}';`)
  .replace(/from '\.\.\/utils\/admin-account';/, `from '${ACCOUNT_URL}';`);
assert.ok(!/from '\.\.\/utils\//.test(mwCode), 'в middleware остался неподменённый импорт utils');
const mw = await import(dataUrl(toJs(mwCode)));

async function runMw(role, method, pathName) {
  const ctx = {
    path: pathName,
    method,
    status: 200,
    body: undefined,
    state: {},
    request: { path: pathName, method, header: role ? { authorization: `Bearer ${token(role)}` } : {} },
  };
  let passed = false;
  await mw.default({}, { strapi: globalThis.strapi })(ctx, async () => {
    passed = true;
  });
  return { passed, status: ctx.status, code: ctx.body?.error?.code };
}

test('admin-session: блоки, часы салона и план — только чтение для всех ролей сотрудников', async () => {
  for (const role of ['owner', 'manager', 'administrator', 'master']) {
    for (const coll of ['time-blocks', 'salon-hours', 'master-schedules']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = await runMw(role, method, `/api/${coll}/abc`);
        assert.equal(r.passed, false, `${role} ${method} ${coll} прошёл`);
        assert.equal(r.status, 403);
        assert.equal(r.code, 'engine_only');
      }
      const g = await runMw(role, 'GET', `/api/${coll}?filters[date][$eq]=2026-10-01`);
      assert.equal(g.passed, true, `${role} GET ${coll} не прошёл`);
    }
  }
  // соседние коллекции и ручки движка не задеты
  assert.equal((await runMw('administrator', 'POST', '/api/penalties')).passed, true);
  assert.equal((await runMw('master', 'POST', '/api/engine/admin/blocks')).passed, true);
  // панель Strapi не трогается вообще
  assert.equal((await runMw('master', 'POST', '/admin/content-manager/collection-types/api::time-block.time-block')).passed, true);
});

// ── s236: затраты — запись только ручками движка; администратору costs и журнал закрыты ──
test('admin-session: costs — только чтение для всех ролей сотрудников', async () => {
  for (const role of ['owner', 'manager', 'administrator', 'master']) {
    for (const [method, p] of [['POST', '/api/costs'], ['PUT', '/api/costs/abc'], ['DELETE', '/api/costs/abc'], ['PATCH', '/API/Costs/abc']]) {
      const r = await runMw(role, method, p);
      assert.equal(r.passed, false, `${role} ${method} ${p} прошёл`);
      assert.equal(r.status, 403);
    }
  }
  for (const role of ['owner', 'manager']) {
    assert.equal((await runMw(role, 'GET', '/api/costs')).passed, true, `${role} GET costs`);
    assert.equal((await runMw(role, 'POST', '/api/costs')).code, 'engine_only');
    assert.equal((await runMw(role, 'GET', '/api/calendar-logs')).passed, true, `${role} GET calendar-logs`);
  }
  // журнал чистит из модалки только владелец (s240, §10.4.1 «Výkaz práce»)
  assert.equal((await runMw('owner', 'DELETE', '/api/calendar-logs/abc')).passed, true, 'owner DELETE calendar-logs');
  const del = await runMw('manager', 'DELETE', '/api/Calendar-Logs/abc');
  assert.equal(del.passed, false, 'manager DELETE calendar-logs прошёл');
  assert.equal(del.code, 'engine_only');
  // s240: журнал пишет только сервер — REST-создание/правка подделали бы «Systém zaznamenal» výkazu
  for (const role of ['owner', 'manager']) {
    for (const [method, p] of [['POST', '/api/calendar-logs'], ['PUT', '/api/calendar-logs/abc'], ['PATCH', '/API/Calendar-Logs/abc']]) {
      const r = await runMw(role, method, p);
      assert.equal(r.passed, false, `${role} ${method} ${p} прошёл`);
      assert.equal(r.status, 403);
      assert.equal(r.code, 'engine_only');
    }
  }
  // ручки движка не задеты — у них свой гейт
  for (const role of ['owner', 'manager', 'administrator', 'master']) {
    assert.equal((await runMw(role, 'POST', '/api/engine/admin/costs')).passed, true);
  }
  // панель Strapi не трогается
  assert.equal((await runMw('owner', 'POST', '/admin/content-manager/collection-types/api::cost.cost')).passed, true);
});

test('admin-session: администратору costs и calendar-logs закрыты целиком (чтение тоже)', async () => {
  for (const [method, p] of [
    ['GET', '/api/costs'],
    ['GET', '/api/costs?filters[date][$gte]=2026-10-01'],
    ['GET', '/API/COSTS'],
    ['GET', '/api/calendar-logs'],
    ['GET', '/api/calendar-logs/abc'],
    ['DELETE', '/api/calendar-logs/abc'],
    ['POST', '/api/calendar-logs'],
    ['GET', '/api/Calendar-Logs'],
  ]) {
    const r = await runMw('administrator', method, p);
    assert.equal(r.passed, false, `administrator ${method} ${p} прошёл`);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'forbidden_for_administrator', p);
  }
  // мастеру оба закрыты белым списком (s229) — проверяет master-scope.test.mjs
  // остальное администратору как было: брони (график кабинета), смены, блоки
  for (const p of ['/api/bookings', '/api/shifts', '/api/time-blocks', '/api/cost-requests-x']) {
    assert.equal((await runMw('administrator', 'GET', p)).passed, true, p);
  }
});

// ── s221: паспортные данные сотрудников (personal.oficial) закрыты любой сессии ──
async function runMwFull(role, method, pathName, { querystring = '', body, response } = {}) {
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
      header: role ? { authorization: `Bearer ${token(role)}` } : {},
    },
  };
  let passed = false;
  await mw.default({}, { strapi: globalThis.strapi })(ctx, async () => {
    passed = true;
    ctx.body = response;
  });
  return { passed, status: ctx.status, code: ctx.body?.error?.code, body: ctx.body };
}

test('admin-session: запрос с oficial в query или теле — 403 для всех ролей', async () => {
  const queries = [
    'populate=oficial',
    'populate[oficial][fields][0]=documentNumber',
    'populate%5Boficial%5D=*',
    'populate%255Boficial%255D=*', // дважды закодировано
    // закодировано САМО слово — сервер раскодирует ключ и отдал бы компонент
    'populate[%6Fficial]=*',
    'populate[o%66icial][fields][0]=documentNumber',
    'populate[%256Fficial]=*',
    'populate[0]=OFICIAL',
    'filters[oficial][documentNumber][$startsWith]=1',
    'sort=oficial.dateBirth',
    'populate[personal][populate][oficial]=*',
  ];
  for (const role of ['owner', 'manager', 'administrator', 'master']) {
    for (const q of queries) {
      const r = await runMwFull(role, 'GET', '/api/personals', { querystring: q });
      assert.equal(r.passed, false, `${role} ${q} прошёл`);
      assert.equal(r.status, 403);
      assert.equal(r.code, 'personal_data_closed');
    }
    const w = await runMwFull(role, 'PUT', '/api/personals/abc', { body: { data: { oficial: { phone: '1' } } } });
    assert.equal(w.passed, false, `${role} запись oficial прошла`);
    assert.equal(w.code, 'personal_data_closed');
    // обычные запросы админки не задеты
    const ok = await runMwFull(role, 'GET', '/api/personals', {
      querystring: 'filters[isActive][$eq]=true&fields[0]=name&populate[services][fields][0]=title',
      response: { data: [{ name: 'A' }] },
    });
    // s229: мастеру populate на personals закрыт (экранам мастера не нужен)
    assert.equal(ok.passed, role !== 'master', `${role} populate[services]`);
    // s223: мастер в карточки не пишет вовсе, остальные — три ключа экранов админки
    const put = await runMwFull(role, 'PUT', '/api/personals/abc', { body: { data: { bookingPriority: 3 } } });
    assert.equal(put.passed, role !== 'master', `${role} bookingPriority`);
  }
});

test('admin-session: oficial вырезается из ответа на любой глубине (populate=*, вложенные связи)', async () => {
  const response = () => ({
    data: [
      { name: 'A', oficial: { documentNumber: 'X1', dateBirth: '01.01.1990' }, rates: [{ rate: 150 }] },
      { name: 'B', personal: { name: 'C', oficial: { documentNumber: 'X2' }, createdAt: new Date(0) } },
    ],
    meta: { pagination: { total: 2 } },
  });
  // s229: мастеру populate на personals закрыт целиком (кабинет — через /engine/admin/my-month)
  const m = await runMwFull('master', 'GET', '/api/personals', { querystring: 'populate=*', response: response() });
  assert.equal(m.passed, false);
  assert.equal(m.status, 403);
  for (const role of ['owner', 'manager', 'administrator']) {
    const r = await runMwFull(role, 'GET', '/api/personals', { querystring: 'populate=*', response: response() });
    assert.equal(r.passed, true);
    assert.equal(JSON.stringify(r.body).includes('X1'), false, `${role}: документ в ответе`);
    assert.equal(JSON.stringify(r.body).toLowerCase().includes('oficial'), false);
    assert.equal(r.body.data[0].rates[0].rate, 150);
    assert.equal(r.body.data[1].personal.name, 'C');
    assert.ok(r.body.data[1].personal.createdAt instanceof Date);
    assert.equal(r.body.meta.pagination.total, 2);
  }
  // без сессии сотрудника (сайт, панель) ответ не трогается
  const site = await runMwFull(null, 'GET', '/api/personals', { querystring: 'populate=*', response: response() });
  assert.equal(site.body.data[0].oficial.documentNumber, 'X1');
  const panel = await runMwFull('owner', 'GET', '/admin/content-manager/x', { querystring: 'populate=oficial', response: response() });
  assert.equal(panel.passed, true);
  assert.equal(panel.body.data[0].oficial.documentNumber, 'X1');
  // не-JSON ответ (Buffer) проходит как есть
  const buf = await runMwFull('owner', 'GET', '/api/personals', { response: Buffer.from('oficial') });
  assert.equal(buf.body.toString(), 'oficial');
});

test('admin-session: медиатека закрыта сессиям сотрудников', async () => {
  for (const role of ['owner', 'manager', 'administrator', 'master']) {
    for (const [method, p] of [['GET', '/api/upload/files'], ['POST', '/api/upload'], ['GET', '/api/upload/files/12']]) {
      const r = await runMwFull(role, method, p);
      assert.equal(r.passed, false, `${role} ${method} ${p} прошёл`);
      assert.equal(r.status, 403);
    }
  }
});
