// Юнит-тесты правки карточки клиента (client-dedupe.updateClient) — без БД и Strapi.
//
// Эту ручку с s205 дёргает не только страница «Дубли клиентов», но и модал
// «Hledat klienta» в календаре (owner + administrator правят имя/телефон/почту,
// не открывая Strapi). Здесь проверяется серверная половина: нормализация
// телефона, валидация, переименование броней, журнал и поиск чужих карточек
// с тем же контактом.
//
// 🟥 Как загружается модуль. `client-dedupe.ts` импортирует `normalizePhone` из
// движка (файл на 2500 строк со своими импортами) — тянуть его сюда незачем, но
// и КОПИРОВАТЬ функцию в тест нельзя: копия разойдётся с оригиналом и тест
// станет врать. Поэтому исходный текст функции ВЫРЕЗАЕТСЯ из booking-engine.ts
// и подставляется вместо строки импорта — проверяется настоящая реализация,
// а её пропажа/переименование роняют тест на месте.
//
// Запуск: cd strapi && node --test tests/client-update.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = import.meta.dirname;
const engineSrc = fs.readFileSync(
  path.resolve(here, '../src/api/booking-engine/services/booking-engine.ts'),
  'utf8'
);
const NORM_RE = /export const normalizePhone = \([\s\S]*?\r?\n\};\r?\n/
const normSrc = NORM_RE.exec(engineSrc);
assert.ok(normSrc, 'normalizePhone не найден в booking-engine.ts — тест бы проверял копию');

const dedupeSrc = fs.readFileSync(
  path.resolve(here, '../src/api/client-dedupe/services/client-dedupe.ts'),
  'utf8'
);
const IMPORT_LINE = "import { normalizePhone } from '../../booking-engine/services/booking-engine';";
assert.ok(dedupeSrc.includes(IMPORT_LINE), 'client-dedupe больше не берёт normalizePhone из движка');

const stitched = dedupeSrc.replace(IMPORT_LINE, normSrc[0].replace('export const', 'const'));
const js = ts.transpileModule(stitched, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const svc = mod.default;

// ── заглушка knex: цепочка запоминает вызовы, ответы задаются по таблице ────

class QB {
  constructor(table, ctx) {
    this.table = table;
    this.ctx = ctx;
    this.ops = [];
    this.rawWheres = [];
  }
  _rec(op, args) {
    this.ops.push([op, ...args]);
    return this;
  }
  where(...a) {
    if (typeof a[0] === 'function') {
      a[0].call(this, this);
      return this;
    }
    return this._rec('where', a);
  }
  whereNot(...a) { return this._rec('whereNot', a); }
  whereIn(...a) { return this._rec('whereIn', a); }
  orWhereRaw(sql, binds) {
    this.rawWheres.push([sql, binds]);
    return this;
  }
  select(...a) { return this._rec('select', a); }
  limit(...a) { return this._rec('limit', a); }
  update(data) {
    this.ctx.updates.push({ table: this.table, data, ops: this.ops.slice() });
    return Promise.resolve(this.ctx.updateCount ?? 1);
  }
  then(resolve, reject) {
    try {
      this.ctx.selects.push({ table: this.table, ops: this.ops.slice(), rawWheres: this.rawWheres.slice() });
      resolve(this.ctx.rows[this.table] ?? []);
    } catch (e) {
      reject(e);
    }
  }
}

const mkKnex = (ctx) => {
  const knex = (table) => new QB(table, ctx);
  knex.transaction = async (cb) => cb(knex);
  return knex;
};

const CLIENT_ROW = {
  id: 7,
  document_id: 'cl-1',
  name: 'Monika Csuportová',
  phone: '+420606878910',
  email: 'moni.suportova@gmail.com',
  blacklisted: false,
};

// вызов updateClient на подставном контексте; возвращает результат + что ушло в БД и лог
const run = async (patch, { renameBookings = true, row = CLIENT_ROW, conflicts = [], updateCount = 2 } = {}) => {
  const ctx = { updates: [], selects: [], rows: { clients: conflicts }, updateCount };
  const logs = [];
  const calendarLogs = [];
  globalThis.strapi = {
    log: { warn() {}, error() {} },
    service: (uid) => ({
      write: async (entry) => {
        assert.equal(uid, 'api::calendar-log.calendar-log');
        calendarLogs.push(entry);
      },
    }),
    documents: () => ({ create: async () => ({}) }),
  };
  const self = {
    knex: () => mkKnex(ctx),
    rowsByDocIds: async () => [row],
    log: async (action, entry) => logs.push({ action, ...entry }),
    contactConflicts: svc.contactConflicts,
  };
  const res = await svc.updateClient.call(self, {
    docId: row.document_id,
    patch,
    actorName: 'Viktoriia',
    renameBookings,
  });
  // write() у журнала вызывается без await (fire-and-forget) — даём микротаск
  await Promise.resolve();
  await Promise.resolve();
  return { res, ctx, logs, calendarLogs };
};

const clientUpdate = (ctx) => ctx.updates.find((u) => u.table === 'clients')?.data;

// ── телефон ────────────────────────────────────────────────────────────────

test('телефон из 9 цифр приводится к чешскому +420 (иначе бронь с сайта не найдёт карточку)', async () => {
  const { ctx, res } = await run({ phone: '606 878 911' });
  assert.equal(clientUpdate(ctx).phone, '+420606878911');
  assert.equal(res.phone, '+420606878911', 'ответ отдаёт то, что реально легло в базу');
});

test('международный номер сохраняет свой код', async () => {
  const { ctx } = await run({ phone: '+421 903 111 222' });
  assert.equal(clientUpdate(ctx).phone, '+421903111222');
});

test('запись через 00 приводится к +', async () => {
  const { ctx } = await run({ phone: '00420606878911' });
  assert.equal(clientUpdate(ctx).phone, '+420606878911');
});

test('мусор вместо номера — 400 bad_phone, база не тронута', async () => {
  const ctx = { updates: [], selects: [], rows: {} };
  const self = { knex: () => mkKnex(ctx), rowsByDocIds: async () => [CLIENT_ROW], log: async () => {} };
  await assert.rejects(
    () => svc.updateClient.call(self, { docId: 'cl-1', patch: { phone: 'nemá telefon' }, actorName: 'X' }),
    (e) => e.status === 400 && e.code === 'bad_phone'
  );
  assert.equal(ctx.updates.length, 0);
});

test('короткий номер тоже отбивается (меньше 9 цифр)', async () => {
  const ctx = { updates: [], selects: [], rows: {} };
  const self = { knex: () => mkKnex(ctx), rowsByDocIds: async () => [CLIENT_ROW], log: async () => {} };
  await assert.rejects(
    () => svc.updateClient.call(self, { docId: 'cl-1', patch: { phone: '12345' }, actorName: 'X' }),
    (e) => e.code === 'bad_phone'
  );
});

test('пустой телефон стирается в null, а не в пустую строку', async () => {
  const { ctx } = await run({ phone: '' });
  assert.equal(clientUpdate(ctx).phone, null);
});

// ── почта и имя ────────────────────────────────────────────────────────────

test('e-mail приводится к нижнему регистру', async () => {
  const { ctx } = await run({ email: 'Moni.Suportova@Gmail.COM' });
  assert.equal(clientUpdate(ctx).email, 'moni.suportova@gmail.com');
});

test('кривой e-mail — 400 bad_email', async () => {
  const ctx = { updates: [], selects: [], rows: {} };
  const self = { knex: () => mkKnex(ctx), rowsByDocIds: async () => [CLIENT_ROW], log: async () => {} };
  await assert.rejects(
    () => svc.updateClient.call(self, { docId: 'cl-1', patch: { email: 'moni@' }, actorName: 'X' }),
    (e) => e.code === 'bad_email'
  );
  assert.equal(ctx.updates.length, 0);
});

test('пустое имя — 400 name_required', async () => {
  const ctx = { updates: [], selects: [], rows: {} };
  const self = { knex: () => mkKnex(ctx), rowsByDocIds: async () => [CLIENT_ROW], log: async () => {} };
  await assert.rejects(
    () => svc.updateClient.call(self, { docId: 'cl-1', patch: { name: '   ' }, actorName: 'X' }),
    (e) => e.code === 'name_required'
  );
});

test('пустой patch ничего не пишет', async () => {
  const { ctx, res, calendarLogs } = await run({});
  assert.equal(ctx.updates.length, 0);
  assert.equal(res.renamedBookings, 0);
  assert.equal(calendarLogs.length, 0);
});

// ── имя в бронях ───────────────────────────────────────────────────────────

test('renameBookings=true переписывает имя в бронях клиента', async () => {
  const { ctx, res } = await run({ name: 'Monika Csupotová' }, { renameBookings: true });
  const b = ctx.updates.find((u) => u.table === 'bookings');
  assert.ok(b, 'брони обновлены');
  assert.deepEqual(b.data, { client_name_raw: 'Monika Csupotová' });
  assert.equal(res.renamedBookings, 2);
});

test('renameBookings=false оставляет имя в бронях как было', async () => {
  const { ctx, res } = await run({ name: 'Monika Csupotová' }, { renameBookings: false });
  assert.equal(ctx.updates.find((u) => u.table === 'bookings'), undefined);
  assert.equal(res.renamedBookings, 0);
});

test('правка только телефона броней не касается', async () => {
  const { ctx } = await run({ phone: '606878911' }, { renameBookings: true });
  assert.equal(ctx.updates.find((u) => u.table === 'bookings'), undefined);
});

// ── журнал календаря ───────────────────────────────────────────────────────

test('правка попадает в журнал календаря как «старое → новое»', async () => {
  const { calendarLogs } = await run({ phone: '606878911', email: 'nova@seznam.cz' });
  assert.equal(calendarLogs.length, 1);
  const e = calendarLogs[0];
  assert.equal(e.action, 'client_edit');
  assert.equal(e.entityType, 'client');
  assert.equal(e.actorName, 'Viktoriia');
  assert.equal(e.entityDocId, 'cl-1');
  assert.equal(e.details.telefon, '+420606878910 → +420606878911');
  assert.equal(e.details['e-mail'], 'moni.suportova@gmail.com → nova@seznam.cz');
  assert.ok(e.summary.includes('Monika Csuportová'));
  assert.ok(e.summary.includes('telefon, e-mail'));
});

test('очистка контакта видна в журнале как прочерк', async () => {
  const { calendarLogs } = await run({ email: '' });
  assert.equal(calendarLogs[0].details['e-mail'], 'moni.suportova@gmail.com → —');
});

test('переименование пишет в журнал и число задетых броней', async () => {
  const { calendarLogs } = await run({ name: 'Monika Csupotová' });
  assert.equal(calendarLogs[0].details['jméno'], 'Monika Csuportová → Monika Csupotová');
  assert.equal(calendarLogs[0].details['rezervace přepsány'], 2);
  assert.ok(!calendarLogs[0].summary.includes('rezervace'), 'в заголовке только изменённые поля');
});

test('пересохранение без фактических изменений журнал не засоряет', async () => {
  const { calendarLogs, ctx } = await run({ name: CLIENT_ROW.name, phone: CLIENT_ROW.phone });
  assert.ok(clientUpdate(ctx), 'запись всё же обновляется (updated_at)');
  assert.equal(calendarLogs.length, 0, 'но в журнал писать нечего');
});

// ── чужие карточки с тем же контактом ──────────────────────────────────────

test('после смены телефона возвращается чужая карточка с тем же номером', async () => {
  const other = { document_id: 'cl-2', name: 'Monika Csuportova', phone: '+420 606 878 911', email: null };
  const { res, ctx } = await run({ phone: '606878911' }, { conflicts: [other] });
  assert.deepEqual(res.duplicates, [
    { documentId: 'cl-2', name: 'Monika Csuportova', phone: '+420 606 878 911', email: null },
  ]);
  const q = ctx.selects.at(-1);
  assert.deepEqual(q.ops.find((o) => o[0] === 'whereNot'), ['whereNot', 'id', 7], 'сама карточка исключена');
  assert.equal(q.rawWheres.length, 1, 'ищем только по изменённому полю');
  assert.ok(q.rawWheres[0][0].includes('right(regexp_replace'), q.rawWheres[0][0]);
  assert.deepEqual(q.rawWheres[0][1], ['606878911'], 'сравниваем по последним 9 цифрам');
});

test('смена почты ищет дубль по почте в нижнем регистре', async () => {
  const { ctx } = await run({ email: 'Nova@Seznam.cz' }, { conflicts: [] });
  const q = ctx.selects.at(-1);
  assert.equal(q.rawWheres.length, 1);
  assert.ok(q.rawWheres[0][0].includes('lower(trim'), q.rawWheres[0][0]);
  assert.deepEqual(q.rawWheres[0][1], ['nova@seznam.cz']);
});

test('правка одного имени дублей не ищет вовсе', async () => {
  const { res, ctx } = await run({ name: 'Monika C.' });
  assert.deepEqual(res.duplicates, []);
  assert.equal(ctx.selects.length, 0, 'лишнего запроса в clients нет');
});

// ⚠️ Телефон приехал в patch, но не изменился (админ пересохранил карточку, правя
// имя): дубли по нему искать незачем — иначе владелец получает предупреждение
// «есть такая же карточка» на каждое сохранение, хотя контакт никто не трогал.
test('неизменившийся телефон в patch дублей не ищет', async () => {
  const other = { document_id: 'cl-2', name: 'Dvojnice', phone: CLIENT_ROW.phone, email: null };
  const { res, ctx } = await run({ name: 'Monika C.', phone: CLIENT_ROW.phone }, { conflicts: [other] });
  assert.deepEqual(res.duplicates, []);
  assert.equal(ctx.selects.length, 0);
});
