// Юнит-тесты правила «в blacklist только с причиной» (s208) — без БД и Strapi.
//
// Три точки входа, и все три обязаны держать правило:
//   • client-dedupe.setBlacklist — основная ручка админки (шторка, поиск, дубли);
//   • client-dedupe.updateClient — правка карточки (patch.blacklisted);
//   • lifecycle api::client.client — Content Manager и сырой PUT /api/clients.
//
// Модули грузятся НАСТОЯЩИЕ, тем же приёмом, что в client-update.test.mjs:
// normalizePhone вырезается из движка, импорт @strapi/utils в lifecycle
// подменяется заглушкой ValidationError.
//
// Запуск: cd strapi && node --test tests/blacklist-reason.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = import.meta.dirname;
const read = (p) => fs.readFileSync(path.resolve(here, p), 'utf8');
const load = async (src) => {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
};

// ── client-dedupe ──────────────────────────────────────────────────────────
const engineSrc = read('../src/api/booking-engine/services/booking-engine.ts');
const normSrc = /export const normalizePhone = \([\s\S]*?\r?\n\};\r?\n/.exec(engineSrc);
assert.ok(normSrc, 'normalizePhone не найден в booking-engine.ts');
const dedupeSrc = read('../src/api/client-dedupe/services/client-dedupe.ts');
const IMPORT_LINE = "import { normalizePhone } from '../../booking-engine/services/booking-engine';";
assert.ok(dedupeSrc.includes(IMPORT_LINE));
const dedupe = await load(dedupeSrc.replace(IMPORT_LINE, normSrc[0].replace('export const', 'const')));
const svc = dedupe.default;
const { normalizeBlacklistReason, BLACKLIST_REASON_KEYS } = dedupe;

// ── lifecycle ──────────────────────────────────────────────────────────────
const lcSrc = read('../src/api/client/content-types/client/lifecycles.ts');
const LC_IMPORT = "import { errors } from '@strapi/utils';";
assert.ok(lcSrc.includes(LC_IMPORT), 'lifecycle больше не берёт ValidationError из @strapi/utils');
const lc = await load(
  lcSrc.replace(LC_IMPORT, 'class VE extends Error {}; const errors = { ValidationError: VE };')
);

// ── заглушка knex ──────────────────────────────────────────────────────────
const mkKnex = (ctx) => {
  const qb = (table) => {
    const q = {
      whereIn: () => q,
      where: () => q,
      update: (data) => {
        ctx.updates.push({ table, data });
        return Promise.resolve(ctx.updateCount ?? 1);
      },
    };
    return q;
  };
  qb.transaction = async (cb) => cb(qb);
  return qb;
};

const ROW = { id: 7, document_id: 'cl-1', name: 'Sofie Rosová', phone: '+420605881897', email: null, blacklisted: false, blacklist_reason: null };

const env = (rows = [ROW]) => {
  const ctx = { updates: [], logs: [], calendarLogs: [] };
  globalThis.strapi = {
    log: { warn() {}, error() {} },
    service: () => ({ write: async (e) => ctx.calendarLogs.push(e) }),
    documents: () => ({ create: async () => ({}) }),
  };
  const self = {
    knex: () => mkKnex(ctx),
    rowsByDocIds: async () => rows,
    log: async (action, entry) => ctx.logs.push({ action, ...entry }),
    contactConflicts: async () => [],
  };
  return { ctx, self };
};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

// ── normalizeBlacklistReason ───────────────────────────────────────────────

test('ключи причин — фиксированный список сервера', () => {
  assert.deepEqual(BLACKLIST_REASON_KEYS, ['noshow', 'late_cancel', 'behaviour', 'other']);
});

test('пустая причина — 400 reason_required', () => {
  for (const v of [undefined, null, '', '   ']) {
    assert.throws(() => normalizeBlacklistReason(v), (e) => e.status === 400 && e.code === 'reason_required');
  }
});

test('ключ с комментарием и без — хранится как «ключ: комментарий» / «ключ»', () => {
  assert.equal(normalizeBlacklistReason('noshow'), 'noshow');
  assert.equal(normalizeBlacklistReason('  late_cancel :  2× zrušila v den termínu '), 'late_cancel: 2× zrušila v den termínu');
});

test('«other» без комментария — 400 comment_required, с комментарием проходит', () => {
  assert.throws(() => normalizeBlacklistReason('other'), (e) => e.code === 'comment_required');
  assert.throws(() => normalizeBlacklistReason('other:  '), (e) => e.code === 'comment_required');
  assert.equal(normalizeBlacklistReason('other: dluh 500 Kč'), 'other: dluh 500 Kč');
});

test('свободный текст без ключа (старые записи, CM) принимается как есть', () => {
  assert.equal(normalizeBlacklistReason('Nepřišla 3×'), 'Nepřišla 3×');
});

test('длина обрезается до 500 символов', () => {
  assert.equal(normalizeBlacklistReason('noshow: ' + 'x'.repeat(900)).length, 500);
});

// ── setBlacklist ───────────────────────────────────────────────────────────

test('setBlacklist без причины — 400, база не тронута, журнала нет', async () => {
  const { ctx, self } = env();
  await assert.rejects(
    () => svc.setBlacklist.call(self, { docIds: ['cl-1'], blacklisted: true, actorName: 'Olga' }),
    (e) => e.status === 400 && e.code === 'reason_required'
  );
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.logs.length, 0);
  assert.equal(ctx.calendarLogs.length, 0);
});

test('setBlacklist с причиной — флаг и причина пишутся одним update', async () => {
  const { ctx, self } = env();
  const res = await svc.setBlacklist.call(self, { docIds: ['cl-1'], blacklisted: true, reason: 'noshow: 3× nepřišla', actorName: 'Olga' });
  await tick();
  assert.equal(res.ok, true);
  const u = ctx.updates.find((x) => x.table === 'clients').data;
  assert.equal(u.blacklisted, true);
  assert.equal(u.blacklist_reason, 'noshow: 3× nepřišla');
  assert.equal(ctx.logs[0].details.reason, 'noshow: 3× nepřišla');
});

test('setBlacklist пишет в журнал календаря кто и почему', async () => {
  const { ctx, self } = env();
  await svc.setBlacklist.call(self, { docIds: ['cl-1'], blacklisted: true, reason: 'behaviour', actorName: 'Olga' });
  await tick();
  assert.equal(ctx.calendarLogs.length, 1);
  const l = ctx.calendarLogs[0];
  assert.equal(l.action, 'client_edit');
  assert.equal(l.actorName, 'Olga');
  assert.equal(l.entityDocId, 'cl-1');
  assert.deepEqual(l.details, { blacklist: 'ano', 'důvod': 'behaviour' });
});

test('setBlacklist: карточки, у которых флаг не менялся, в журнал календаря не пишутся', async () => {
  const { ctx, self } = env([ROW, { ...ROW, id: 8, document_id: 'cl-2', blacklisted: true, blacklist_reason: 'noshow' }]);
  await svc.setBlacklist.call(self, { docIds: ['cl-1', 'cl-2'], blacklisted: true, reason: 'noshow', actorName: 'O' });
  await tick();
  assert.deepEqual(ctx.calendarLogs.map((l) => l.entityDocId), ['cl-1']);
});

test('снятие блокировки причину не требует и стирает её', async () => {
  const { ctx, self } = env([{ ...ROW, blacklisted: true, blacklist_reason: 'noshow' }]);
  await svc.setBlacklist.call(self, { docIds: ['cl-1'], blacklisted: false, reason: 'noshow', actorName: 'O' });
  await tick();
  const u = ctx.updates.find((x) => x.table === 'clients').data;
  assert.equal(u.blacklisted, false);
  assert.equal(u.blacklist_reason, null);
  assert.deepEqual(ctx.calendarLogs[0].details, { blacklist: 'ne' });
});

// ── updateClient ───────────────────────────────────────────────────────────

test('updateClient: blacklisted:true без причины — 400, база не тронута', async () => {
  const { ctx, self } = env();
  await assert.rejects(
    () => svc.updateClient.call(self, { docId: 'cl-1', patch: { blacklisted: true }, actorName: 'X' }),
    (e) => e.code === 'reason_required'
  );
  assert.equal(ctx.updates.length, 0);
});

test('updateClient: blacklisted:true с причиной — пишет нормализованную причину', async () => {
  const { ctx, self } = env();
  await svc.updateClient.call(self, { docId: 'cl-1', patch: { blacklisted: true, blacklistReason: ' late_cancel ' }, actorName: 'X' });
  const u = ctx.updates.find((x) => x.table === 'clients').data;
  assert.equal(u.blacklisted, true);
  assert.equal(u.blacklist_reason, 'late_cancel');
});

test('updateClient: старая заблокированная карточка без причины пересохраняется (правка имени)', async () => {
  const { ctx, self } = env([{ ...ROW, blacklisted: true, blacklist_reason: null }]);
  await svc.updateClient.call(self, { docId: 'cl-1', patch: { name: 'Sofie Rosová', blacklisted: true }, actorName: 'X', renameBookings: false });
  assert.equal(ctx.updates.find((x) => x.table === 'clients').data.blacklisted, true);
});

test('updateClient: снятие флага стирает причину', async () => {
  const { ctx, self } = env([{ ...ROW, blacklisted: true, blacklist_reason: 'noshow' }]);
  await svc.updateClient.call(self, { docId: 'cl-1', patch: { blacklisted: false }, actorName: 'X' });
  assert.equal(ctx.updates.find((x) => x.table === 'clients').data.blacklist_reason, null);
});

// ── lifecycle ──────────────────────────────────────────────────────────────

const V = lc.blacklistReasonViolation;

test('lifecycle: переход false→true без причины — отказ', () => {
  assert.ok(V({ blacklisted: false, blacklistReason: null }, { blacklisted: true }));
  assert.ok(V({ blacklisted: false }, { blacklisted: true, blacklistReason: '  ' }));
  assert.ok(V(null, { blacklisted: true }));
});

test('lifecycle: с причиной в запросе или уже в карточке — можно', () => {
  assert.equal(V({ blacklisted: false }, { blacklisted: true, blacklistReason: 'noshow' }), null);
  assert.equal(V({ blacklisted: false, blacklistReason: 'noshow' }, { blacklisted: true }), null);
});

test('lifecycle: уже заблокированная карточка без причины сохраняется (бэкфил не нужен)', () => {
  assert.equal(V({ blacklisted: true, blacklistReason: null }, { blacklisted: true, name: 'X' }), null);
});

test('lifecycle: снятие флага и правка без флага не проверяются', () => {
  assert.equal(V({ blacklisted: false }, { blacklisted: false }), null);
  assert.equal(V({ blacklisted: false }, { name: 'X' }), null);
});

test('lifecycle beforeUpdate бросает ValidationError и читает прежнее состояние по where', async () => {
  const queried = [];
  globalThis.strapi = {
    db: { query: () => ({ findOne: async (q) => { queried.push(q); return { blacklisted: false, blacklistReason: null }; } }) },
  };
  await assert.rejects(
    () => lc.default.beforeUpdate({ params: { where: { id: 7 }, data: { blacklisted: true } } }),
    (e) => /důvod/.test(e.message)
  );
  assert.deepEqual(queried[0].where, { id: 7 });
  await lc.default.beforeUpdate({ params: { where: { id: 7 }, data: { blacklisted: true, blacklistReason: 'noshow' } } });
});
