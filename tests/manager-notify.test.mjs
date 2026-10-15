// Push управляющей и владельцу (services/manager-notify.ts + push-notify.ts, s247 — §5 плана
// MANAGER_UX_NEXT_SESSION_PROMPT.md):
//   - кому и что по событию поручения: новое от владельца → управляющей; задача владельцу → владельцу;
//     «вернуть» владельцем → управляющей; «hotovo» её поручения → владельцу; «hotovo» владельца по её
//     задаче → ей; задача себе, комментарии, undone, ход работы — без push;
//   - тексты: обрезка названия, срок, «urgentní»/«срочно», чешский управляющей и русский владельцу;
//   - výkaz: владельцу при подаче (+ «Нужно ваше решение»), напоминания 21:00/09:00 с нужными ссылками;
//   - блоки ke schválení: серия = одна строка, моложе 6 ч и с действующей отметкой не берутся,
//     новое предложение графика на ту же дату снимает отметку; сводка 10:00 — от 24 ч без отметок;
//   - крон «> 6 ч» ставит отметки (блоки — pendingPushAt, график — requestPushes без прошедших дат),
//     второй прогон молчит; без VAPID — ничего не отправляет и не отмечает;
//   - push-notify: без VAPID — skipped; владельцу — подписки по логину БЕЗ карточки.
// Запуск: cd strapi && node --test tests/manager-notify.test.mjs

import { test } from 'node:test';
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
const link = (file, pairs) => {
  let js = toJs(file);
  for (const [from, to] of pairs) {
    assert.ok(js.includes(from), `импорт ${from} не найден в ${file}`);
    js = js.split(from).join(to);
  }
  return js;
};

const slotsUrl = dataUrl(toJs('src/api/booking-engine/services/slots-core.ts'));
const N = await import(dataUrl(link('src/api/booking-engine/services/manager-notify.ts', [["from './slots-core'", `from '${slotsUrl}'`]])));
// web-push — заглушка: отправленное копится в globalThis.__sent, статус ошибки — globalThis.__failStatus
const webpushStub = dataUrl(`export default {
  setVapidDetails() {},
  async sendNotification(sub, body) {
    const st = globalThis.__failStatus?.[sub.endpoint];
    if (st) { const e = new Error('fail'); e.statusCode = st; throw e; }
    globalThis.__sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
  },
};`);
const P = await import(
  dataUrl(
    link('src/api/booking-engine/services/push-notify.ts', [
      ["from 'web-push'", `from '${webpushStub}'`],
      ["from './slots-core'", `from '${slotsUrl}'`],
    ])
  )
);

const MARIIA = 'mariia000000000000000001';
const OLD = 'oldmgr000000000000000003';
const KARINA = 'karina000000000000000002';
const tick = () => new Promise((r) => setImmediate(r));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── чистые функции ───────────────────────────────────────────────────────────

const task = (over = {}) => ({ documentId: 'task00000000000000000001', title: 'Objednat barvy', dueDate: '2026-10-09', priority: 'normal', personal: { documentId: MARIIA, name: 'Mariia Medvedeva' }, ...over });

test('поручения: кому и что; без push — себе, комментарии, undone, ход работы', () => {
  const legacy = task(); // старая строка без сторон = поручение владельца управляющей
  const c = N.taskPushFor(legacy, { kind: 'created', role: 'owner' });
  assert.deepEqual(c, {
    to: 'manager',
    kind: 'task_created',
    payload: { title: '📋 Nový úkol od majitele', body: 'Objednat barvy · do 09.10.', url: '/vykaz?task=task00000000000000000001', tag: 'task-task00000000000000000001' },
  });
  assert.equal(N.taskPushFor({ ...legacy, priority: 'urgent', dueDate: null }, { kind: 'created', role: 'owner' }).payload.body, 'Objednat barvy · urgentní');
  const forOwner = task({ assignee: 'owner', createdByRole: 'manager', priority: 'urgent' });
  assert.deepEqual(N.taskPushFor(forOwner, { kind: 'created', role: 'manager' }), {
    to: 'owner',
    kind: 'task_for_owner',
    payload: { title: '📥 Задача от управляющей', body: 'Objednat barvy · до 09.10. · срочно', url: '/global/team/tasks?task=task00000000000000000001', tag: 'task-task00000000000000000001' },
  });
  const self = task({ assignee: 'manager', createdByRole: 'manager' });
  assert.equal(N.taskPushFor(self, { kind: 'created', role: 'manager' }), null, 'задача себе — без push');
  assert.equal(N.taskPushFor(self, { kind: 'done', role: 'manager' }), null);
  assert.equal(N.taskPushFor(self, { kind: 'reopen', role: 'manager' }), null);

  const reopen = N.taskPushFor(legacy, { kind: 'reopen', role: 'owner', text: 'Chybí faktura' });
  assert.deepEqual([reopen.to, reopen.payload.title, reopen.payload.body, reopen.payload.url], ['manager', '↩️ Úkol vrácen do práce', 'Objednat barvy\nChybí faktura', '/vykaz?task=task00000000000000000001']);
  const done = N.taskPushFor(legacy, { kind: 'done', role: 'manager', text: '' });
  assert.deepEqual([done.to, done.payload.title, done.payload.body, done.payload.url], ['owner', '✅ Поручение выполнено — ждёт принятия', 'Objednat barvy', '/global/team/tasks?task=task00000000000000000001']);
  const ownerDid = N.taskPushFor(forOwner, { kind: 'done', role: 'owner', text: 'Podepsáno' });
  assert.deepEqual([ownerDid.to, ownerDid.payload.title, ownerDid.payload.body], ['manager', '✅ Majitel splnil váš úkol', 'Objednat barvy\nPodepsáno']);
  // управляющая возвращает задачу владельцу / отменяет — не просили
  assert.equal(N.taskPushFor(forOwner, { kind: 'reopen', role: 'manager' }), null);
  for (const kind of ['comment', 'undone', 'progress', 'accept', 'cancel']) {
    assert.equal(N.taskPushFor(legacy, { kind, role: kind === 'accept' || kind === 'cancel' ? 'owner' : 'manager', text: 'x' }), null, kind);
  }
  // длинное название обрезается, пробелы схлопываются
  const long = N.taskPushFor(task({ title: `A  ${'b'.repeat(200)}` }), { kind: 'created', role: 'owner' }).payload.body;
  assert.ok(long.startsWith('A bbb') && long.length <= 120 + ' · do 09.10.'.length && long.includes('…'), long);
  assert.equal(N.taskPushFor({ title: 'x' }, { kind: 'created', role: 'owner' }), null, 'без id — ничего');
});

test('s262 задачи администраторам: новая, возврат — им; «hotovo» — постановщику; прочее — без push', () => {
  const VIKA = 'vika00000000000000000004'
  const one = task({ assignee: 'administrator', createdByRole: 'owner', personal: { documentId: VIKA, name: 'Viktoriia Tsybuliak' } })
  const all = task({ assignee: 'administrator', createdByRole: 'manager', personal: null, priority: 'urgent' })
  assert.deepEqual(N.taskPushFor(one, { kind: 'created', role: 'owner' }), {
    to: 'admin',
    kind: 'task_admin_created',
    payload: { title: '📋 Nový úkol od majitele', body: 'Objednat barvy · do 09.10.', url: '/ukoly?task=task00000000000000000001', tag: 'task-task00000000000000000001' },
  })
  const c = N.taskPushFor(all, { kind: 'created', role: 'manager' })
  assert.deepEqual([c.to, c.payload.title, c.payload.body], ['admins', '📋 Nový úkol od manažerky', 'Objednat barvy · do 09.10. · urgentní'])
  const r = N.taskPushFor(one, { kind: 'reopen', role: 'owner', text: 'Ještě vitrína' })
  assert.deepEqual([r.to, r.payload.title, r.payload.body, r.payload.url], ['admin', '↩️ Úkol vrácen do práce', 'Objednat barvy\nJeště vitrína', '/ukoly?task=task00000000000000000001'])
  assert.equal(N.taskPushFor(all, { kind: 'reopen', role: 'manager' }).to, 'admins')
  assert.equal(N.taskPushFor(one, { kind: 'reopen', role: 'manager' }), null, 'вернуть может только постановщик')
  const d1 = N.taskPushFor(one, { kind: 'done', role: 'administrator', text: 'Hotovo' })
  assert.deepEqual([d1.to, d1.payload.title, d1.payload.url], ['owner', '✅ Задача администратора выполнена — ждёт принятия', '/global/team/tasks?task=task00000000000000000001'])
  const d2 = N.taskPushFor(all, { kind: 'done', role: 'administrator' })
  assert.deepEqual([d2.to, d2.payload.title, d2.payload.url], ['managers', '✅ Administrátorka splnila úkol — čeká na převzetí', '/vykaz?tab=ukoly&task=task00000000000000000001'])
  for (const [kind, role] of [['comment', 'administrator'], ['progress', 'administrator'], ['undone', 'administrator'], ['accept', 'owner'], ['cancel', 'owner'], ['comment', 'manager']]) {
    assert.equal(N.taskPushFor(one, { kind, role, text: 'x' }), null, `${kind}/${role}`)
  }
});

test('s265 задача коллеге и передача: новая — коллеге, hotovo — автору; передача — получательнице и постановщику', () => {
  const VIKA = 'vika00000000000000000004'
  const OLGA = 'olga00000000000000000005'
  const peer = task({ assignee: 'administrator', createdByRole: 'administrator', createdByName: 'Vika', personal: { documentId: OLGA, name: 'Olga Eremina' } })
  const c = N.taskPushFor(peer, { kind: 'created', role: 'administrator', by: 'Vika' })
  assert.deepEqual([c.to, c.payload.title], ['admin', '📋 Úkol od kolegyně Vika'])
  const d = N.taskPushFor(peer, { kind: 'done', role: 'administrator', by: 'Olga Eremina', text: 'Ok' })
  assert.deepEqual([d.to, d.payload.title, d.payload.body, d.payload.url], ['author', '✅ Olga Eremina splnila váš úkol', 'Objednat barvy\nOk', '/ukoly?task=task00000000000000000001'])
  assert.equal(N.taskPushFor(peer, { kind: 'done', role: 'administrator', by: 'vika' }), null, 'сделала сама (после передачи обратно) — молчим')
  // передача: задача владельца, передала администраторка — ей и владельцу
  const fromOwner = task({ assignee: 'administrator', createdByRole: 'owner', personal: { documentId: OLGA, name: 'Olga Eremina' } })
  const h = N.taskPushesFor(fromOwner, { kind: 'handover', role: 'administrator', by: 'Vika', from: 'Viktoriia Tsybuliak', text: 'Chybí sklo' })
  assert.deepEqual(h.map((p) => [p.to, p.side ?? null, p.kind, p.payload.title]), [
    ['admin', 'assignee', 'task_handover_in', '📥 Předaný úkol od Vika'],
    ['owner', null, 'task_handover', '🔁 Задачу администратора передали'],
  ])
  assert.equal(h[1].payload.body, 'Objednat barvy\nViktoriia Tsybuliak → Olga Eremina\nChybí sklo')
  // quiet — получательнице сводку шлёт передача смены
  assert.deepEqual(N.taskPushesFor(fromOwner, { kind: 'handover', role: 'administrator', by: 'Vika', quiet: 'assignee' }).map((p) => p.to), ['owner'])
  // передал сам постановщик — только получательнице
  assert.deepEqual(N.taskPushesFor(fromOwner, { kind: 'handover', role: 'owner', by: 'Dima' }).map((p) => p.to), ['admin'])
  const fromMgr = task({ assignee: 'administrator', createdByRole: 'manager', personal: { documentId: VIKA, name: 'V' } })
  assert.deepEqual(N.taskPushesFor(fromMgr, { kind: 'handover', role: 'administrator', by: 'Olga Eremina' }).map((p) => p.to), ['admin', 'managers'])
  // задача коллеге: передала исполнительница — автору; передала сама автор — нет
  assert.deepEqual(N.taskPushesFor(peer, { kind: 'handover', role: 'manager', by: 'Mariia Medvedeva' }).map((p) => p.to), ['admin', 'author'])
  assert.deepEqual(N.taskPushesFor(peer, { kind: 'handover', role: 'administrator', by: 'Vika' }).map((p) => p.to), ['admin'])
  // новая задача от владельца с quiet — ничего
  assert.deepEqual(N.taskPushesFor(fromOwner, { kind: 'created', role: 'owner', quiet: 'assignee' }), [])
});

test('výkaz: владельцу при подаче, напоминания 21:00 и 09:00', () => {
  assert.deepEqual(N.reportSubmittedPayload({ name: 'Mariia Medvedeva', personal: MARIIA, date: '2026-10-07', hours: 7.5, items: 3, needsOwner: 'Schválit?' }), {
    title: '📝 Výkaz отправлен',
    body: 'Mariia Medvedeva · 07.10. · 7,5 ч · пунктов 3\n❓ Нужно ваше решение',
    url: `/global/team/reports?personal=${MARIIA}&date=2026-10-07`,
    tag: `report-${MARIIA}-2026-10-07`,
  });
  assert.equal(N.reportSubmittedPayload({ name: 'M', personal: MARIIA, date: '2026-10-07', hours: 8, items: 1 }).body, 'M · 07.10. · 8 ч · пунктов 1');
  assert.deepEqual(N.reportReminderPayload('evening', '2026-10-07'), { title: '📝 Výkaz za dnešek', body: 'Ještě není odeslán — do 10:00 zítra je včas.', url: '/vykaz', tag: 'vykaz-2026-10-07' });
  assert.deepEqual(N.reportReminderPayload('morning', '2026-10-07'), { title: '⏰ Výkaz za včerejšek', body: 'Do 10:00 je ještě včas.', url: '/vykaz?date=2026-10-07', tag: 'vykaz-2026-10-07' });
});

// «сейчас» — 07.10 12:00 UTC (14:00 Праги)
const NOW = new Date('2026-10-07T12:00:00Z');
const hAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const blk = (over) => ({ kind: 'new', documentId: 'b1', date: '2026-10-09', startMin: 600, endMin: 720, employeeName: 'Karina', createdByName: 'Vika', createdAt: hAgo(7), pushedAt: null, seriesKey: 's1', ...over });

test('блоки: серия = одна группа, возраст, отметки; предложения правки и графика', () => {
  const items = [
    blk({ documentId: 'b1', date: '2026-10-09' }),
    blk({ documentId: 'b2', date: '2026-10-16' }),
    blk({ documentId: 'b3', seriesKey: 's2', createdAt: hAgo(2), employeeName: 'Zlata' }), // моложе 6 ч
    blk({ documentId: 'b4', seriesKey: 's3', createdAt: hAgo(30), pushedAt: hAgo(20), employeeName: 'Veronika' }), // отметка действует
    // предложение правки: блок старый, отметка от прежнего ожидания — новое предложение позже → не действует
    { kind: 'change', documentId: 'b5', date: '2026-10-08', startMin: 600, endMin: 660, proposedStartMin: 660, proposedEndMin: 720, employeeName: 'Karina', createdByName: 'X', proposedByName: 'Vika', createdAt: hAgo(500), proposedAt: hAgo(8), pushedAt: hAgo(100), seriesKey: 'change|b5' },
  ];
  const plan = [
    { personal: KARINA, employeeName: 'Karina', date: '2026-10-10', label: 'volno', by: 'Vika', at: hAgo(9), pushedAt: null },
    { personal: KARINA, employeeName: 'Karina', date: '2026-10-11', label: '10:00–14:00', by: 'Vika', at: hAgo(9), pushedAt: hAgo(9) }, // отметка этого же предложения
    { personal: KARINA, employeeName: 'Karina', date: '2026-10-12', label: 'volno', by: 'Vika', at: hAgo(7), pushedAt: hAgo(30) }, // отметка прошлого предложения
  ];
  const groups = N.pendingGroups(items, plan);
  assert.equal(groups.length, 7);
  const s1 = groups.find((g) => g.key === 'block|s1');
  assert.deepEqual([s1.count, s1.date, s1.docIds, s1.marked], [2, '2026-10-09', ['b1', 'b2'], false]);
  const due = N.agingPending(groups, NOW, 6);
  // старые сверху: график 9 ч, правка 8 ч, серия и график 7 ч (равные — по дате)
  assert.deepEqual(due.map((g) => g.key), [`plan|${KARINA}|2026-10-10`, 'change|change|b5', 'block|s1', `plan|${KARINA}|2026-10-12`]);
  // старше суток без учёта отметок — только Veronika (30 ч)
  assert.deepEqual(N.agingPending(groups, NOW, 24, { ignoreMarks: true }).map((g) => g.employeeName), ['Veronika']);
  // граница: ровно 6 ч — да, 5 ч 59 мин — нет
  const edge = N.pendingGroups([blk({ createdAt: hAgo(6) }), blk({ documentId: 'x', seriesKey: 'x', createdAt: new Date(NOW.getTime() - 6 * 3600_000 + 60_000).toISOString() })], []);
  assert.deepEqual(N.agingPending(edge, NOW, 6).map((g) => g.key), ['block|s1']);
  // частично отмеченная серия (добавились новые даты) — снова в push
  const partly = N.pendingGroups([blk({ pushedAt: hAgo(1) }), blk({ documentId: 'b2', pushedAt: null })], []);
  assert.equal(N.agingPending(partly, NOW, 6).length, 1);
});

test('блоки: тексты push — один, несколько, сводка 10:00', () => {
  const one = N.pendingGroups([blk({ createdAt: hAgo(7.5) }), blk({ documentId: 'b2', date: '2026-10-16', createdAt: hAgo(7.5) })], []);
  assert.deepEqual(N.blockAgingPayload(one, NOW), {
    title: '🔒 Blok ke schválení čeká 7 h',
    body: 'Karina · 09.10. (2×) 10:00–12:00\nzadal/a Vika',
    url: '/calendar?date=2026-10-09&pending=1',
    tag: 'block-block|s1',
  });
  const planOne = N.pendingGroups([], [{ personal: KARINA, employeeName: 'Karina', date: '2026-10-10', label: 'volno', by: 'Vika', at: hAgo(6) }]);
  assert.equal(N.blockAgingPayload(planOne, NOW).title, '🔒 Návrh grafu ke schválení čeká 6 h');
  assert.equal(N.blockAgingPayload(planOne, NOW).body, 'Karina · 10.10. graf: volno\nzadal/a Vika');
  const many = N.pendingGroups(
    [
      blk({ documentId: 'a', seriesKey: 'a', createdAt: hAgo(30), date: '2026-10-20' }),
      blk({ documentId: 'b', seriesKey: 'b', createdAt: hAgo(8), employeeName: 'Zlata', date: '2026-10-08' }),
      { kind: 'change', documentId: 'c', date: '2026-10-12', proposedStartMin: 660, proposedEndMin: 720, employeeName: 'Veronika', proposedByName: 'Vika', createdAt: hAgo(99), proposedAt: hAgo(7.5), seriesKey: 'change|c' },
      blk({ documentId: 'd', seriesKey: 'd', createdAt: hAgo(7), employeeName: 'Evelina' }),
      blk({ documentId: 'e', seriesKey: 'e', createdAt: hAgo(6), employeeName: 'Nataliia' }),
    ],
    []
  );
  const p = N.blockAgingPayload(many, NOW);
  assert.equal(p.title, '🔒 Ke schválení čeká 5 položek · nejdéle 30 h');
  assert.deepEqual(p.body.split('\n'), ['Karina · 20.10. 10:00–12:00', 'Zlata · 08.10. 10:00–12:00', 'Veronika · 12.10. změna → 11:00–12:00', '… a další 2']);
  assert.equal(p.url, '/calendar?date=2026-10-08&pending=1', 'день — самый ранний');
  assert.equal(p.tag, 'blocks-aging');
  assert.equal(N.blockAgingPayload(many.slice(0, 2), NOW).title, '🔒 Ke schválení čeká 2 položky · nejdéle 30 h');
  assert.equal(N.blockAgingPayload(many.slice(0, 4), NOW).body.split('\n').length, 4, 'четыре — без «a další»');
  assert.deepEqual(N.pendingBlocksPayload(many), {
    title: '🟡 Ke schválení: 5 položek',
    body: 'Nejstarší čeká od 06.10. · Karina, Zlata, Veronika, …',
    url: '/calendar?pending=1',
    tag: 'blocks-pending',
  });
});

// ── сервис на заглушке ───────────────────────────────────────────────────────

function makeStrapi({ items = [], planRequests = [], schedules = [], vapid = true } = {}) {
  const pushed = [];
  const db = {
    'api::personal.personal': [
      { documentId: MARIIA, name: 'Mariia Medvedeva', position: 'manager', isActive: true },
      { documentId: OLD, name: 'Anna Stará', position: 'manager', isActive: false },
      { documentId: KARINA, name: 'Karina', position: 'master', isActive: true },
    ],
    'api::admin-user.admin-user': [
      { username: 'Dima', role: 'owner', isActive: true },
      { username: 'Old owner', role: 'owner', isActive: false },
      { username: 'Vika', role: 'administrator', isActive: true },
    ],
    'api::time-block.time-block': items.map((i) => ({ documentId: i.documentId, pendingPushAt: i.pushedAt || null })),
    'api::master-schedule.master-schedule': schedules,
  };
  const updates = [];
  const s = {
    pushed,
    updates,
    db: {
      query: (uid) => ({
        async updateMany({ where, data }) {
          await tick();
          updates.push({ uid, where: clone(where), data: clone(data) });
          const ids = where.documentId?.$in || [where.documentId];
          for (const r of db[uid]) if (ids.includes(r.documentId)) Object.assign(r, clone(data));
          return { count: 1 };
        },
      }),
    },
    documents: (uid) => ({
      async findMany({ filters = {} } = {}) {
        await tick();
        let rows = db[uid];
        if (filters.position) rows = rows.filter((r) => r.position === filters.position.$eq);
        if (filters.role) rows = rows.filter((r) => r.role === filters.role.$eq);
        if (filters.personal) rows = rows.filter((r) => r.personal === filters.personal.documentId.$eq);
        return clone(rows);
      },
    }),
    service: (uid) => {
      if (uid === 'api::booking-engine.push-notify') {
        return {
          async notifyPersonal(who, payload) {
            if (!vapid) return { skipped: 'no_vapid' };
            pushed.push({ to: who.personalDocId, payload });
            return { sent: 1 };
          },
          async notifyByNames(names, payload, opts) {
            if (!vapid) return { skipped: 'no_vapid' };
            pushed.push({ to: `names:${names.join(',')}`, withoutCard: opts?.withoutCard, payload });
            return { sent: 1 };
          },
        };
      }
      if (uid === 'api::booking-engine.booking-engine') {
        return {
          async adminPendingBlocks() {
            // как настоящий: отметки читаются из базы при каждом вызове
            return {
              items: items.map((i) => ({ ...i, pushedAt: db['api::time-block.time-block'].find((b) => b.documentId === i.documentId)?.pendingPushAt || null })),
              planRequests: planRequests.map((r) => ({ ...r, pushedAt: db['api::master-schedule.master-schedule'].find((d) => d.personal === r.personal)?.requestPushes?.[r.date] || null })),
            };
          },
        };
      }
      if (uid === 'api::booking-engine.work-reports') {
        return { reminderTargets: async ({ date }) => (s.reminderFor === date ? [{ documentId: MARIIA, name: 'Mariia Medvedeva' }] : []) };
      }
      throw new Error(`unexpected service ${uid}`);
    },
    log: { info() {}, error() {} },
    rows: db,
  };
  globalThis.strapi = s;
  return s;
}

test('события: управляющей — по карточке задачи, владельцу — по логинам без карточки; без push — ничего', async () => {
  const s = makeStrapi();
  const svc = N.default;
  await svc.taskEvent(task(), { kind: 'created', role: 'owner' });
  await svc.taskEvent(task({ assignee: 'owner', createdByRole: 'manager' }), { kind: 'created', role: 'manager' });
  assert.deepEqual(await svc.taskEvent(task({ assignee: 'manager', createdByRole: 'manager' }), { kind: 'created', role: 'manager' }), { skipped: 'no_push' });
  assert.deepEqual(await svc.taskEvent(task({ personal: null }), { kind: 'created', role: 'owner' }), { skipped: 'no_card' });
  await svc.reportSubmitted({ person: { documentId: MARIIA, name: 'Mariia Medvedeva' }, date: '2026-10-07', content: { hours: 6, items: [{}, {}], needsOwner: '' } });
  assert.deepEqual(
    s.pushed.map((p) => [p.to, p.withoutCard ?? null, p.payload.title]),
    [
      [MARIIA, null, '📋 Nový úkol od majitele'],
      ['names:Dima', true, '📥 Задача от управляющей'],
      ['names:Dima', true, '📝 Výkaz отправлен'],
    ],
    'неактивная учётка владельца и администраторы не получают'
  );
  assert.equal(s.pushed[2].payload.body, 'Mariia Medvedeva · 07.10. · 6 ч · пунктов 2');
});

test('s265 события: автору задачи коллеге — по карточке его учётки; передача — двум сторонам', async () => {
  const s = makeStrapi();
  s.rows['api::admin-user.admin-user'].push({ username: 'Olga Eremina', role: 'administrator', isActive: true, personalDocId: 'olga00000000000000000005' });
  const svc = N.default;
  const peer = task({ assignee: 'administrator', createdByRole: 'administrator', createdByName: 'Olga Eremina', personal: { documentId: 'vika00000000000000000004', name: 'Viktoriia Tsybuliak' } });
  await svc.taskEvent(peer, { kind: 'done', role: 'administrator', by: 'Vika' });
  // автор без связи с карточкой — по логину
  await svc.taskEvent({ ...peer, createdByName: 'Vika' }, { kind: 'done', role: 'administrator', by: 'Olga Eremina' });
  assert.deepEqual(await svc.taskEvent(task({ assignee: 'administrator', createdByRole: 'owner', personal: { documentId: 'vika00000000000000000004', name: 'V' } }), { kind: 'handover', role: 'administrator', by: 'Olga Eremina', from: 'Olga Eremina' }), { sent: 2 });
  assert.deepEqual(
    s.pushed.map((p) => [p.to, p.payload.title]),
    [
      ['olga00000000000000000005', '✅ Vika splnila váš úkol'],
      ['names:Vika', '✅ Olga Eremina splnila váš úkol'],
      ['vika00000000000000000004', '📥 Předaný úkol od Olga Eremina'],
      ['names:Dima', '🔁 Задачу администратора передали'],
    ]
  );
});

test('напоминание о výkazu: 21:00 — за сегодня, 09:00 — за вчера (через пражскую дату)', async () => {
  const s = makeStrapi();
  const svc = N.default;
  s.reminderFor = '2026-10-07';
  assert.deepEqual(await svc.remindReports({ kind: 'evening', now: new Date('2026-10-07T19:00:00Z') }), { date: '2026-10-07', targets: 1, sent: 1 });
  assert.deepEqual(s.pushed[0], { to: MARIIA, payload: N.reportReminderPayload('evening', '2026-10-07') });
  // 08.10 09:00 Праги = 07:00 UTC; вчера = 07.10
  assert.deepEqual(await svc.remindReports({ kind: 'morning', now: new Date('2026-10-08T07:00:00Z') }), { date: '2026-10-07', targets: 1, sent: 1 });
  assert.equal(s.pushed[1].payload.url, '/vykaz?date=2026-10-07');
  // зимнее время: 27.10 (вторник) 09:00 Праги = 08:00 UTC → вчера 26.10
  s.reminderFor = '2026-10-26';
  assert.equal((await svc.remindReports({ kind: 'morning', now: new Date('2026-10-27T08:00:00Z') })).date, '2026-10-26');
  s.reminderFor = null;
  assert.deepEqual(await svc.remindReports({ kind: 'evening', now: new Date('2026-10-07T19:00:00Z') }), { date: '2026-10-07', targets: 0, sent: 0 });
  assert.equal(s.pushed.length, 3);
});

test('крон «> 6 ч»: push активным управляющим, отметки, второй прогон молчит; сводка 10:00', async () => {
  const items = [
    blk({ documentId: 'b1' }),
    blk({ documentId: 'b2', date: '2026-10-16' }),
    blk({ documentId: 'b3', seriesKey: 's2', createdAt: hAgo(2) }),
    blk({ documentId: 'b4', seriesKey: 's3', createdAt: hAgo(30), pushedAt: hAgo(20), employeeName: 'Veronika' }),
  ];
  const planRequests = [{ personal: KARINA, employeeName: 'Karina', date: '2026-10-10', label: 'volno', by: 'Vika', at: hAgo(9) }];
  // прошедшая дата в отметках графика — чистится
  const s = makeStrapi({ items, planRequests, schedules: [{ documentId: 'sched1', personal: KARINA, requestPushes: { '2026-10-01': 'old', '2026-10-20': 'keep' } }] });
  const svc = N.default;
  const r1 = await svc.pushAgingBlocks({ now: NOW });
  assert.deepEqual(r1, { due: 2, sent: 1 });
  assert.equal(s.pushed.length, 1, 'одна управляющая (бывшая не получает)');
  assert.equal(s.pushed[0].to, MARIIA);
  assert.equal(s.pushed[0].payload.title, '🔒 Ke schválení čeká 2 položky · nejdéle 9 h');
  const blockUpd = s.updates.find((u) => u.uid === 'api::time-block.time-block');
  assert.deepEqual(blockUpd.where, { documentId: { $in: ['b1', 'b2'] } }, 'отметка — на всех блоках серии, не на молодых');
  assert.equal(blockUpd.data.pendingPushAt, NOW.toISOString());
  const schedUpd = s.updates.find((u) => u.uid === 'api::master-schedule.master-schedule');
  assert.deepEqual(schedUpd.data, { requestPushes: { '2026-10-20': 'keep', '2026-10-10': hAgo(9) } }, 'пишется только колонка отметок');
  // второй прогон — тихо
  assert.deepEqual(await svc.pushAgingBlocks({ now: new Date(NOW.getTime() + 3600_000) }), { due: 0 });
  assert.equal(s.pushed.length, 1);
  // через 5 ч дозрел b3 — только он
  const r3 = await svc.pushAgingBlocks({ now: new Date(NOW.getTime() + 5 * 3600_000) });
  assert.deepEqual(r3, { due: 1, sent: 1 });
  assert.equal(s.pushed[1].payload.title, '🔒 Blok ke schválení čeká 7 h');
  // сводка 10:00: старше суток без учёта отметок
  const r4 = await svc.remindPendingBlocks({ now: NOW });
  assert.deepEqual(r4, { due: 1, sent: 1 });
  assert.equal(s.pushed[2].payload.title, '🟡 Ke schválení: 1 položka');
});

test('без VAPID: ничего не отправлено и не отмечено', async () => {
  const s = makeStrapi({ items: [blk({})], vapid: false });
  const svc = N.default;
  assert.deepEqual(await svc.pushAgingBlocks({ now: NOW }), { due: 1, skipped: 'no_vapid' });
  assert.equal(s.updates.length, 0);
  assert.deepEqual(await svc.taskEvent(task(), { kind: 'created', role: 'owner' }), { skipped: 'no_vapid' });
});

test('push-notify: без VAPID — skipped; владельцу — только подписки без карточки; мёртвые чистятся', async () => {
  const subs = [
    { documentId: 's1', endpoint: 'e-owner', p256dh: 'p', auth: 'a', employeeName: 'Dima', personal: null },
    { documentId: 's2', endpoint: 'e-master-dima', p256dh: 'p', auth: 'a', employeeName: 'Dima', personal: { documentId: 'masterdima00000000000001' } },
    { documentId: 's3', endpoint: 'e-owner-dead', p256dh: 'p', auth: 'a', employeeName: 'Dima', personal: null },
    { documentId: 's4', endpoint: 'e-mariia', p256dh: 'p', auth: 'a', employeeName: 'Mariia Medvedeva', personal: { documentId: MARIIA } },
  ];
  const deleted = [];
  globalThis.strapi = {
    documents: () => ({
      async findMany({ filters = {} }) {
        if (filters.employeeName?.$in) return clone(subs.filter((x) => filters.employeeName.$in.includes(x.employeeName)));
        if (filters.personal) return clone(subs.filter((x) => x.personal?.documentId === filters.personal.documentId));
        if (filters.employeeName) return clone(subs.filter((x) => x.employeeName === filters.employeeName));
        return [];
      },
      async delete({ documentId }) {
        deleted.push(documentId);
      },
    }),
    log: { error() {} },
  };
  const push = P.default;
  const payload = { title: 't', body: 'b', url: '/vykaz', tag: 'x' };
  const keep = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    assert.deepEqual(await push.notifyPersonal({ personalDocId: MARIIA, employeeName: 'Mariia Medvedeva' }, payload), { skipped: 'no_vapid' });
    assert.deepEqual(await push.notifyByNames(['Dima'], payload, { withoutCard: true }), { skipped: 'no_vapid' });
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    globalThis.__sent = [];
    globalThis.__failStatus = { 'e-owner-dead': 410 };
    assert.deepEqual(await push.notifyByNames(['Dima', '', 'Dima'], payload, { withoutCard: true }), { sent: 1 });
    assert.deepEqual(globalThis.__sent.map((x) => x.endpoint), ['e-owner'], 'мастер с тем же именем — нет');
    assert.deepEqual(deleted, ['s3'], 'мёртвая подписка удалена');
    assert.deepEqual(globalThis.__sent[0].payload, payload);
    assert.deepEqual(await push.notifyByNames([], payload), { sent: 0 });
    assert.deepEqual(await push.notifyPersonal({ personalDocId: MARIIA, employeeName: 'Mariia Medvedeva' }, payload), { sent: 1 });
    assert.equal(globalThis.__sent.at(-1).endpoint, 'e-mariia');
  } finally {
    if (keep[0] == null) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = keep[0];
    if (keep[1] == null) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = keep[1];
  }
});

test('кроны: четыре задачи под MANAGER_PUSH_ENABLED, правила и часовой пояс', () => {
  const src = read('config/cron-tasks.ts');
  const rules = {
    managerReportReminderEvening: '0 21 * * 1-5',
    managerReportReminderMorning: '0 9 * * 2-6',
    managerAgingBlocks: '5 8-22 * * *',
    managerPendingBlocksReminder: '0 10 * * *',
  };
  for (const [name, rule] of Object.entries(rules)) {
    const i = src.indexOf(`${name}: {`);
    assert.ok(i > 0, name);
    const block = src.slice(i, src.indexOf('\n  },\n', i));
    assert.match(block, /process\.env\.MANAGER_PUSH_ENABLED !== 'true'\) return/, `${name}: флаг`);
    assert.ok(block.includes(`rule: '${rule}'`), `${name}: ${rule}`);
    assert.match(block, /tz: 'Europe\/Prague'/);
  }
  // схемы: отметки — аддитивные поля
  assert.equal(JSON.parse(read('src/api/time-block/content-types/time-block/schema.json')).attributes.pendingPushAt.type, 'datetime');
  assert.equal(JSON.parse(read('src/api/master-schedule/content-types/master-schedule/schema.json')).attributes.requestPushes.type, 'json');
});
