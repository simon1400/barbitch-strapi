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

const ERR_STUB = (name) => `export class ${name} extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }`;

async function loadController(file, errImport, errName) {
  let code = src(file);
  const jwtImport = /from '\.\.\/\.\.\/\.\.\/utils\/admin-jwt';/;
  assert.ok(jwtImport.test(code), `${file}: импорт admin-jwt не найден`);
  code = code.replace(jwtImport, `from '${JWT_URL}';`);
  if (errImport) {
    assert.ok(code.includes(errImport), `${file}: импорт ${errName} не найден`);
    code = code.split(errImport).join(`import { ${errName} } from '${dataUrl(ERR_STUB(errName))}';`);
  }
  return (await import(dataUrl(toJs(code)))).default;
}

const anyService = new Proxy({}, { get: () => async () => ({ ok: true }) });
globalThis.strapi = {
  service: () => anyService,
  log: { info() {}, error() {}, warn() {} },
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

const token = (role) => jwt.signSession({ id: 1, username: `u-${role}`, role });
const ctxFor = (role) => ({
  status: 200,
  body: undefined,
  query: { month: '2026-10', date: '2026-10-01' },
  params: { id: 'x' },
  request: { header: role ? { authorization: `Bearer ${token(role)}` } : {}, body: { status: 'approved' } },
  badRequest(msg) { this.status = 400; this.body = msg; },
  internalServerError(msg) { this.status = 500; this.body = msg; },
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
  ['engine: отчёт дозаписей', engine.adminUpsellReport, ['owner', 'manager']],
  ['engine: источники броней', engine.adminAttributionReport, ['owner', 'manager']],
  ['engine: блок (админская ручка)', engine.adminCreateBlock, ['owner', 'manager', 'administrator']],
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
  assert.ok(be.includes("const isOwner = session?.role === 'owner' || session?.role === 'manager';"), 'блок manager не approved сразу');
  assert.ok(be.includes("const resetApproval = session?.role !== 'owner' && session?.role !== 'manager' && block.approvalStatus"), 'правка блока manager сбрасывает approval');
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
