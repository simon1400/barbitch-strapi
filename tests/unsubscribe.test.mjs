// Отписка по ссылке из письма (s271): подписанный токен (utils/unsubscribe-token)
// и сервис api::unsubscribe.unsubscribe на заглушке strapi.documents — без БД.
//
// Модуль сервиса собирается из НАСТОЯЩИХ исходников: util подставляется вместо
// строки импорта (без `export`), а не копией в тесте.
//
// Запуск: cd strapi && node --test tests/unsubscribe.test.mjs

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

const utilSrc = read('../src/utils/unsubscribe-token.ts').replace("from 'crypto'", "from 'node:crypto'");
const util = await load(utilSrc);

const svcSrc = read('../src/api/unsubscribe/services/unsubscribe.ts');
const IMPORT_RE = /import \{[^}]*\} from '\.\.\/\.\.\/\.\.\/utils\/unsubscribe-token';/;
assert.ok(IMPORT_RE.test(svcSrc), 'сервис больше не берёт токен из utils/unsubscribe-token');
const svc = (await load(svcSrc.replace(IMPORT_RE, utilSrc.replace(/^export /gm, '')))).default;

const ENV = { CLIENT_JWT_SECRET: 'test-secret', URL: 'https://api.test', PUBLIC_SITE_URL: 'https://site.test' };
const DOC = 'abcdefghij0123456789klmn';

// ── токен ─────────────────────────────────────────────────────────────────

test('токен: подпись проверяется, подделка и чужой секрет — нет', () => {
  const t = util.signUnsubscribeToken(DOC, ENV);
  assert.match(t, /^abcdefghij0123456789klmn\.[A-Za-z0-9_-]{22}$/);
  assert.equal(util.verifyUnsubscribeToken(t, ENV), DOC);
  // другой клиент с той же подписью
  assert.equal(util.verifyUnsubscribeToken(t.replace('abc', 'abd'), ENV), null);
  // испорченная подпись
  const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.equal(util.verifyUnsubscribeToken(bad, ENV), null);
  // другой секрет
  assert.equal(util.verifyUnsubscribeToken(t, { CLIENT_JWT_SECRET: 'other' }), null);
  // UNSUBSCRIBE_SECRET главнее CLIENT_JWT_SECRET
  const own = util.signUnsubscribeToken(DOC, { ...ENV, UNSUBSCRIBE_SECRET: 'own' });
  assert.notEqual(own, t);
  assert.equal(util.verifyUnsubscribeToken(own, { UNSUBSCRIBE_SECRET: 'own' }), DOC);
});

test('токен: мусор и отсутствие секрета → null, ссылок нет', () => {
  for (const v of [undefined, null, 42, '', 'x', `${DOC}`, `${DOC}.`, `../x.${'a'.repeat(22)}`, 'a'.repeat(200)]) {
    assert.equal(util.verifyUnsubscribeToken(v, ENV), null, String(v));
  }
  assert.equal(util.signUnsubscribeToken('bad/id', ENV), null);
  assert.equal(util.unsubscribeEnabled({}), false);
  assert.equal(util.signUnsubscribeToken(DOC, {}), null);
  assert.equal(util.verifyUnsubscribeToken(util.signUnsubscribeToken(DOC, ENV), {}), null);
  assert.equal(util.unsubscribeLinks(DOC, 'comeback', {}), null);
});

test('токен не совпадает с HMAC «голым» секретом (отдельное ключевое пространство)', async () => {
  const crypto = await import('node:crypto');
  const naive = crypto.createHmac('sha256', ENV.CLIENT_JWT_SECRET).update(DOC).digest('base64url').slice(0, 22);
  assert.notEqual(util.signUnsubscribeToken(DOC, ENV).split('.')[1], naive);
});

test('ссылки и заголовки RFC 8058', () => {
  const l = util.unsubscribeLinks(DOC, 'review', ENV);
  const t = util.signUnsubscribeToken(DOC, ENV);
  assert.equal(l.pageUrl, `https://site.test/odhlasit/${t}?z=review`);
  assert.equal(l.oneClickUrl, `https://api.test/api/unsubscribe/${t}?z=review`);
  assert.equal(l.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(
    l.headers['List-Unsubscribe'],
    `<https://api.test/api/unsubscribe/${t}?z=review>, <mailto:info@barbitch.cz?subject=NEZASILAT>`
  );
});

test('maskEmail, originOf, reasonOf', () => {
  assert.equal(util.maskEmail('adela.janeskova@seznam.cz'), 'ad•••@seznam.cz');
  assert.equal(util.maskEmail('ab@x.cz'), 'a•••@x.cz');
  assert.equal(util.maskEmail('nope'), '');
  assert.equal(util.maskEmail(null), '');
  assert.equal(util.originOf('campaign'), 'campaign');
  assert.equal(util.originOf('evil'), null);
  assert.equal(util.reasonOf('too_often'), 'too_often');
  assert.equal(util.reasonOf('drop table'), null);
});

test('причины и источники совпадают с enum схемы журнала', () => {
  const schema = JSON.parse(read('../src/api/unsubscribe/content-types/unsubscribe-log/schema.json'));
  assert.deepEqual(schema.attributes.reason.enum, [...util.UNSUBSCRIBE_REASONS]);
  assert.deepEqual(schema.attributes.origin.enum, [...util.UNSUBSCRIBE_ORIGINS]);
  // и с опросом на сайте (client/src/app/odhlasit/fetch.ts)
  const site = read('../../client/src/app/odhlasit/fetch.ts');
  const keys = [...site.matchAll(/\{ key: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, [...util.UNSUBSCRIBE_REASONS]);
});

// ── сервис на заглушке ────────────────────────────────────────────────────

const setup = (clients) => {
  const db = { clients: new Map(clients.map((c) => [c.documentId, { ...c }])), logs: [] };
  let n = 0;
  const lc = (s) => String(s || '').toLowerCase();
  globalThis.strapi = {
    log: { info() {}, error() {} },
    documents(uid) {
      if (uid === 'api::client.client') {
        return {
          async findOne({ documentId }) {
            const c = db.clients.get(documentId);
            return c ? { ...c } : null;
          },
          async findMany({ filters }) {
            const want = lc(filters.email.$eqi);
            return [...db.clients.values()].filter((c) => lc(c.email) === want).map((c) => ({ ...c }));
          },
          async update({ documentId, data }) {
            Object.assign(db.clients.get(documentId), data);
          },
        };
      }
      if (uid === 'api::unsubscribe.unsubscribe-log') {
        return {
          async create({ data }) {
            db.logs.push({ documentId: `log${++n}`, createdAt: n, ...data });
          },
          async findMany({ filters }) {
            return db.logs
              .filter((l) => l.clientDocId === filters.clientDocId && l.action === filters.action)
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 1);
          },
          async update({ documentId, data }) {
            Object.assign(db.logs.find((l) => l.documentId === documentId), data);
          },
        };
      }
      throw new Error(`unexpected uid ${uid}`);
    },
  };
  return db;
};

const A = 'aaaaaaaaaa0000000000aaaa';
const B = 'bbbbbbbbbb1111111111bbbb';
const C = 'cccccccccc2222222222cccc';

const withEnv = async (fn) => {
  const prev = process.env.CLIENT_JWT_SECRET;
  process.env.CLIENT_JWT_SECRET = ENV.CLIENT_JWT_SECRET;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CLIENT_JWT_SECRET;
    else process.env.CLIENT_JWT_SECRET = prev;
  }
};

test('info: замаскированный адрес и статус; плохой токен → 404', () =>
  withEnv(async () => {
    setup([{ documentId: A, name: 'Adéla', email: 'adela@seznam.cz', reminderOptOut: false }]);
    const t = util.signUnsubscribeToken(A, ENV);
    assert.deepEqual(await svc.info(t), { email: 'ad•••@seznam.cz', optedOut: false });
    await assert.rejects(svc.info('nonsense'), { status: 404, code: 'invalid_token' });
    // подпись верная, но карточки нет (удалена/слита)
    await assert.rejects(svc.info(util.signUnsubscribeToken(C, ENV)), { status: 404 });
  }));

test('отписка: флаг на всех карточках с той же почтой (без регистра), одна строка журнала', () =>
  withEnv(async () => {
    const db = setup([
      { documentId: A, name: 'Adéla', email: 'adela@seznam.cz', reminderOptOut: false },
      { documentId: B, name: 'Adéla J.', email: 'Adela@Seznam.CZ', reminderOptOut: false },
      { documentId: C, name: 'Jiná', email: 'jina@seznam.cz', reminderOptOut: false },
    ]);
    const t = util.signUnsubscribeToken(A, ENV);
    const r = await svc.unsubscribe(t, { via: 'one_click', origin: 'comeback' });
    assert.equal(r.optedOut, true);
    assert.equal(db.clients.get(A).reminderOptOut, true);
    assert.equal(db.clients.get(B).reminderOptOut, true);
    assert.equal(db.clients.get(C).reminderOptOut, false);
    assert.equal(db.logs.length, 1);
    assert.equal(db.logs[0].action, 'unsubscribe');
    assert.equal(db.logs[0].via, 'one_click');
    assert.equal(db.logs[0].origin, 'comeback');
    // повтор (сканер/двойной клик) — без новой строки
    await svc.unsubscribe(t, { via: 'link' });
    assert.equal(db.logs.length, 1);
  }));

test('причина: только после отписки, пишется в последнюю строку; плохие данные → 400', () =>
  withEnv(async () => {
    const db = setup([{ documentId: A, name: 'Adéla', email: 'adela@seznam.cz', reminderOptOut: false }]);
    const t = util.signUnsubscribeToken(A, ENV);
    await assert.rejects(svc.reason(t, { reason: 'too_often' }), { status: 409, code: 'not_unsubscribed' });
    await svc.unsubscribe(t, { via: 'link', origin: 'campaign' });
    await assert.rejects(svc.reason(t, { reason: 'hack' }), { status: 400, code: 'bad_reason' });
    await assert.rejects(svc.reason(t, { reason: 'other', comment: 'x'.repeat(501) }), {
      status: 400,
      code: 'comment_too_long',
    });
    assert.deepEqual(await svc.reason(t, { reason: 'too_often', comment: '  moc často  ' }), { ok: true });
    assert.equal(db.logs.length, 1);
    assert.equal(db.logs[0].reason, 'too_often');
    assert.equal(db.logs[0].comment, 'moc často');
  }));

test('причина у отписанной вручную (NEZASÍLAT, без журнала) — заводит строку', () =>
  withEnv(async () => {
    const db = setup([{ documentId: A, name: 'Adéla', email: 'adela@seznam.cz', reminderOptOut: true }]);
    await svc.reason(util.signUnsubscribeToken(A, ENV), { reason: 'not_coming' });
    assert.equal(db.logs.length, 1);
    assert.equal(db.logs[0].reason, 'not_coming');
    assert.equal(db.logs[0].comment, null);
  }));

test('возврат: снимает флаг со всех карточек почты, строка resubscribe', () =>
  withEnv(async () => {
    const db = setup([
      { documentId: A, name: 'Adéla', email: 'adela@seznam.cz', reminderOptOut: true },
      { documentId: B, name: 'Adéla J.', email: 'ADELA@seznam.cz', reminderOptOut: true },
    ]);
    const t = util.signUnsubscribeToken(A, ENV);
    const r = await svc.resubscribe(t, { origin: 'review' });
    assert.equal(r.optedOut, false);
    assert.equal(db.clients.get(A).reminderOptOut, false);
    assert.equal(db.clients.get(B).reminderOptOut, false);
    assert.equal(db.logs.length, 1);
    assert.equal(db.logs[0].action, 'resubscribe');
    // повторный возврат — без строки
    await svc.resubscribe(t);
    assert.equal(db.logs.length, 1);
  }));

test('карточка без почты: отписка только её', () =>
  withEnv(async () => {
    const db = setup([{ documentId: A, name: 'Bez mailu', email: null, reminderOptOut: false }]);
    await svc.unsubscribe(util.signUnsubscribeToken(A, ENV), { via: 'link' });
    assert.equal(db.clients.get(A).reminderOptOut, true);
  }));

// ── письма: ссылка в тексте и заголовки ──────────────────────────────────

test('сервисы писем передают ссылку и заголовки; campaign не берёт unsubscribeUrl из браузера', () => {
  for (const [file, origin, builder] of [
    ['../src/api/comeback-reminder/services/comeback-reminder.ts', 'comeback', 'buildComeback'],
    ['../src/api/review-request/services/review-request.ts', 'review', 'buildReviewRequest'],
  ]) {
    const s = read(file);
    assert.ok(s.includes(`unsubscribeLinks(clientDocId, '${origin}')`), file);
    assert.ok(s.includes(`notify.${builder}({ ...view, unsubscribeUrl: links?.pageUrl })`), file);
    assert.ok(s.includes('headers: links?.headers'), file);
  }
  const notify = read('../src/api/booking-engine/services/booking-notify.ts');
  assert.ok(notify.includes('...(headers ? { headers } : {})'), 'sendEmail не передаёт headers в Resend');
  assert.ok(notify.includes('optOutLine(cv.unsubscribeUrl'));
  assert.ok(notify.includes('optOutLine(rv.unsubscribeUrl'));
  const campaign = read('../src/api/campaign/services/campaign.ts');
  assert.ok(campaign.includes("const { unsubscribeUrl: _fromBrowser, ...vars } = r?.variables || {};"));
});
