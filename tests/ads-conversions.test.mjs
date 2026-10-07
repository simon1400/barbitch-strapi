// Офлайн-конверсии Google Ads (s243, OFFLINE_CONVERSIONS_NEXT_SESSION_PROMPT.md):
//   - нормализация и хеши — как в клиентском роуте Lead (одинаковый текст функций);
//   - событие: transactionId = documentId брони, сумма, CZK, время визита ≤ сейчас,
//     клик из last → first, без клика и контактов — null;
//   - кого шлём: только checkedOut, не интерная, согласие, цена > 0, с 19.09;
//   - сервис на заглушке knex/fetch: идемпотентность, пробный → боевой режим, отказ
//     пачки 400 → по одному, попытки, 5xx ничего не пишет, пометка отката.
// Запуск: cd strapi && node --test tests/ads-conversions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const toJs = (file) =>
  ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const utilJs = toJs('src/utils/google-ads-dm.ts');
const U = await import(dataUrl(utilJs));
let svcJs = toJs('src/api/booking-engine/services/ads-conversions.ts');
const from = "from '../../../utils/google-ads-dm'";
assert.ok(svcJs.includes(from));
svcJs = svcJs.split(from).join(`from '${dataUrl(utilJs)}'`);
const S = await import(dataUrl(svcJs));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('нормализация и хеши — те же, что у клиентского роута Lead', () => {
  const client = fs.readFileSync(path.join(root, '../client/src/app/api/google-ads-conversion/route.ts'), 'utf8');
  const body = (src, name) => {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, name);
    return m[0].replace(/;|\s+/g, '');
  };
  const mine = read('src/utils/google-ads-dm.ts');
  for (const fn of ['hashHex', 'normalizeEmail', 'normalizePhone']) {
    assert.equal(body(mine, fn).replace(/^export/, ''), body(client, fn), fn);
  }
  assert.equal(U.normalizePhone('777 123 456'), '+420777123456');
  assert.equal(U.normalizePhone('0777-123-456'), '+420777123456');
  assert.equal(U.normalizePhone('+421 (905) 111 222'), '+421905111222');
  assert.equal(U.normalizeEmail('  Jana@Seznam.CZ '), 'jana@seznam.cz');
  assert.equal(U.hashHex('jana@seznam.cz'), sha('jana@seznam.cz'));
});

const row = (over = {}) => ({
  id: 1,
  documentId: 'bk1',
  status: 'checkedOut',
  internal: false,
  startsAt: '2026-10-01T08:00:00.000Z',
  date: '2026-10-01',
  price: 1081,
  attribution: { first: { gclid: 'G-first' }, last: { gclid: 'G-last', gad_campaignid: '1' }, consent: true },
  email: 'Jana@Seznam.cz',
  phone: '777123456',
  ...over,
});

test('клик: последнее касание целиком, иначе первое', () => {
  assert.deepEqual(U.clickIds({ first: { gclid: 'a' }, last: { wbraid: 'w' } }), { wbraid: 'w' });
  assert.deepEqual(U.clickIds({ first: { gclid: 'a', gbraid: 'b' }, last: { utm_source: 'ig' } }), { gclid: 'a', gbraid: 'b' });
  assert.deepEqual(U.clickIds({ last: { fbclid: 'f' } }), {});
  assert.deepEqual(U.clickIds(null), {});
});

test('событие визита', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const e = U.buildVisitEvent(row(), now);
  assert.equal(e.transactionId, 'bk1');
  assert.equal(e.conversionValue, 1081);
  assert.equal(e.currency, 'CZK');
  assert.equal(e.eventSource, 'WEB');
  assert.equal(e.eventTimestamp, '2026-10-01T08:00:00.000Z', 'время визита, не крона');
  assert.deepEqual(e.destinationReferences, ['google-ads']);
  assert.deepEqual(e.adIdentifiers, { gclid: 'G-last' });
  assert.deepEqual(e.userData.userIdentifiers, [{ emailAddress: sha('jana@seznam.cz') }, { phoneNumber: sha('+420777123456') }]);
  assert.deepEqual(e.consent, { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' });
  // будущее время не отправляем
  assert.equal(U.buildVisitEvent(row({ startsAt: '2026-10-08T08:00:00Z' }), now).eventTimestamp, now.toISOString());
  // без клика — только хеши; без контактов — только клик; без обоих — null
  const noClick = U.buildVisitEvent(row({ attribution: { last: { utm_source: 'ig' }, consent: true } }), now);
  assert.equal(noClick.adIdentifiers, undefined);
  assert.equal(noClick.userData.userIdentifiers.length, 2);
  const noContacts = U.buildVisitEvent(row({ email: '', phone: null }), now);
  assert.equal(noContacts.userData, undefined);
  assert.deepEqual(noContacts.adIdentifiers, { gclid: 'G-last' });
  assert.equal(U.buildVisitEvent(row({ email: ' ', phone: '', attribution: { consent: true } }), now), null);
  assert.equal(U.buildVisitEvent(row({ price: 999.995 }), now).conversionValue, 1000);
});

test('кого шлём', () => {
  assert.equal(S.ineligibleReason(row()), null);
  assert.equal(S.ineligibleReason(row({ status: 'active' })), 'not_checked_out');
  assert.equal(S.ineligibleReason(row({ status: 'cancelled' })), 'not_checked_out');
  assert.equal(S.ineligibleReason(row({ status: 'noshow' })), 'not_checked_out');
  assert.equal(S.ineligibleReason(row({ internal: true })), 'internal');
  assert.equal(S.ineligibleReason(row({ internal: null })), null, 'NULL у старых броней — обычная');
  assert.equal(S.ineligibleReason(row({ attribution: null })), 'no_attribution');
  assert.equal(S.ineligibleReason(row({ attribution: { last: { gclid: 'x' }, consent: false } })), 'no_consent');
  assert.equal(S.ineligibleReason(row({ attribution: { last: { gclid: 'x' } } })), 'no_consent', 'нет данных о согласии — не шлём');
  assert.equal(
    S.ineligibleReason(row({ attribution: { last: { gclid: 'x' }, consent: true, inheritedFrom: 'bk0' } })),
    null,
    'дозапись с thank-you — как обычный визит'
  );
  assert.equal(S.ineligibleReason(row({ price: 0 })), 'zero_price');
  assert.equal(S.ineligibleReason(row({ date: '2026-09-18' })), 'before_attribution');
  assert.equal(S.ineligibleReason(row({ date: '2026-09-19' })), null);
});

test('повторная отправка', () => {
  assert.equal(S.needsSend(null, false), true);
  assert.equal(S.needsSend({ sentAt: 'x', validateOnly: false }, false), false);
  assert.equal(S.needsSend({ sentAt: 'x', validateOnly: false }, true), false);
  assert.equal(S.needsSend({ sentAt: 'x', validateOnly: true }, false), true, 'пробная → боевая');
  assert.equal(S.needsSend({ sentAt: 'x', validateOnly: true }, true), false);
  assert.equal(S.needsSend({ error: 'e', attempts: 2, validateOnly: false }, false), true);
  assert.equal(S.needsSend({ error: 'e', attempts: 3, validateOnly: false }, false), false);
  assert.equal(S.needsSend({ error: 'e', attempts: 3, validateOnly: true }, false), true, 'попытки — в пределах режима');
  assert.equal(S.needsSend({ skipped: 'no_identifiers' }, false), false);
});

// ── сервис на заглушке ──

const ENV = {
  GOOGLE_DM_CLIENT_ID: 'cid',
  GOOGLE_DM_CLIENT_SECRET: 'sec',
  GOOGLE_DM_REFRESH_TOKEN: 'rt',
  GOOGLE_DM_OPERATING_ACCOUNT_ID: '7100619085',
  GOOGLE_DM_CONVERSION_ACTION_VISIT: '999',
  GOOGLE_DM_VALIDATE_ONLY: 'false',
};
const NOW = new Date('2026-10-07T12:00:00Z');

const dbRow = (over = {}) => {
  const r = row(over);
  return {
    id: r.id,
    document_id: r.documentId,
    status: r.status,
    internal: r.internal,
    starts_at: r.startsAt,
    date: r.date,
    price: r.price,
    attribution: r.attribution,
    ads_conversion: over.ads_conversion ?? null,
    email: r.email,
    phone: r.phone,
  };
};

function harness({ candidates = [], reverted = [], ingestReplies = [] } = {}) {
  const writes = [];
  const sql = [];
  const calls = [];
  const logs = [];
  const raw = async (q, params) => {
    sql.push({ q, params });
    if (q.startsWith('update bookings')) {
      writes.push({ id: params[1], value: JSON.parse(params[0]) });
      return { rows: [] };
    }
    if (q.includes("ads_conversion->>'revertedAt' is null")) return { rows: reverted };
    return { rows: candidates };
  };
  globalThis.strapi = {
    db: { connection: { raw } },
    log: { warn: (m) => logs.push(m), error: (m) => logs.push(m), info: (m) => logs.push(m) },
  };
  const replies = [...ingestReplies];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    const r = replies.shift() || { status: 200, body: { requestId: 'req-1' } };
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  const ingests = () => calls.filter((c) => c.url.includes('events:ingest')).map((c) => JSON.parse(c.body));
  return { writes, sql, calls, logs, fetchImpl, ingests };
}

test('без настройки — no-op без запросов к базе и Google', async () => {
  const h = harness({ candidates: [dbRow()] });
  const env = { ...ENV, GOOGLE_DM_CONVERSION_ACTION_VISIT: '' };
  assert.deepEqual(await S.default.run({ now: NOW, env, fetchImpl: h.fetchImpl }), { skipped: 'not_configured' });
  assert.equal(h.sql.length, 0);
  assert.equal(h.calls.length, 0);
});

test('прогон: отправляется только конверсия, журнал пишется', async () => {
  const h = harness({
    candidates: [
      dbRow({ id: 1, documentId: 'ok' }),
      dbRow({ id: 2, documentId: 'nocons', attribution: { last: { gclid: 'x' }, consent: false } }),
      dbRow({ id: 3, documentId: 'int', internal: true }),
      dbRow({ id: 4, documentId: 'zero', price: 0 }),
      dbRow({ id: 5, documentId: 'noid', email: null, phone: null, attribution: { consent: true } }),
      dbRow({ id: 6, documentId: 'done', ads_conversion: { sentAt: 'x', validateOnly: false } }),
      dbRow({ id: 7, documentId: 'val', ads_conversion: { sentAt: 'x', validateOnly: true, attempts: 1 } }),
    ],
  });
  const res = await S.default.run({ now: NOW, env: ENV, fetchImpl: h.fetchImpl });
  assert.deepEqual(res, { candidates: 2, sent: 2, failed: 0, skipped: 1, reverted: 0, validateOnly: false });
  const [payload] = h.ingests();
  assert.equal(h.ingests().length, 1, 'одна пачка');
  assert.deepEqual(
    payload.events.map((e) => e.transactionId),
    ['ok', 'val']
  );
  assert.equal(payload.validateOnly, false);
  assert.equal(payload.encoding, 'HEX');
  assert.equal(payload.destinations[0].productDestinationId, '999');
  assert.equal(payload.destinations[0].operatingAccount.accountId, '7100619085');
  assert.equal(payload.destinations[0].loginAccount.accountId, '7100619085');
  const byId = Object.fromEntries(h.writes.map((w) => [w.id, w.value]));
  assert.deepEqual(byId[1], {
    sentAt: NOW.toISOString(),
    actionId: '999',
    transactionId: 'ok',
    valueKc: 1081,
    validateOnly: false,
    requestId: 'req-1',
    attempts: 1,
  });
  assert.equal(byId[7].validateOnly, false);
  assert.equal(byId[7].attempts, 1, 'боевой режим считает попытки с нуля');
  assert.deepEqual(byId[5], { skipped: 'no_identifiers', checkedAt: NOW.toISOString() });
  for (const id of [2, 3, 4, 6]) assert.equal(byId[id], undefined, `id ${id} не трогаем`);

  // окно и режим в SQL
  const cand = h.sql.find((s) => s.q.includes('bookings_client_lnk'));
  assert.deepEqual(cand.params, ['2026-09-19', '2026-10-07', 'false', 3, 'false', 200]);
});

test('окно: не старше 80 дней, когда 19.09 уже далеко', async () => {
  const h = harness();
  await S.default.run({ now: new Date('2027-01-20T12:00:00Z'), env: ENV, fetchImpl: h.fetchImpl });
  const cand = h.sql.find((s) => s.q.includes('bookings_client_lnk'));
  assert.equal(cand.params[0], '2026-11-01');
  assert.equal(h.calls.length, 0, 'нет кандидатов — в Google не идём');
});

test('пробный режим помечает validateOnly и повторно не шлёт', async () => {
  const env = { ...ENV, GOOGLE_DM_VALIDATE_ONLY: 'true' };
  const h = harness({
    candidates: [dbRow({ id: 1 }), dbRow({ id: 2, documentId: 'v', ads_conversion: { sentAt: 'x', validateOnly: true } })],
  });
  const res = await S.default.run({ now: NOW, env, fetchImpl: h.fetchImpl });
  assert.equal(res.sent, 1);
  assert.equal(h.ingests()[0].validateOnly, true);
  assert.equal(h.writes[0].value.validateOnly, true);
  assert.deepEqual(h.sql.find((s) => s.q.includes('bookings_client_lnk')).params.slice(2, 5), ['true', 3, 'true']);
});

test('отказ пачки 400 → по одному; попытки копятся до 3', async () => {
  const h = harness({
    candidates: [dbRow({ id: 1, documentId: 'a' }), dbRow({ id: 2, documentId: 'b', ads_conversion: { error: 'old', attempts: 1, validateOnly: false } })],
    ingestReplies: [
      { status: 400, body: { error: { message: 'Invalid event' } } },
      { status: 200, body: { requestId: 'r-a' } },
      { status: 400, body: { error: { message: 'bad gclid' } } },
    ],
  });
  const res = await S.default.run({ now: NOW, env: ENV, fetchImpl: h.fetchImpl });
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
  assert.deepEqual(h.ingests().map((p) => p.events.length), [2, 1, 1]);
  const byId = Object.fromEntries(h.writes.map((w) => [w.id, w.value]));
  assert.equal(byId[1].requestId, 'r-a');
  assert.equal(byId[2].error, '400: bad gclid');
  assert.equal(byId[2].attempts, 2);
  assert.equal(byId[2].sentAt, undefined);
});

test('сбой Google не 400 — ничего не пишем, ошибка наружу', async () => {
  for (const status of [401, 500, 503]) {
    const h = harness({ candidates: [dbRow()], ingestReplies: [{ status, body: { error: { message: 'x' } } }] });
    await assert.rejects(() => S.default.run({ now: NOW, env: ENV, fetchImpl: h.fetchImpl }), /Data Manager API error/);
    assert.equal(h.writes.length, 0, String(status));
  }
  // сеть упала на токене
  const h = harness({ candidates: [dbRow()] });
  const broken = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(() => S.default.run({ now: NOW, env: ENV, fetchImpl: broken }), /ECONNRESET/);
  assert.equal(h.writes.length, 0);
});

test('откат закрытия после отправки — пометка revertedAt', async () => {
  const h = harness({ reverted: [{ id: 9, document_id: 'r', ads_conversion: { sentAt: 's', validateOnly: false, transactionId: 'r' } }] });
  const res = await S.default.run({ now: NOW, env: ENV, fetchImpl: h.fetchImpl });
  assert.equal(res.reverted, 1);
  assert.deepEqual(h.writes[0], { id: 9, value: { sentAt: 's', validateOnly: false, transactionId: 'r', revertedAt: NOW.toISOString() } });
  assert.ok(h.logs.some((l) => l.includes('left checkedOut')));
});

test('SQL выборки: те же условия, что в ineligibleReason/needsSend', () => {
  const src = read('src/api/booking-engine/services/ads-conversions.ts');
  const sql = src.split('const CANDIDATES_SQL = `')[1].split('`;')[0];
  for (const s of [
    "b.status = 'checkedOut'",
    'coalesce(b.internal, false) = false',
    "b.attribution->>'consent' = 'true'",
    'coalesce(b.total_price, 0) > 0',
    "b.ads_conversion->>'skipped' is null",
  ]) {
    assert.ok(sql.includes(s), s);
  }
  const rev = src.split('const REVERTED_SQL = `')[1].split('`;')[0];
  assert.ok(rev.includes("status <> 'checkedOut'"));
});

test('крон под флагом, поле в схеме брони', () => {
  const cron = read('config/cron-tasks.ts');
  const block = cron.split('adsVisitConversions: {')[1]?.split('\n  },')[0] || '';
  assert.ok(block.includes("process.env.ADS_VISIT_CONVERSIONS_ENABLED !== 'true'"));
  assert.ok(block.includes("strapi.service('api::booking-engine.ads-conversions').run()"));
  const schema = JSON.parse(read('src/api/booking/content-types/booking/schema.json'));
  assert.equal(schema.attributes.adsConversion.type, 'json');
});
