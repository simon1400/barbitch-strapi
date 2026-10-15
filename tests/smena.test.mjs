// «Směna administrátora» (services/smena.ts, s263 — Фаза 1 плана ADMIN_SHIFT_NEXT_SESSION_PROMPT.md):
//   - дата: будущее — нельзя; запись — сегодня и BACKFILL_DAYS назад; руководство читает любой прошедший день;
//   - касса: остаток = предыдущий остаток + Σ строк (как lifecycle `cash`), иначе 400 с числами;
//     «Zapsat rozdíl» с причиной — сервер сам добавляет строку, журнал, push (под env);
//     строку-расхождение руками не завести; есть касса позже по дате — Σ строк не менять;
//     опубликовано — 409; чужая правка между чтением и записью — 409 stale; две кассы дня — 409;
//   - движок и НАСТОЯЩИЙ lifecycle `cash` согласны (lifecycle гоняется на заглушке базы);
//   - часы: сетка 30 мин 08:00–21:00, часы = конец − начало, комментарий → HTML и обратно;
//     только роль administrator, своя карточка; удаление — только черновик;
//   - задачи «hotovo» за день (по Праге), сводка руководству для «Uzavření směny».
//   - s265 «Předání směny»: сообщение коллеге + задачи ей + передача своих одной кнопкой; частичный
//     сбой задачи сообщение не роняет; одно непрочитанное на (день, от, кому) — повтор правит его;
//     «Přečteno» — только получательница; входящие — непрочитанные и прочитанные сегодня; push —
//     одна сводка получательнице; подсказка «кто следующий» из графика; сводка руководству.
//   - s266 (Фаза 3): руководство — любой прошедший день и часы любой администраторки (`personal`);
//     «Kontrola směny» через тот же runSelfCheck; «не заполнено» §5.3 (брони/дежурный), расхождения
//     в незакрытых сменах, непрочитанные передачи ≥ 3 дней; напоминания 20:30/09:30 под env;
//     текст её записей дня и вложения задач в сводке.
// Запуск: cd strapi && node --test tests/smena.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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

let js = toJs('src/api/booking-engine/services/smena.ts');
for (const [from, file] of [
  ["from './slots-core'", 'src/api/booking-engine/services/slots-core.ts'],
  ["from '../../../utils/staff-identity'", 'src/utils/staff-identity.ts'],
  ["from '../../../utils/staff-roster'", 'src/utils/staff-roster.ts'],
]) {
  assert.ok(js.includes(from), from);
  js = js.split(from).join(`from '${dataUrl(toJs(file))}'`);
}
const S = await import(dataUrl(js));
const svc = S.default;

// настоящий lifecycle кассы; ValidationError — заглушка с тем же именем
const ERRORS_URL = dataUrl(
  "class ValidationError extends Error { constructor(m, d) { super(m); this.name = 'ValidationError'; this.details = d; } } export const errors = { ValidationError };"
);
let lcJs = toJs('src/api/cash/content-types/cash/lifecycles.ts');
assert.ok(lcJs.includes("from '@strapi/utils'"));
lcJs = lcJs.split("from '@strapi/utils'").join(`from '${ERRORS_URL}'`);
const lifecycle = (await import(dataUrl(lcJs))).default;

const CASH = 'api::cash.cash';
const WORK = 'api::work-time.work-time';
const FLOW = 'items.money-flow';
const PERSONAL = 'api::personal.personal';
const ADMIN = 'api::admin-user.admin-user';
const TASK = 'api::owner-task.owner-task';
const LOG = 'api::calendar-log.calendar-log';
const HANDOVER = 'api::shift-handover.shift-handover';
const SHIFT = 'api::shift.shift';

const VIKA = 'vika00000000000000000001';
const JULIA = 'julia0000000000000000002';
const MARIIA = 'mariia000000000000000003';
const NOCARD = { id: 19, role: 'administrator', username: 'Bez Karty' };
const vika = { id: 11, role: 'administrator', username: 'Viktoriia Tsybuliak', personalDocId: VIKA };
const julia = { id: 12, role: 'administrator', username: 'Yuliya', personalDocId: JULIA };
const manager = { id: 13, role: 'manager', username: 'Mariia Medvedeva', personalDocId: MARIIA };
const owner = { id: 1, role: 'owner', username: 'Dima' };
const master = { id: 20, role: 'master', username: 'Karina' };

const NOW = new Date('2026-10-15T14:00:00Z'); // Прага 16:00, сегодня 15.10

// ── заглушка базы: документы с черновиком и опубликованной версией ─────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

const valOf = (row, key, db) => {
  if (key === 'personal') return row.personalDocId ? { documentId: row.personalDocId, name: db[PERSONAL].find((p) => p.documentId === row.personalDocId)?.name } : null;
  return row[key];
};
const matchCond = (val, cond) => {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return val === cond;
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$eq') return val === arg;
    if (op === '$ne') return val !== arg;
    if (op === '$eqi') return String(val ?? '').toLowerCase() === String(arg).toLowerCase();
    if (op === '$lt') return val != null && val < arg;
    if (op === '$gt') return val != null && val > arg;
    if (op === '$gte') return val != null && val >= arg;
    if (op === '$lte') return val != null && val <= arg;
    if (op === '$in') return arg.includes(val);
    if (op === '$null') return arg ? val == null : val != null;
    if (op === '$startsWith') return String(val ?? '').startsWith(arg);
    return val != null && matchCond(val[op], arg);
  });
};
const matches = (row, filters, db) =>
  Object.entries(filters || {}).every(([k, c]) => (k === '$or' ? c.some((f) => matches(row, f, db)) : matchCond(valOf(row, k, db), c)));

let seq = 1;
const docId = (p) => `${p}${String(seq++).padStart(20 - p.length, '0')}x`.slice(0, 24);

function makeStrapi() {
  const db = {
    [PERSONAL]: [
      { documentId: VIKA, name: 'Viktoriia Tsybuliak', isActive: true },
      { documentId: JULIA, name: 'Yuliya Popchanka', isActive: true },
      { documentId: MARIIA, name: 'Mariia Medvedeva', isActive: true, position: 'manager' },
    ],
    [ADMIN]: [
      { username: 'Viktoriia Tsybuliak', role: 'administrator', isActive: true, personalDocId: VIKA },
      { username: 'Yuliya', role: 'administrator', isActive: true, personalDocId: JULIA },
      { username: 'Bez Karty', role: 'administrator', isActive: true, personalDocId: null },
    ],
    [CASH]: [],
    [WORK]: [],
    [TASK]: [],
    [HANDOVER]: [],
    [SHIFT]: [],
  };
  const flowRows = new Map();
  const logs = [];
  const pushes = [];
  let flowId = 1;

  const withComponents = (uid, data) => {
    if (uid !== CASH || !Array.isArray(data.flow)) return data;
    const flow = data.flow.map((f) => {
      const id = flowId++;
      flowRows.set(id, { id, sum: String(f.sum), coment: f.coment ?? null });
      return { id };
    });
    return { ...data, flow };
  };
  const expand = (uid, row, populate) => {
    const out = clone(row);
    if (uid === CASH || uid === WORK) delete out.personalDocId;
    if (populate?.personal) out.personal = valOf(row, 'personal', db);
    if (uid === CASH && populate?.flow) out.flow = (row.flow || []).map((f) => clone(flowRows.get(f.id)));
    else delete out.flow;
    return out;
  };
  const versionFilter = (status) => (r) => (status === 'published' ? r.publishedAt != null : r.publishedAt == null);
  const sortRows = (rows, sort) => {
    const key = sort && !Array.isArray(sort) && sort.date ? 'date' : null;
    if (key) return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return rows.sort((a, b) => a.id - b.id);
  };
  let idSeq = 1;
  const documents = (uid) => ({
    async findMany({ status = 'draft', filters, populate, sort, limit } = {}) {
      await tick();
      const rows = sortRows(db[uid].filter((r) => (r.publishedAt === undefined || versionFilter(status)(r)) && matches(r, filters, db)), sort);
      return rows.slice(0, limit ?? 100).map((r) => expand(uid, r, populate));
    },
    async findFirst({ status = 'draft', filters, sort, populate } = {}) {
      return (await this.findMany({ status, filters, sort, populate, limit: 1 }))[0] || null;
    },
    async create({ data }) {
      await tick();
      const documentId = docId(uid === CASH ? 'cash' : uid === HANDOVER ? 'hand' : 'work');
      const { personal, ...rest } = data;
      const params = { data: { ...withComponents(uid, rest), documentId } };
      if (uid === CASH) await lifecycle.beforeCreate({ params });
      const row = { id: idSeq++, documentId, personalDocId: personal || null, publishedAt: uid === HANDOVER ? undefined : null, createdAt: strapi.clock || NOW.toISOString(), updatedAt: new Date(Date.now() + idSeq).toISOString(), ...params.data };
      db[uid].push(row);
      return expand(uid, row, {});
    },
    async findOne({ documentId }) {
      await tick();
      const row = db[uid].find((r) => r.documentId === documentId);
      return row ? expand(uid, row, {}) : null;
    },
    async update({ documentId, data }) {
      await tick();
      const row = db[uid].find((r) => r.documentId === documentId && r.publishedAt == null);
      const params = { data: withComponents(uid, data) };
      if (uid === CASH) await lifecycle.beforeUpdate({ params });
      Object.assign(row, params.data, { updatedAt: new Date(Date.now() + idSeq++).toISOString() });
      return expand(uid, row, {});
    },
    async delete({ documentId }) {
      await tick();
      db[uid] = db[uid].filter((r) => r.documentId !== documentId);
    },
  });
  const strapi = {
    rows: db,
    flowRows,
    logs,
    pushes,
    taskCalls: [],
    clock: null,
    visitsOpen: [],
    bookings: [],
    selfChecks: [],
    taskFiles: new Map(),
    documents,
    db: {
      query: (uid) => {
        if (uid === FLOW) return { findMany: async ({ where }) => where.id.$in.map((id) => clone(flowRows.get(id))).filter(Boolean) };
        assert.equal(uid, LOG);
        return {
          findOne: async ({ where }) =>
            [...logs].reverse().find((l) => l.entityType === where.entityType && l.entityDocId === where.entityDocId && l.action.startsWith(where.action.$startsWith)) || null,
          // s266: кто записал расхождение
          findMany: async ({ where }) => logs.filter((l) => l.entityType === where.entityType && l.action === where.action && where.entityDocId.$in.includes(l.entityDocId)),
        };
      },
      // s266: брони по дням (салон работал) — knex-цепочка `bookings`
      connection: Object.assign(
        (table) => {
          assert.equal(table, 'bookings');
          const conds = [];
          const q = {
            where(col, op, val) {
              conds.push((r) => (op === '>=' ? r[col] >= val : op === '<=' ? r[col] <= val : r[col] === op));
              return q;
            },
            whereIn(col, vals) {
              conds.push((r) => vals.includes(r[col]));
              return q;
            },
            select: () => q,
            async groupByRaw() {
              const m = new Map();
              for (const b of strapi.bookings.filter((r) => conds.every((c) => c(r)))) m.set(b.date, (m.get(b.date) || 0) + 1);
              return [...m].map(([date, n]) => ({ date, n: String(n) }));
            },
          };
          return q;
        },
        { raw: (x) => x }
      ),
    },
    service: (uid) => {
      if (uid === 'api::calendar-log.calendar-log') return { write: async (e) => void logs.push(clone(e)) };
      if (uid === 'api::booking-engine.today') return { unclosedVisits: async (range) => strapi.visitsOpen.filter((v) => v.date >= range.from && v.date <= range.to) };
      if (uid === 'api::booking-engine.manager-notify') {
        return {
          toOwner: async (p, kind) => void pushes.push({ to: 'owner', kind, ...p }),
          toManagers: async (p, kind) => void pushes.push({ to: 'managers', kind, ...p }),
          // s265: сводка передачи смены — получательнице
          toAdmin: async (person, p, kind) => void pushes.push({ to: `admin:${person.documentId}`, kind, ...p }),
          // s266: напоминание, когда не знаем, кто на смене
          toAdmins: async (p, kind) => void pushes.push({ to: 'admins', kind, ...p }),
        };
      }
      // s266: «Kontrola směny» — тот же сервис, что у виджета панели
      if (uid === 'api::shift-selfcheck.shift-selfcheck') {
        return { runSelfCheck: async (date) => (strapi.selfChecks.push(date), { date, ok: true, problemCount: 0 }) };
      }
      // s265: задачи — заглушка owner-tasks (настоящий сервис проверяется в owner-tasks.test.mjs)
      if (uid === 'api::booking-engine.owner-tasks') {
        return {
          async create({ session, body, quiet }) {
            await tick();
            strapi.taskCalls.push({ op: 'create', by: session.username, quiet, ...clone(body) });
            if (body.title === 'FAIL') throw Object.assign(new Error('Vyberte kolegyni'), { status: 400, code: 'bad_personal' });
            const row = { documentId: docId('task'), title: body.title, status: 'open', assignee: 'administrator', personalDocId: body.personal, events: [] };
            db[TASK].push(row);
            return { task: { documentId: row.documentId } };
          },
          async act({ session, id, body, quiet }) {
            await tick();
            strapi.taskCalls.push({ op: 'act', by: session.username, id, quiet, ...clone(body) });
            const row = db[TASK].find((t) => t.documentId === id);
            if (!row) throw Object.assign(new Error('Úkol nenalezen'), { status: 404, code: 'task_not_found' });
            row.personalDocId = body.to;
            return { task: { documentId: id } };
          },
          // s266: вложения задач для сводки «Uzavření směny»
          async _filesFor(ids) {
            return new Map(ids.filter((id) => strapi.taskFiles.has(id)).map((id) => [id, strapi.taskFiles.get(id)]));
          },
        };
      }
      throw new Error(`unexpected service ${uid}`);
    },
    log: { error() {}, info() {} },
  };
  return strapi;
}

let st;
beforeEach(() => {
  st = globalThis.strapi = makeStrapi();
  delete process.env.SMENA_PUSH_ENABLED;
});

/** Готовая касса из истории (как из панели, мимо lifecycle): остаток, строки, приход месяца. */
let seedId = 900;
const seedCash = async (date, sum, flow, { published = false, profit = 0 } = {}) => {
  const documentId = docId('seed');
  const row = {
    id: seedId++,
    documentId,
    date,
    sum: String(sum),
    profit: String(profit),
    comment: '',
    personalDocId: null,
    publishedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    flow: flow.map((x) => {
      const id = 10000 + seedId * 10 + st.flowRows.size;
      st.flowRows.set(id, { id, sum: String(x), coment: x < 0 ? 'nákup' : '' });
      return { id };
    }),
  };
  st.rows[CASH].push(row);
  if (published) st.rows[CASH].push({ ...clone(row), id: seedId++, publishedAt: NOW.toISOString() });
  return row;
};
const save = (session, date, body) => svc.saveCash({ session, date, body, now: NOW });
const rejects = async (p, code, extra = {}) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, `${e.code} ≠ ${code}: ${e.message}`);
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(e.details?.[k], v, k);
    return true;
  });
};

// ── чистые функции ───────────────────────────────────────────────────────────

test('дата: будущее нельзя, запись — окно 2 дня, руководство читает историю', () => {
  const today = '2026-10-15';
  assert.equal(S.checkDate('2026-10-13', today, { write: true, management: false }), '2026-10-13');
  assert.throws(() => S.checkDate('2026-10-12', today, { write: true, management: false }), { code: 'out_of_window' });
  // s266 (Фаза 3): руководство пишет любой прошедший день
  assert.equal(S.checkDate('2026-10-12', today, { write: true, management: true }), '2026-10-12');
  assert.throws(() => S.checkDate('2026-10-12', today, { write: false, management: false }), { code: 'out_of_window' });
  assert.equal(S.checkDate('2026-09-01', today, { write: false, management: true }), '2026-09-01');
  assert.throws(() => S.checkDate('2026-10-16', today, { write: false, management: true }), { code: 'out_of_window' });
  for (const bad of ['2026-02-30', '15.10.2026', '', null, '2019-12-31']) assert.throws(() => S.checkDate(bad, today, { write: false, management: true }), { code: 'bad_date' });
});

test('строки кассы: целые ≠ 0, у расхода — описание, ошибка несёт индекс строки', () => {
  assert.deepEqual(S.normalizeFlow([{ sum: 1550, comment: ' Tržba  hotově ' }, { sum: '-350', comment: 'Nákup — kafe' }]), [
    { sum: 1550, comment: 'Tržba hotově' },
    { sum: -350, comment: 'Nákup — kafe' },
  ]);
  // день без наличных (как на проде): пусто или одна строка 0 → одна строка 0 без описания
  assert.deepEqual(S.normalizeFlow([]), [{ sum: 0, comment: '' }]);
  assert.deepEqual(S.normalizeFlow([{ sum: 0 }]), [{ sum: 0, comment: '' }]);
  assert.deepEqual(S.normalizeFlow([{ sum: '0', comment: 'x' }]), [{ sum: 0, comment: '' }]);
  assert.equal(S.isNoMovement([{ sum: '0' }]), true);
  assert.equal(S.isNoMovement([{ sum: 0 }, { sum: 5 }]), false);
  assert.throws(() => S.normalizeFlow('x'), { code: 'bad_flow' });
  assert.throws(() => S.normalizeFlow(Array.from({ length: S.MAX_FLOW_LINES + 1 }, () => ({ sum: 1 }))), { code: 'bad_flow' });
  for (const [sum, i] of [[0, 1], [12.5, 1], ['abc', 1], [S.MAX_LINE_SUM + 1, 1], ['', 1]]) {
    assert.throws(() => S.normalizeFlow([{ sum: 100 }, { sum, comment: 'x' }]), (e) => e.code === 'bad_line' && e.details.index === i && e.details.field === 'flow.sum');
  }
  assert.throws(() => S.normalizeFlow([{ sum: 100 }, { sum: -100, comment: '  ' }]), (e) => e.code === 'line_comment_required' && e.details.index === 1);
  // приход без описания — можно (§8.4)
  assert.deepEqual(S.normalizeFlow([{ sum: 100 }]), [{ sum: 100, comment: '' }]);
});

test('остаток: не сходится — 400 с числами; «Zapsat rozdíl» с причиной — строка от сервера', () => {
  const flow = [{ sum: 1550, comment: '' }, { sum: -200, comment: 'nákup' }];
  assert.deepEqual(S.planCash({ flow, balance: 4082, prevBalance: 2732, reason: '' }), { flow, discrepancy: null });
  assert.throws(
    () => S.planCash({ flow, balance: 4000, prevBalance: 2732, reason: '' }),
    (e) => e.code === 'cash_mismatch' && e.details.expected === 4082 && e.details.prev === 2732 && e.details.flowSum === 1350 && e.details.diff === -82
  );
  const p = S.planCash({ flow, balance: 4000, prevBalance: 2732, reason: 'chybí drobné' });
  assert.deepEqual(p.flow.at(-1), { sum: -82, comment: 'Rozdíl v pokladně: chybí drobné' });
  assert.deepEqual(p.discrepancy, { diff: -82, reason: 'chybí drobné', expected: 4082 });
  // и с ним остаток сходится
  assert.equal(2732 + S.flowTotals(p.flow).total, 4000);
  assert.throws(() => S.normalizeReason('ab'), { code: 'bad_reason' });
  assert.equal(S.normalizeReason(''), '');
});

test('строку-расхождение руками не завести; уже записанную — сохранить можно', () => {
  const line = { sum: -82, comment: 'Rozdíl v pokladně: chybí drobné' };
  assert.throws(() => S.checkReservedLines([{ sum: 100, comment: '' }, line], []), (e) => e.code === 'line_reserved' && e.details.index === 1);
  assert.throws(() => S.checkReservedLines([{ sum: -1, comment: 'rozdíl v pokladně — x' }], []), { code: 'line_reserved' });
  S.checkReservedLines([{ sum: 100, comment: '' }, line], [{ sum: '-82', comment: 'Rozdíl v pokladně: chybí drobné' }]);
  // та же строка дважды при одной записанной — вторая уже руками
  assert.throws(() => S.checkReservedLines([line, line], [line]), { code: 'line_reserved' });
  // поменять сумму записанной строки — тоже нельзя
  assert.throws(() => S.checkReservedLines([{ ...line, sum: -50 }], [line]), { code: 'line_reserved' });
});

test('время: сетка 30 мин 08:00–21:00, часы = конец − начало без перерыва', () => {
  assert.equal(S.hoursBetween('10:30', '19:00'), 8.5);
  assert.equal(S.hoursBetween('10:00', '17:30'), 7.5);
  assert.equal(S.hoursBetween('08:00', '21:00'), 13);
  for (const bad of ['07:30', '21:30', '10:15', '9:00', '10:60', '', null]) assert.throws(() => S.parseSlot(bad, 'startTime'), (e) => e.code === 'bad_time' && e.details.field === 'startTime');
  assert.throws(() => S.hoursBetween('12:00', '12:00'), (e) => e.code === 'end_before_start' && e.details.field === 'endTime');
  assert.throws(() => S.hoursBetween('12:00', '10:00'), { code: 'end_before_start' });
  assert.equal(S.timeSlots().length, 27);
  assert.equal(S.timeSlots()[0], '08:00');
  assert.equal(S.timeSlots().at(-1), '21:00');
});

test('комментарий часов: текст → HTML как у CKEditor и обратно, без &nbsp;', () => {
  const text = 'Úklid, nástroje & <kafe>\nInstagram\n\nDále: "objednávka"';
  const html = S.textToHtml(text);
  assert.equal(html, '<p>Úklid, nástroje &amp; &lt;kafe&gt;<br>Instagram</p><p>Dále: &quot;objednávka&quot;</p>');
  assert.ok(!html.includes('&nbsp;'));
  assert.equal(S.htmlToText(html), text);
  // как пишет панель: &nbsp;, <strong>, пустые абзацы
  assert.equal(S.htmlToText('<p>Приветствие&nbsp;клиентов, кофе/вода</p><p><strong>инст</strong></p><p>&nbsp;</p>'), 'Приветствие клиентов, кофе/вода\n\nинст');
  const w = S.normalizeWorkInput({ startTime: '10:00', endTime: '19:00', comment: '  ok\r\n\r\n\r\n\r\nhotovo  ' });
  assert.deepEqual(w, { startTime: '10:00', endTime: '19:00', hours: 9, comment: 'ok\n\nhotovo' });
  assert.throws(() => S.normalizeWorkInput({ startTime: '10:00', endTime: '19:00', comment: ' a ' }), (e) => e.code === 'comment_required' && e.details.field === 'comment');
});

test('задачи «hotovo» за день — по пражской дате, последняя отметка, фильтр по логину', () => {
  const tasks = [
    { documentId: 't1', title: 'Umýt okna', status: 'done', events: [{ kind: 'created', at: '2026-10-14T08:00:00Z', role: 'owner' }, { kind: 'done', at: '2026-10-14T22:30:00Z', role: 'administrator', by: 'Yuliya' }] },
    { documentId: 't2', title: 'Sklad', status: 'accepted', events: [{ kind: 'done', at: '2026-10-15T09:00:00Z', role: 'administrator', by: 'Viktoriia Tsybuliak' }] },
    { documentId: 't3', title: 'Včera', status: 'done', events: [{ kind: 'done', at: '2026-10-14T21:59:00Z', role: 'administrator', by: 'Yuliya' }] },
    { documentId: 't4', title: 'Průběh', status: 'open', events: [{ kind: 'progress', at: '2026-10-15T09:00:00Z', role: 'administrator', by: 'Yuliya' }] },
    { documentId: 't5', title: 'Od manažerky', status: 'done', events: [{ kind: 'done', at: '2026-10-15T09:00:00Z', role: 'manager', by: 'Mariia' }] },
  ];
  // 22:30 UTC 14.10 = 00:30 15.10 v Praze
  assert.deepEqual(S.doneOnDate(tasks, '2026-10-15').map((t) => t.documentId), ['t1', 't2']);
  assert.deepEqual(S.doneOnDate(tasks, '2026-10-15', 'viktoriia tsybuliak').map((t) => t.documentId), ['t2']);
  assert.deepEqual(S.doneOnDate(tasks, '2026-10-14').map((t) => t.documentId), ['t3']);
});

// ── сервис: касса ────────────────────────────────────────────────────────────

test('касса: администраторка записывает день — lifecycle пропускает и считает profit, журнал без текста', async () => {
  await seedCash('2026-10-14', 2732, [1291], { profit: 1291 });
  const day0 = await svc.day({ session: vika, date: '2026-10-15', now: NOW });
  assert.equal(day0.cash, null);
  assert.equal(day0.prevBalance, 2732);
  assert.equal(day0.prevDate, '2026-10-14');
  assert.equal(day0.check.cashMissing, true);
  assert.equal(day0.editable, true);

  const res = await save(vika, '2026-10-15', { flow: [{ sum: 1550, comment: 'Tržba hotově' }, { sum: -350, comment: 'Nákup kafe' }], balance: 3932, comment: 'ok', expectedUpdatedAt: null });
  assert.equal(res.cash.balance, 3932);
  assert.equal(res.cash.income, 1550);
  assert.equal(res.cash.outflow, -350);
  assert.equal(res.cash.byName, 'Viktoriia Tsybuliak');
  assert.equal(res.cash.lastSavedBy, 'Viktoriia Tsybuliak');
  assert.equal(res.check.cashMissing, false);
  const row = st.rows[CASH].find((r) => r.date === '2026-10-15');
  assert.equal(row.sum, '3932');
  assert.equal(row.personalDocId, VIKA);
  // profit — расчёт lifecycle: приход месяца 1291 + 1550 (расход не уменьшает)
  assert.equal(row.profit, '2841');
  assert.deepEqual(row.flow.map((f) => st.flowRows.get(f.id)), [
    { id: row.flow[0].id, sum: '1550', coment: 'Tržba hotově' },
    { id: row.flow[1].id, sum: '-350', coment: 'Nákup kafe' },
  ]);
  assert.equal(st.logs.length, 1);
  assert.equal(st.logs[0].action, 'smena_cash_create');
  assert.equal(st.logs[0].entityType, 'smena');
  assert.ok(!JSON.stringify(st.logs[0]).includes('Nákup kafe'), 'текст строк в журнал не кладём');

  // без изменений — ни записи, ни журнала
  await save(vika, '2026-10-15', { flow: [{ sum: 1550, comment: 'Tržba hotově' }, { sum: -350, comment: 'Nákup kafe' }], balance: 3932, comment: 'ok' });
  assert.equal(st.logs.length, 1);

  // коллега правит ту же кассу — автор создания остаётся, журнал «upravena»
  const upd = await save(julia, '2026-10-15', { flow: [{ sum: 1550, comment: 'Tržba hotově' }, { sum: -350, comment: 'Nákup kafe' }, { sum: 200, comment: '' }], balance: 4132, expectedUpdatedAt: res.cash.updatedAt });
  assert.equal(upd.cash.byName, 'Viktoriia Tsybuliak');
  assert.equal(upd.cash.lastSavedBy, 'Yuliya');
  assert.equal(st.rows[CASH].find((r) => r.date === '2026-10-15').profit, '3041');
  assert.equal(st.logs.at(-1).action, 'smena_cash_update');
  assert.equal(st.logs.at(-1).details['předtím zůstatek'], 3932);
  assert.equal(st.rows[CASH].filter((r) => r.date === '2026-10-15').length, 1);
});

test('касса: день без наличных — одна строка 0 (как на проде), lifecycle принимает; расхождение заменяет строку 0', async () => {
  await seedCash('2026-10-14', 2732, [1291], { profit: 1291 });
  const r = await save(vika, '2026-10-15', { flow: [], balance: 2732, comment: '' });
  assert.deepEqual(r.cash.flow, [{ sum: 0, comment: '' }]);
  const row = st.rows[CASH].find((x) => x.date === '2026-10-15');
  assert.equal(row.flow.length, 1);
  assert.equal(st.flowRows.get(row.flow[0].id).sum, '0');
  assert.equal(row.profit, '1291', 'приход месяца не меняется');
  // повторное сохранение того же — без записи
  await save(vika, '2026-10-15', { flow: [], balance: 2732, comment: '', expectedUpdatedAt: r.cash.updatedAt });
  assert.equal(st.logs.length, 1);
  // в кассе меньше — «Zapsat rozdíl»: строка 0 уходит, остаётся только расхождение
  const d = await save(vika, '2026-10-15', { flow: [], balance: 2700, discrepancyReason: 'chybí', expectedUpdatedAt: r.cash.updatedAt });
  assert.deepEqual(d.cash.flow, [{ sum: -32, comment: 'Rozdíl v pokladně: chybí' }]);
  // без причины — всё равно cash_mismatch
  await rejects(save(julia, '2026-10-15', { flow: [], balance: 1, expectedUpdatedAt: d.cash.updatedAt }), 'cash_mismatch');
});

test('касса: не сходится — 400 с числами, ничего не записано; ожидаемое НЕ подставляется', async () => {
  await seedCash('2026-10-14', 2732, [1291], { profit: 1291 });
  await rejects(save(vika, '2026-10-15', { flow: [{ sum: 1550 }], balance: 4200 }), 'cash_mismatch', { expected: 4282, diff: -82, field: 'balance' });
  await rejects(save(vika, '2026-10-15', { flow: [{ sum: 1550 }] }), 'bad_balance');
  assert.equal(st.rows[CASH].length, 1);
  assert.equal(st.logs.length, 0);
});

test('касса: «Zapsat rozdíl» — строка от сервера, журнал, push руководству только под env', async () => {
  await seedCash('2026-10-14', 2732, [1291], { profit: 1291 });
  const res = await save(vika, '2026-10-15', { flow: [{ sum: 1550, comment: '' }], balance: 4200, discrepancyReason: 'chybí drobné' });
  assert.deepEqual(res.cash.flow.at(-1), { sum: -82, comment: 'Rozdíl v pokladně: chybí drobné' });
  assert.equal(res.cash.balance, 4200);
  assert.deepEqual(st.logs.map((l) => l.action), ['smena_cash_create', 'smena_cash_discrepancy']);
  assert.equal(st.logs[1].details.rozdíl, -82);
  await tick();
  assert.equal(st.pushes.length, 0, 'без SMENA_PUSH_ENABLED push не идёт');

  // сохранить ещё раз с той же строкой — можно (строку уже записал сервер), без нового расхождения
  process.env.SMENA_PUSH_ENABLED = 'true';
  await save(vika, '2026-10-15', { flow: [...res.cash.flow, { sum: 100, comment: '' }], balance: 4300, expectedUpdatedAt: res.cash.updatedAt });
  assert.deepEqual(st.logs.map((l) => l.action), ['smena_cash_create', 'smena_cash_discrepancy', 'smena_cash_update']);
  assert.equal(st.pushes.length, 0);

  // новое расхождение — push владельцу (рус.) и управляющей (чеш.) со ссылкой на день
  const cur = await svc.day({ session: vika, date: '2026-10-15', now: NOW });
  await save(vika, '2026-10-15', { flow: cur.cash.flow, balance: 4250, discrepancyReason: 'přepočteno', expectedUpdatedAt: cur.cash.updatedAt });
  await tick();
  assert.deepEqual(st.pushes.map((p) => p.to).sort(), ['managers', 'owner']);
  assert.ok(st.pushes.every((p) => p.url === '/smena?date=2026-10-15' && p.kind === 'smena_discrepancy'));
  assert.match(st.pushes.find((p) => p.to === 'owner').title, /Расхождение/);

  // руками строку-расхождение не завести
  const cur2 = await svc.day({ session: vika, date: '2026-10-15', now: NOW });
  await rejects(save(vika, '2026-10-15', { flow: [...cur2.cash.flow, { sum: -50, comment: 'Rozdíl v pokladně: sama' }], balance: 4200, expectedUpdatedAt: cur2.cash.updatedAt }), 'line_reserved');
});

test('касса: есть касса позже по дате — суммы не менять (цепочка остатков), описание — можно', async () => {
  await seedCash('2026-10-13', 1000, [1000]);
  const d14 = await save(vika, '2026-10-14', { flow: [{ sum: 500, comment: '' }], balance: 1500 });
  await save(vika, '2026-10-15', { flow: [{ sum: 100, comment: '' }], balance: 1600 });
  await rejects(save(vika, '2026-10-14', { flow: [{ sum: 600, comment: '' }], balance: 1600, expectedUpdatedAt: d14.cash.updatedAt }), 'later_cash_exists', { field: 'balance' });
  // описание дня и строк — то же Σ, цепочка не рвётся
  const ok = await save(vika, '2026-10-14', { flow: [{ sum: 500, comment: 'Tržba hotově' }], balance: 1500, comment: 'opraveno', expectedUpdatedAt: d14.cash.updatedAt });
  assert.equal(ok.cash.comment, 'opraveno');
  assert.equal(ok.laterCashExists, true);
  // первый день цепочки — тоже
  await rejects(save(vika, '2026-10-13', { flow: [{ sum: 5, comment: '' }], balance: 5 }), 'later_cash_exists');
});

test('касса: опубликована закрытием — 409; чужая правка — stale; две кассы дня — cash_duplicate', async () => {
  await seedCash('2026-10-14', 2732, [1291], { published: true });
  await rejects(save(vika, '2026-10-14', { flow: [{ sum: 1291, comment: '' }], balance: 2732 }), 'shift_closed');
  const d = await svc.day({ session: vika, date: '2026-10-14', now: NOW });
  assert.equal(d.cash.closed, true);

  const first = await save(vika, '2026-10-15', { flow: [{ sum: 100, comment: '' }], balance: 2832, expectedUpdatedAt: null });
  // Юлия открыла форму, пока записи не было, — её «создание» уже устарело
  await rejects(save(julia, '2026-10-15', { flow: [{ sum: 50, comment: '' }], balance: 2782, expectedUpdatedAt: null }), 'stale');
  await rejects(save(julia, '2026-10-15', { flow: [{ sum: 50, comment: '' }], balance: 2782, expectedUpdatedAt: '2026-10-01T00:00:00.000Z' }), 'stale');
  await save(julia, '2026-10-15', { flow: [{ sum: 50, comment: '' }], balance: 2782, expectedUpdatedAt: first.cash.updatedAt });

  await seedCash('2026-10-13', 10, [10]);
  await seedCash('2026-10-13', 10, [10]);
  await rejects(save(vika, '2026-10-13', { flow: [{ sum: 10, comment: '' }], balance: 10 }), 'cash_duplicate');
  assert.equal((await svc.day({ session: vika, date: '2026-10-13', now: NOW })).cashDuplicate, true);
});

test('движок и lifecycle согласны: что пропустил движок, lifecycle принимает; расхождение — lifecycle_rejected', async () => {
  await seedCash('2026-09-30', 900, [900], { profit: 900 });
  await seedCash('2026-10-12', 2000, [400, -100], { profit: 1300 });
  const cases = [
    ['2026-10-13', [{ sum: 1 }], 2001, '1301'],
    ['2026-10-14', [{ sum: 3000 }, { sum: -2500, comment: 'výběr vedení' }], 2501, '4301'],
    ['2026-10-15', [{ sum: -2501, comment: 'výběr' }], 0, '4301'],
  ];
  let prev = 2000;
  for (const [d, flow, balance, profit] of cases) {
    assert.equal(prev + flow.reduce((a, f) => a + f.sum, 0), balance);
    await save(owner, d, { flow, balance });
    // profit считает lifecycle: приход месяца без расходов
    assert.equal(st.rows[CASH].find((r) => r.date === d).profit, profit);
    prev = balance;
  }
  // движок ошибся с предыдущим остатком → lifecycle — вторая линия, ошибка с понятным кодом
  const realPrev = svc._prev;
  svc._prev = async () => ({ prevBalance: 0, prevDate: null });
  try {
    await rejects(save(owner, '2026-10-15', { flow: [{ sum: 10 }], balance: 10 }), 'lifecycle_rejected', { field: 'balance' });
    assert.equal(st.rows[CASH].find((r) => r.date === '2026-10-15').sum, '0', 'отклонённое не записано');
  } finally {
    svc._prev = realPrev;
  }
});

test('роли: без карточки — no_card; владелец пишет кассу (без карточки), часы — только администраторки; мастер — 403', async () => {
  await rejects(svc.day({ session: NOCARD, date: '2026-10-15', now: NOW }), 'no_card');
  await rejects(svc.day({ session: master, date: '2026-10-15', now: NOW }), 'not_allowed');
  const r = await save(owner, '2026-10-15', { flow: [{ sum: 100, comment: '' }], balance: 100 });
  assert.equal(r.cash.byName, '');
  assert.equal(r.canWriteHours, false);
  assert.equal(r.check.workTimeMissing, null);
  const body = { startTime: '10:00', endTime: '19:00', comment: 'úklid' };
  // s266: своих часов у руководства нет — только чьи-то (`personal`)
  await rejects(svc.saveWorkTime({ session: owner, date: '2026-10-15', body, now: NOW }), 'personal_required', { field: 'personal' });
  await rejects(svc.saveWorkTime({ session: manager, date: '2026-10-15', body, now: NOW }), 'personal_required');
  // s266: старый день руководству открыт, но цепочку остатков не порвать (касса 15.10 уже есть)
  await rejects(save(owner, '2026-10-12', { flow: [{ sum: 1 }], balance: 1 }), 'later_cash_exists');
  // прочитать и править старый день руководство может, администраторка — нет
  assert.equal((await svc.day({ session: manager, date: '2026-10-01', now: NOW })).editable, true);
  await rejects(svc.day({ session: vika, date: '2026-10-01', now: NOW }), 'out_of_window');
});

// ── сервис: часы ─────────────────────────────────────────────────────────────

test('часы: своя запись, HTML-комментарий, правка, удаление; чужие видит только руководство', async () => {
  const body = { startTime: '10:30', endTime: '19:00', comment: 'Úklid, nástroje\nInstagram', expectedUpdatedAt: null };
  const r = await svc.saveWorkTime({ session: vika, date: '2026-10-15', body, now: NOW });
  assert.deepEqual({ ...r.workTime, documentId: undefined, updatedAt: undefined }, {
    documentId: undefined,
    closed: false,
    startTime: '10:30',
    endTime: '19:00',
    hours: 8.5,
    comment: 'Úklid, nástroje\nInstagram',
    name: 'Viktoriia Tsybuliak',
    personal: VIKA,
    updatedAt: undefined,
  });
  const row = st.rows[WORK][0];
  assert.equal(row.comment, '<p>Úklid, nástroje<br>Instagram</p>');
  assert.equal(row.sum, 8.5);
  assert.equal(row.personalDocId, VIKA);
  assert.equal(st.logs.at(-1).action, 'smena_worktime_create');
  assert.ok(!JSON.stringify(st.logs.at(-1)).includes('Instagram'));

  await svc.saveWorkTime({ session: julia, date: '2026-10-15', body: { ...body, startTime: '12:00' }, now: NOW });
  const vDay = await svc.day({ session: vika, date: '2026-10-15', now: NOW });
  assert.equal(vDay.workTime.personal, VIKA);
  assert.deepEqual(vDay.others, [], 'администраторке чужие часы не отдаём');
  assert.equal(vDay.check.workTimeMissing, false);
  const mDay = await svc.day({ session: manager, date: '2026-10-15', now: NOW });
  assert.deepEqual(mDay.others.map((w) => [w.name, w.hours]), [['Viktoriia Tsybuliak', 8.5], ['Yuliya Popchanka', 7]]);
  assert.equal(mDay.workTime, null);

  await rejects(svc.saveWorkTime({ session: vika, date: '2026-10-15', body: { ...body, endTime: '19:30', expectedUpdatedAt: null }, now: NOW }), 'stale');
  const u = await svc.saveWorkTime({ session: vika, date: '2026-10-15', body: { ...body, endTime: '19:30', expectedUpdatedAt: r.workTime.updatedAt }, now: NOW });
  assert.equal(u.workTime.hours, 9);
  assert.equal(st.rows[WORK].filter((w) => w.personalDocId === VIKA).length, 1);
  assert.equal(st.logs.at(-1).action, 'smena_worktime_update');
  await rejects(svc.saveWorkTime({ session: vika, date: '2026-10-15', body: { ...body, startTime: '19:00', endTime: '10:00' }, now: NOW }), 'end_before_start');

  const del = await svc.deleteWorkTime({ session: vika, date: '2026-10-15', now: NOW });
  assert.equal(del.workTime, null);
  assert.equal(st.logs.at(-1).action, 'smena_worktime_delete');
  await rejects(svc.deleteWorkTime({ session: vika, date: '2026-10-15', now: NOW }), 'not_found');

  // опубликовано — ни правки, ни удаления
  const jRow = st.rows[WORK].find((w) => w.personalDocId === JULIA);
  st.rows[WORK].push({ ...clone(jRow), id: 500, publishedAt: NOW.toISOString() });
  await rejects(svc.saveWorkTime({ session: julia, date: '2026-10-15', body, now: NOW }), 'shift_closed');
  await rejects(svc.deleteWorkTime({ session: julia, date: '2026-10-15', now: NOW }), 'shift_closed');
  assert.equal((await svc.day({ session: julia, date: '2026-10-15', now: NOW })).workTime.closed, true);
});

// ── статус дня и сводка руководству ─────────────────────────────────────────

test('день: задачи «hotovo» — только её, незакрытые визиты дня; сводка руководству по людям', async () => {
  st.rows[TASK].push(
    { documentId: 'task1', assignee: 'administrator', title: 'Umýt okna', status: 'done', updatedAt: '2026-10-15T09:00:00.000Z', events: [{ kind: 'done', at: '2026-10-15T09:00:00Z', role: 'administrator', by: 'Viktoriia Tsybuliak' }] },
    { documentId: 'task2', assignee: 'administrator', title: 'Sklad', status: 'accepted', updatedAt: '2026-10-15T11:00:00.000Z', events: [{ kind: 'done', at: '2026-10-15T10:00:00Z', role: 'administrator', by: 'Yuliya' }] },
    { documentId: 'task3', assignee: 'administrator', title: 'Staré', status: 'accepted', updatedAt: '2026-10-10T11:00:00.000Z', events: [{ kind: 'done', at: '2026-10-10T10:00:00Z', role: 'administrator', by: 'Yuliya' }] }
  );
  st.visitsOpen = [{ date: '2026-10-15' }, { date: '2026-10-15' }, { date: '2026-10-14' }];
  const v = await svc.day({ session: vika, date: '2026-10-15', now: NOW });
  assert.deepEqual(v.tasksDone.map((t) => t.title), ['Umýt okna']);
  assert.equal(v.check.visitsOpen, 2);
  assert.deepEqual((await svc.day({ session: manager, date: '2026-10-15', now: NOW })).tasksDone, []);

  await svc.saveWorkTime({ session: julia, date: '2026-10-15', body: { startTime: '10:00', endTime: '18:00', comment: 'recepce' }, now: NOW });
  await save(julia, '2026-10-15', { flow: [{ sum: 300, comment: '' }], balance: 300 });
  const s = await svc.summary({ date: '2026-10-15', now: NOW });
  assert.equal(s.cash.balance, 300);
  assert.deepEqual(
    s.people.map((p) => [p.documentId, p.name, p.workTime?.hours ?? null, p.tasksDone.map((t) => t.title)]),
    [
      [VIKA, 'Viktoriia Tsybuliak', null, ['Umýt okna']],
      [JULIA, 'Yuliya Popchanka', 8, ['Sklad']],
    ]
  );
  await rejects(svc.summary({ date: '2026-10-16', now: NOW }), 'out_of_window');
});

// ── s265: передача смены ──────────────────────────────────────────────────────
test('s265 передача: тело, слияние задач, сводка push, входящие, кто следующий по графику', () => {
  assert.throws(() => S.normalizeHandoverInput({ to: JULIA }), (e) => e.code === 'handover_empty')
  assert.throws(() => S.normalizeHandoverInput({ to: 'x', text: 'a' }), (e) => e.code === 'bad_recipient' && e.details.field === 'to')
  assert.throws(() => S.normalizeHandoverInput({ to: JULIA, tasks: [{ title: 'A' }, { title: '  ' }] }), (e) => e.code === 'task_title_required' && e.details.index === 1)
  assert.throws(() => S.normalizeHandoverInput({ to: JULIA, handover: ['bad id'] }), (e) => e.code === 'bad_tasks')
  assert.deepEqual(S.normalizeHandoverInput({ to: JULIA, text: ' Ahoj \r\n', tasks: [{ title: ' Káva   a mléko ' }], handover: ['task0000000001', 'task0000000001'], note: '' }), {
    to: JULIA,
    text: 'Ahoj',
    note: '',
    tasks: [{ title: 'Káva a mléko', description: '' }],
    handover: ['task0000000001'],
  })
  assert.deepEqual(S.mergeHandoverTasks([{ id: 'task0000000001', kind: 'new' }], [{ id: 'task0000000002', kind: 'handover' }, { id: 'task0000000001', kind: 'new' }]), [
    { id: 'task0000000001', kind: 'new' },
    { id: 'task0000000002', kind: 'handover' },
  ])
  assert.equal(S.handoverParts({ text: 'x', created: 2, handed: 1 }), 'Vzkaz · 2 nové úkoly · 1 předaný úkol')
  assert.equal(S.handoverParts({ text: '', created: 5, handed: 0 }), '5 nových úkolů')
  const p = S.handoverPayload({ id: 'h1', from: 'Viktoriia Tsybuliak', text: 'Zítra přijde dodávka\nv 10:00', created: 0, handed: 1 })
  assert.deepEqual(p, { title: '📨 Předání směny od Viktoriia Tsybuliak', body: 'Vzkaz · 1 předaný úkol\nZítra přijde dodávka v 10:00', url: '/smena', tag: 'handover-h1' })
  // входящие: непрочитанное (не старше 14 дней) и прочитанное сегодня
  const today = '2026-10-15'
  const rows = [
    { documentId: 'a', date: '2026-10-14', readAt: null, createdAt: '2026-10-14T18:00:00Z' },
    { documentId: 'b', date: '2026-10-13', readAt: '2026-10-15T07:00:00Z', createdAt: '2026-10-13T18:00:00Z' },
    { documentId: 'c', date: '2026-10-12', readAt: '2026-10-14T07:00:00Z', createdAt: '2026-10-12T18:00:00Z' },
    { documentId: 'd', date: '2026-09-20', readAt: null, createdAt: '2026-09-20T18:00:00Z' },
  ]
  assert.deepEqual(S.inboxOf(rows, today).map((r) => r.documentId), ['a', 'b'])
  // график: 15.10 — четверг; пятница пустая, суббота «Оля»
  const weeks = new Map([['2026-10-12', { thursday: 'Вика', friday: ' ', saturday: 'Оля' }]])
  assert.deepEqual(S.nextDutyOf(weeks, today), { date: '2026-10-17', name: 'Оля' })
  assert.equal(S.nextDutyOf(new Map(), today), null)
  assert.equal(S.mondayOf('2026-10-18'), '2026-10-12')
})

test('s265 «Předat směnu»: задачи коллеге и передача своих без их push, одна сводка; частичный сбой — списком', async () => {
  st.rows[TASK].push({ documentId: 'mine000000000001', title: 'Vitrína', status: 'open', assignee: 'administrator', personalDocId: VIKA, events: [] })
  process.env.SMENA_PUSH_ENABLED = 'false' // сводке передачи гейт не нужен
  const res = await svc.handover({
    session: vika,
    date: '2026-10-15',
    body: { to: JULIA, text: 'Zítra dodávka barev, TAJNÉ heslo', tasks: [{ title: 'Uklidit sklad' }, { title: 'FAIL' }], handover: ['mine000000000001', 'nikde0000000001'], note: 'Chybí sklo' },
    now: NOW,
  })
  assert.deepEqual([res.created, res.handedOver, res.errors.map((e) => [e.kind, e.code, e.index ?? e.id])], [1, 1, [['new', 'bad_personal', 1], ['handover', 'task_not_found', 'nikde0000000001']]])
  assert.deepEqual(
    st.taskCalls.map((c) => [c.op, c.quiet ?? null, c.personal || c.to, c.action || c.title, c.text ?? null]),
    [
      ['create', true, JULIA, 'Uklidit sklad', null],
      ['create', true, JULIA, 'FAIL', null],
      ['act', 'assignee', JULIA, 'handover', 'Chybí sklo'],
      ['act', 'assignee', JULIA, 'handover', 'Chybí sklo'],
    ]
  )
  const h = res.handover
  assert.deepEqual([h.fromName, h.toName, h.toPersonal, h.text, h.readAt], ['Viktoriia Tsybuliak', 'Yuliya Popchanka', JULIA, 'Zítra dodávka barev, TAJNÉ heslo', null])
  assert.deepEqual(h.tasks.map((t) => [t.kind, t.title]), [['new', 'Uklidit sklad'], ['handover', 'Vitrína']])
  assert.deepEqual(st.pushes.map((p) => [p.to, p.kind, p.title, p.body]), [[`admin:${JULIA}`, 'smena_handover', '📨 Předání směny od Viktoriia Tsybuliak', 'Vzkaz · 1 nový úkol · 1 předaný úkol\nZítra dodávka barev, TAJNÉ heslo']])
  assert.deepEqual(st.logs.map((l) => [l.action, l.entityType, l.summary]), [['smena_handover', 'smena', 'Předání směny 15.10.2026 → Yuliya Popchanka: vzkaz · 1 nový úkol · 1 předaný úkol']])
  assert.doesNotMatch(JSON.stringify(st.logs), /TAJNÉ/, 'текст в журнал не кладём')
  // у отправителя — исходящее за день; у получательницы — входящее
  assert.deepEqual(res.day.handoverOut.map((x) => x.toName), ['Yuliya Popchanka'])
  assert.deepEqual(res.day.colleagues, [{ documentId: JULIA, name: 'Yuliya Popchanka' }], 'себя в списке нет, учётка без карты — тоже')
  const jd = await svc.day({ session: julia, date: '2026-10-15', now: NOW })
  assert.deepEqual([jd.handoverIn.length, jd.handoverIn[0].fromName, jd.handoverOut.length], [1, 'Viktoriia Tsybuliak', 0])

  // повтор до прочтения — то же сообщение: новый текст, задачи дописываются
  st.taskCalls.length = 0
  const again = await svc.handover({ session: vika, date: '2026-10-15', body: { to: JULIA, tasks: [{ title: 'Káva' }] }, now: NOW })
  assert.equal(again.handover.documentId, h.documentId)
  assert.equal(again.handover.text, 'Zítra dodávka barev, TAJNÉ heslo', 'без нового текста — прежний')
  assert.deepEqual(again.handover.tasks.map((t) => t.title), ['Uklidit sklad', 'Vitrína', 'Káva'])
  assert.equal(st.rows[HANDOVER].length, 1)
  assert.equal(st.logs.at(-1).action, 'smena_handover_update')

  // прочитать — только получательница; повтор ничего не меняет
  await rejects(svc.readHandover({ session: vika, id: h.documentId, now: NOW }), 'handover_not_found')
  await rejects(svc.readHandover({ session: manager, id: h.documentId, now: NOW }), 'handover_not_found')
  const r1 = (await svc.readHandover({ session: julia, id: h.documentId, now: NOW })).handover
  assert.deepEqual([r1.readAt, r1.readBy], [NOW.toISOString(), 'Yuliya'])
  const r2 = (await svc.readHandover({ session: julia, id: h.documentId, now: new Date('2026-10-15T15:00:00Z') })).handover
  assert.equal(r2.readAt, NOW.toISOString())
  assert.equal(st.logs.filter((l) => l.action === 'smena_handover_read').length, 1)
  // прочитанное — сегодня ещё видно; завтра — нет
  assert.equal((await svc.day({ session: julia, date: '2026-10-15', now: NOW })).handoverIn[0].readAt, NOW.toISOString())
  const tomorrow = new Date('2026-10-16T08:00:00Z')
  assert.equal((await svc.day({ session: julia, date: '2026-10-16', now: tomorrow })).handoverIn.length, 0)
  // после прочтения — новое сообщение, не правка
  st.clock = '2026-10-15T15:30:00.000Z'
  const third = await svc.handover({ session: vika, date: '2026-10-15', body: { to: JULIA, text: 'Ještě jedna věc' }, now: NOW })
  assert.notEqual(third.handover.documentId, h.documentId)
  assert.equal(st.rows[HANDOVER].length, 2)

  // руководству — в сводке дня
  const sum = await svc.summary({ date: '2026-10-15', now: NOW })
  assert.deepEqual(sum.handovers.map((x) => [x.fromName, x.toName, !!x.readAt]), [['Viktoriia Tsybuliak', 'Yuliya Popchanka', true], ['Viktoriia Tsybuliak', 'Yuliya Popchanka', false]])
})

test('s265 «Předat směnu»: кому — только работающая администраторка не я; всё упало без текста — 409; окно дат', async () => {
  await rejects(svc.handover({ session: vika, date: '2026-10-15', body: { to: VIKA, text: 'x' }, now: NOW }), 'bad_recipient')
  await rejects(svc.handover({ session: vika, date: '2026-10-15', body: { to: MARIIA, text: 'x' }, now: NOW }), 'bad_recipient')
  await rejects(svc.handover({ session: vika, date: '2026-10-11', body: { to: JULIA, text: 'x' }, now: NOW }), 'out_of_window')
  await rejects(svc.handover({ session: NOCARD, date: '2026-10-15', body: { to: JULIA, text: 'x' }, now: NOW }), 'no_card')
  await rejects(svc.handover({ session: master, date: '2026-10-15', body: { to: JULIA, text: 'x' }, now: NOW }), 'not_allowed')
  await assert.rejects(svc.handover({ session: vika, date: '2026-10-15', body: { to: JULIA, tasks: [{ title: 'FAIL' }] }, now: NOW }), (e) => e.code === 'handover_failed' && e.details.errors.length === 1)
  assert.equal(st.rows[HANDOVER].length, 0)
  assert.equal(st.pushes.length, 0)
  // руководство тоже может оставить сообщение (владелец без карточки — по логину)
  const o = await svc.handover({ session: owner, date: '2026-10-15', body: { to: JULIA, text: 'Zítra přijdu v 11' }, now: NOW })
  assert.deepEqual([o.handover.fromName, o.handover.fromPersonal, o.day.handoverOut.length], ['Dima', null, 1])
  // подсказка из графика
  st.rows[SHIFT].push({ id: 1, documentId: 'shift1', from: '2026-10-12', days: { friday: 'Юля' } })
  assert.deepEqual((await svc.day({ session: vika, date: '2026-10-15', now: NOW })).nextDuty, { date: '2026-10-16', name: 'Юля' })
})

test('s265 ручки передачи: requireAdmin, сервис сам проверяет роль; коллекция без REST', () => {
  const routes = read('src/api/booking-engine/routes/booking-engine.ts')
  const ctrl = read('src/api/booking-engine/controllers/booking-engine.ts')
  for (const [handler, method, p] of [
    ['adminSmenaHandover', 'PUT', '/engine/admin/smena/:date/handover'],
    ['adminSmenaHandoverRead', 'POST', '/engine/admin/smena/handover/:id/read'],
  ]) {
    assert.ok(routes.includes(`admin('${method}', '${p}', 'booking-engine.${handler}')`), handler)
    const body = ctrl.split(`async ${handler}(ctx) {`)[1]?.split('\n  },')[0] || ''
    assert.ok(body.includes('const session = requireAdmin(ctx);'), handler)
  }
  assert.equal(fs.existsSync(path.join(root, 'src/api/shift-handover/routes')), false)
  assert.equal(fs.existsSync(path.join(root, 'src/api/shift-handover/controllers')), false)
  const sch = JSON.parse(read('src/api/shift-handover/content-types/shift-handover/schema.json'))
  assert.equal(sch.options.draftAndPublish, false)
  assert.match(read('types/generated/contentTypes.d.ts'), /'api::shift-handover\.shift-handover': ApiShiftHandoverShiftHandover;/)
})

// ── s266: Фаза 3 ──────────────────────────────────────────────────────────────

test('s266 чистые: «не заполнено» §5.3, причина расхождения, расхождения незакрытых, старые передачи, тексты push', () => {
  const dates = ['2026-10-12', '2026-10-13', '2026-10-14'];
  const m = S.missingDays(dates, {
    visits: new Map([['2026-10-12', 5], ['2026-10-14', 3]]),
    duty: new Map([['2026-10-13', 'Вика'], ['2026-10-14', '']]),
    cashDates: new Set(['2026-10-12', '2026-10-14']),
    workDates: new Set(['2026-10-12']),
  });
  // 12.10 — всё есть; 13.10 — броней нет, но дежурный → касса и часы; 14.10 — нет часов
  assert.deepEqual(m, [
    { date: '2026-10-13', cash: true, workTime: true, visits: 0, duty: 'Вика' },
    { date: '2026-10-14', cash: false, workTime: true, visits: 3, duty: '' },
  ]);
  // выходной салона (ни броней, ни дежурного) — не «не заполнено»
  assert.deepEqual(S.missingDays(['2026-10-11'], { visits: new Map(), duty: new Map(), cashDates: new Set(), workDates: new Set() }), []);

  assert.equal(S.reasonOf('Rozdíl v pokladně: chybí drobné'), 'chybí drobné');
  assert.equal(S.reasonOf('rozdíl v pokladně :  x '), 'x');
  const cashes = [
    { documentId: 'c1', date: '2026-10-14', flow: [{ sum: '100', coment: 'Tržba' }, { sum: '-82', coment: 'Rozdíl v pokladně: chybí' }], personal: { name: 'Yuliya Popchanka' } },
    { documentId: 'c2', date: '2026-10-13', flow: [{ sum: '50', coment: 'Rozdíl v pokladně: navíc' }] },
    { documentId: 'c3', date: '2026-10-12', flow: [{ sum: '-10', coment: 'Rozdíl v pokladně: zavřeno' }] },
  ];
  assert.deepEqual(S.discrepanciesOf(cashes, new Set(['c3']), new Map([['c2', 'Viktoriia Tsybuliak']])), [
    { date: '2026-10-13', cashDocId: 'c2', diff: 50, reason: 'navíc', by: 'Viktoriia Tsybuliak' },
    { date: '2026-10-14', cashDocId: 'c1', diff: -82, reason: 'chybí', by: 'Yuliya Popchanka' },
  ]);

  const h = (date, readAt = null) => ({ documentId: `h${date}`, date, fromName: 'Vika', toName: 'Julia', readAt });
  assert.deepEqual(
    S.staleHandoversOf([h('2026-10-12'), h('2026-10-13'), h('2026-10-10', '2026-10-11T08:00:00Z'), h('2026-10-01')], '2026-10-15').map((x) => [x.date, x.days]),
    [['2026-10-01', 14], ['2026-10-12', 3]]
  );

  assert.equal(S.missingText({ cash: true, workTime: true }), 'pokladna a hodiny');
  assert.equal(S.missingText({ cash: false, workTime: true }, 'ru'), 'часы');
  const ev = S.reminderPayloads('evening', { date: '2026-10-15', cash: true, workTime: false });
  assert.equal(ev.admin.url, '/smena');
  assert.match(ev.admin.body, /Chybí pokladna/);
  const mo = S.reminderPayloads('morning', { date: '2026-10-14', cash: true, workTime: true });
  assert.equal(mo.admin.url, '/smena?date=2026-10-14');
  assert.equal(mo.owner.body, 'Нет: касса и часы.');
  assert.equal(mo.manager.tag, 'smena-missing-2026-10-14');
});

test('s266 «Úkoly splněné dnes»: текст её записей этого дня (hotovo/průběh/komentář), чужие и вчерашние — нет', () => {
  const task = {
    documentId: 't1',
    title: 'Okna',
    status: 'done',
    events: [
      { kind: 'progress', at: '2026-10-14T20:00:00Z', role: 'administrator', by: 'Vika', text: 'včera' },
      { kind: 'progress', at: '2026-10-15T08:00:00Z', role: 'administrator', by: 'Vika', text: 'půlka hotová' },
      { kind: 'comment', at: '2026-10-15T09:00:00Z', role: 'owner', by: 'Dima', text: 'díky' },
      { kind: 'comment', at: '2026-10-15T09:30:00Z', role: 'administrator', by: 'Vika', text: '  ' },
      { kind: 'done', at: '2026-10-15T10:00:00Z', role: 'administrator', by: 'vika', text: 'Umyto, foto v příloze' },
    ],
  };
  const [row] = S.doneOnDate([task], '2026-10-15');
  assert.deepEqual(row.notes.map((n) => [n.kind, n.text]), [['progress', 'půlka hotová'], ['done', 'Umyto, foto v příloze']]);
  assert.equal(S.fileOut({ documentId: 'f1', fileName: '', storedName: 'secret.jpg', mime: 'image/jpeg', size: '12' }).fileName, 'soubor');
  assert.equal('storedName' in S.fileOut({ documentId: 'f1', storedName: 'x' }), false);
});

test('s266 руководство: часы любой администраторки (`personal`), журнал на неё; администраторке `personal` не помогает', async () => {
  const body = { startTime: '10:00', endTime: '18:00', comment: 'recepce', personal: JULIA, expectedUpdatedAt: null };
  // старый день — руководству можно
  const r = await svc.saveWorkTime({ session: manager, date: '2026-10-05', body, now: NOW });
  assert.equal(r.editable, true);
  assert.equal(r.canEditTeamHours, true);
  assert.deepEqual(r.others.map((w) => [w.personal, w.hours]), [[JULIA, 8]]);
  assert.equal(st.rows[WORK][0].personalDocId, JULIA);
  const log = st.logs.at(-1);
  assert.equal(log.action, 'smena_worktime_create');
  assert.equal(log.employeeName, 'Yuliya Popchanka');
  assert.equal(log.actorName, 'Mariia Medvedeva');
  assert.equal(log.details.zapsalo, 'vedení');
  assert.match(log.summary, /— Yuliya Popchanka$/);

  const u = await svc.saveWorkTime({ session: owner, date: '2026-10-05', body: { ...body, endTime: '19:00', expectedUpdatedAt: r.others[0].updatedAt }, now: NOW });
  assert.equal(u.others[0].hours, 9);
  assert.equal(st.rows[WORK].length, 1);

  await rejects(svc.saveWorkTime({ session: owner, date: '2026-10-05', body: { ...body, personal: MARIIA }, now: NOW }), 'bad_personal', { field: 'personal' });
  await rejects(svc.saveWorkTime({ session: owner, date: '2026-10-05', body: { ...body, personal: 'x' }, now: NOW }), 'personal_required');
  // ушедшая администраторка с записью в этот день — поправить можно (карточка из записи)
  st.rows[PERSONAL].push({ documentId: 'olga00000000000000000004', name: 'Olga Eremina', isActive: false });
  st.rows[WORK].push({ id: 700, documentId: 'oldwork000000000000001x', date: '2026-10-05', startTime: '10:00', endTime: '15:00', sum: 5, comment: '<p>x</p>', personalDocId: 'olga00000000000000000004', publishedAt: null, updatedAt: '2026-10-05T10:00:00.000Z' });
  const o = await svc.saveWorkTime({ session: owner, date: '2026-10-05', body: { ...body, personal: 'olga00000000000000000004', expectedUpdatedAt: '2026-10-05T10:00:00.000Z' }, now: NOW });
  assert.equal(o.others.find((w) => w.personal === 'olga00000000000000000004').hours, 8);

  // удаление руководством — `personal` из адреса
  const d = await svc.deleteWorkTime({ session: manager, date: '2026-10-05', personal: JULIA, now: NOW });
  assert.equal(d.others.some((w) => w.personal === JULIA), false);
  assert.equal(st.logs.at(-1).employeeName, 'Yuliya Popchanka');
  await rejects(svc.deleteWorkTime({ session: manager, date: '2026-10-05', now: NOW }), 'personal_required');

  // администраторка с чужим `personal` пишет СВОИ часы; старый день ей закрыт
  const v = await svc.saveWorkTime({ session: vika, date: '2026-10-15', body: { ...body, personal: JULIA }, now: NOW });
  assert.equal(v.workTime.personal, VIKA);
  assert.equal(v.canEditTeamHours, false);
  await rejects(svc.saveWorkTime({ session: vika, date: '2026-10-05', body, now: NOW }), 'out_of_window');
});

test('s266 «Kontrola směny»: тот же runSelfCheck, окно администраторки, руководство — любой день', async () => {
  assert.deepEqual(await svc.check({ session: vika, date: '2026-10-15', now: NOW }), { date: '2026-10-15', ok: true, problemCount: 0 });
  await rejects(svc.check({ session: vika, date: '2026-10-01', now: NOW }), 'out_of_window');
  await rejects(svc.check({ session: NOCARD, date: '2026-10-15', now: NOW }), 'no_card');
  await rejects(svc.check({ session: owner, date: '2026-10-16', now: NOW }), 'out_of_window');
  await svc.check({ session: owner, date: '2026-09-01', now: NOW });
  assert.deepEqual(st.selfChecks, ['2026-10-15', '2026-09-01']);
});

test('s266 «Сегодня»: незаполненные смены за неделю, расхождения незакрытых касс, передачи ≥ 3 дней', async () => {
  // брони: 13.10 и 14.10; 12.10 — только дежурная; 11.10 — выходной
  st.bookings = [
    { date: '2026-10-13', status: 'checkedOut' },
    { date: '2026-10-14', status: 'active' },
    { date: '2026-10-14', status: 'cancelled' },
    { date: '2026-10-11', status: 'cancelled' },
    { date: '2026-10-15', status: 'active' },
  ];
  st.rows[SHIFT].push({ id: 1, documentId: 'shift0000000000000000001', from: '2026-10-12', days: { monday: 'Вика', tuesday: 'Юля' }, publishedAt: null });
  await seedCash('2026-10-13', 1000, [1000]);
  await svc.saveWorkTime({ session: manager, date: '2026-10-13', body: { startTime: '10:00', endTime: '18:00', comment: 'recepce', personal: JULIA }, now: NOW });
  // 14.10 — касса с расхождением (через движок: журнал знает, кто), смена не закрыта
  await save(julia, '2026-10-14', { flow: [{ sum: 500, comment: '' }], balance: 1450, discrepancyReason: 'chybí' });
  // закрытое расхождение — не показываем
  const closed = await seedCash('2026-10-09', 900, [-100]);
  st.flowRows.get(closed.flow[0].id).coment = 'Rozdíl v pokladně: staré';
  st.rows[CASH].push({ ...clone(closed), id: 990, publishedAt: NOW.toISOString() });
  st.rows[HANDOVER].push(
    { id: 1, documentId: 'hand0000000000000000001x', date: '2026-10-11', fromName: 'Viktoriia Tsybuliak', toName: 'Yuliya Popchanka', readAt: null },
    { id: 2, documentId: 'hand0000000000000000002x', date: '2026-10-13', fromName: 'Viktoriia Tsybuliak', toName: 'Yuliya Popchanka', readAt: null },
    { id: 3, documentId: 'hand0000000000000000003x', date: '2026-10-10', fromName: 'Yuliya Popchanka', toName: 'Viktoriia Tsybuliak', readAt: '2026-10-11T08:00:00Z' }
  );
  const a = await svc.attention({ now: NOW });
  assert.equal(a.today, '2026-10-15');
  assert.deepEqual(a.missing.map((x) => [x.date, x.cash, x.workTime]), [
    ['2026-10-12', true, true],
    ['2026-10-14', false, true],
  ]);
  assert.deepEqual(a.discrepancies.map((x) => [x.date, x.diff, x.reason, x.by]), [['2026-10-14', -50, 'chybí', 'Yuliya']]);
  assert.deepEqual(a.handoversUnread.map((x) => [x.date, x.days]), [['2026-10-11', 4]]);

  // сбой одного источника — остальные на месте
  const real = st.documents;
  st.documents = (uid) => (uid === HANDOVER ? { findMany: async () => Promise.reject(new Error('db down')) } : real(uid));
  const b = await svc.attention({ now: NOW });
  assert.equal(b.handoversUnread, null);
  assert.equal(b.missing.length, 2);

  // дайджест: вчера (14.10) нет часов
  st.documents = real;
  assert.deepEqual(await svc.missingOn({ date: '2026-10-14' }), { date: '2026-10-14', cash: false, workTime: true, visits: 1, duty: '' });
  assert.equal(await svc.missingOn({ date: '2026-10-13' }), null);
});

test('s266 напоминания: только под env; кто записал часы — ей, иначе всем; утром — и руководству', async () => {
  st.bookings = [{ date: '2026-10-15', status: 'active' }, { date: '2026-10-14', status: 'checkedOut' }];
  assert.deepEqual(await svc.remind({ kind: 'evening', now: new Date('2026-10-15T18:30:00Z') }), { skipped: 'disabled' });
  process.env.SMENA_PUSH_ENABLED = 'true';

  // вечер 15.10: никто часов не писал — всем администраторкам
  const e = await svc.remind({ kind: 'evening', now: new Date('2026-10-15T18:30:00Z') });
  assert.equal(e.date, '2026-10-15');
  assert.equal(e.admins, 'all');
  assert.deepEqual(st.pushes.map((p) => [p.to, p.kind, p.url]), [['admins', 'smena_reminder_evening', '/smena']]);

  // часы записала Юлия — касса ещё нет → только ей
  st.pushes.length = 0;
  await svc.saveWorkTime({ session: julia, date: '2026-10-15', body: { startTime: '10:00', endTime: '19:00', comment: 'recepce' }, now: NOW });
  await svc.remind({ kind: 'evening', now: new Date('2026-10-15T18:30:00Z') });
  assert.deepEqual(st.pushes.map((p) => p.to), [`admin:${JULIA}`]);
  assert.match(st.pushes[0].body, /Chybí pokladna\b/);

  // всё заполнено — молчим
  st.pushes.length = 0;
  await save(julia, '2026-10-15', { flow: [{ sum: 10, comment: '' }], balance: 10 });
  assert.deepEqual(await svc.remind({ kind: 'evening', now: new Date('2026-10-15T18:30:00Z') }), { date: '2026-10-15', due: false });
  assert.equal(st.pushes.length, 0);

  // утро 16.10 за 15.10 — заполнено; утро 15.10 за 14.10 — не заполнено: администраторкам, управляющей, владельцу
  assert.equal((await svc.remind({ kind: 'morning', now: new Date('2026-10-16T07:30:00Z') })).due, false);
  const m = await svc.remind({ kind: 'morning', now: new Date('2026-10-15T07:30:00Z') });
  assert.equal(m.date, '2026-10-14');
  assert.deepEqual(st.pushes.map((p) => p.to), ['admins', 'managers', 'owner']);
  assert.ok(st.pushes.every((p) => p.url === '/smena?date=2026-10-14'));
  assert.match(st.pushes[2].title, /Смена 14\.10/);
});

test('s266 сводка «Uzavření směny»: у задачи — текст её записей дня и вложения', async () => {
  st.rows[TASK].push({
    documentId: 'task1',
    assignee: 'administrator',
    title: 'Umýt okna',
    status: 'done',
    updatedAt: '2026-10-15T09:00:00.000Z',
    events: [{ kind: 'done', at: '2026-10-15T09:00:00Z', role: 'administrator', by: 'Viktoriia Tsybuliak', text: 'Hotovo, foto' }],
  });
  st.taskFiles.set('task1', [{ documentId: 'file1', fileName: 'okna.jpg', storedName: 'abc.jpg', mime: 'image/jpeg', size: 1200, createdAt: '2026-10-15T09:01:00Z' }]);
  const s = await svc.summary({ date: '2026-10-15', now: NOW });
  const [t] = s.people[0].tasksDone;
  assert.deepEqual(t.notes.map((n) => n.text), ['Hotovo, foto']);
  assert.deepEqual(t.files, [{ documentId: 'file1', fileName: 'okna.jpg', mime: 'image/jpeg', size: 1200, createdAt: '2026-10-15T09:01:00Z' }]);
});

test('s266 ручки: attention — руководству и раньше `/:date`, check — requireAdmin; кроны под env', () => {
  const routes = read('src/api/booking-engine/routes/booking-engine.ts');
  const iAtt = routes.indexOf("'/engine/admin/smena/attention'");
  assert.ok(iAtt > 0 && iAtt < routes.indexOf("'/engine/admin/smena/:date'"));
  assert.ok(routes.includes("admin('GET', '/engine/admin/smena/:date/check', 'booking-engine.adminSmenaCheck')"));
  const ctrl = read('src/api/booking-engine/controllers/booking-engine.ts');
  assert.match(ctrl, /async adminSmenaAttention\(ctx\) \{\s*const session = requireManagement\(ctx\);/);
  assert.match(ctrl, /async adminSmenaCheck\(ctx\) \{\s*const session = requireAdmin\(ctx\);/);
  assert.match(ctrl, /deleteWorkTime\(\{ session, date: ctx\.params\.date, personal: ctx\.query\?\.personal \}\)/);
  const cron = read('config/cron-tasks.ts');
  for (const [name, rule] of [['smenaReminderEvening', '30 20 * * *'], ['smenaReminderMorning', '30 9 * * *']]) {
    const block = cron.slice(cron.indexOf(`${name}:`), cron.indexOf('tz:', cron.indexOf(`${name}:`)));
    assert.ok(block.includes("process.env.SMENA_PUSH_ENABLED !== 'true'"), name);
    assert.ok(block.includes(`rule: '${rule}'`), name);
  }
});
