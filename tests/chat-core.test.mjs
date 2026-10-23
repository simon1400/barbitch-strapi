// Чат на сайте (s272, services/chat-core.ts): часы по salon_hours, «e-mail или телефон»,
// кому напомнить (3 мин без ответа в часы салона) и кому слать непрочитанный ответ
// (клиентки нет на сайте). Часы, телефон и e-mail — НАСТОЯЩИЕ функции записи и кабинета:
// модули подставляются по импорту, normalizePhone/looksLikeEmail вырезаются из исходников.
// Запуск: cd strapi && node --test tests/chat-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const swap = (js, pairs) => {
  for (const [from, to] of pairs) {
    assert.ok(js.includes(from), `импорт ${from} не найден`);
    js = js.split(from).join(to);
  }
  return js;
};
const cutOut = (file, re) => {
  const m = read(file).match(re);
  assert.ok(m, `в ${file} не найдено ${re}`);
  return m[0].replace(/^(export )?const/, 'export const');
};

const slotsUrl = dataUrl(toJs(read('src/api/booking-engine/services/slots-core.ts')));
const msUrl = dataUrl(swap(toJs(read('src/api/booking-engine/services/master-schedule.ts')), [["from './slots-core'", `from '${slotsUrl}'`]]));
const phoneUrl = dataUrl(toJs(cutOut('src/api/booking-engine/services/booking-engine.ts', /export const normalizePhone = [\s\S]*?\n};\n/)));
const emailUrl = dataUrl(toJs(cutOut('src/api/client-cabinet/services/client-cabinet.ts', /export const looksLikeEmail =[\s\S]*?;\n/)));
const C = await import(
  dataUrl(
    swap(toJs(read('src/api/chat/services/chat-core.ts')), [
      ["from '../../booking-engine/services/slots-core'", `from '${slotsUrl}'`],
      ["from '../../booking-engine/services/master-schedule'", `from '${msUrl}'`],
      ["from '../../booking-engine/services/booking-engine'", `from '${phoneUrl}'`],
      ["from '../../client-cabinet/services/client-cabinet'", `from '${emailUrl}'`],
    ])
  )
);

// 23.10.2026 — летнее время ещё действует (UTC+2); 26.10 — уже зимнее (UTC+1)
const at = (iso) => new Date(iso);
const row = (date, openMin = 600, closeMin = 1140) => ({ date, openMin, closeMin });

// ── часы ─────────────────────────────────────────────────────────────────────

test('часы: внутри окна салона — онлайн, до закрытия', () => {
  const s = C.chatStatusOf([row('2026-10-23')], at('2026-10-23T12:00:00Z')); // 14:00 Praha
  assert.deepEqual(s, { online: true, closesAt: '19:00', next: null });
});

test('часы: ровно 19:00 и 9:59 — офлайн; утром «сегодня в 10:00», вечером — завтра', () => {
  const rows = [row('2026-10-23'), row('2026-10-24')];
  const evening = C.chatStatusOf(rows, at('2026-10-23T17:00:00Z')); // 19:00
  assert.equal(evening.online, false);
  assert.deepEqual(evening.next, { date: '2026-10-24', time: '10:00', inDays: 1 });
  const morning = C.chatStatusOf(rows, at('2026-10-23T07:59:00Z')); // 09:59
  assert.equal(morning.online, false);
  assert.deepEqual(morning.next, { date: '2026-10-23', time: '10:00', inDays: 0 });
});

test('часы: закрытый день (closeMin ≤ openMin / null) пропускается, нет строки — 10–19', () => {
  const rows = [row('2026-12-24', null, null), row('2026-12-25', 600, 600), row('2026-12-26', 720, 960)];
  const s = C.chatStatusOf(rows, at('2026-12-24T11:00:00Z'));
  assert.equal(s.online, false);
  assert.deepEqual(s.next, { date: '2026-12-26', time: '12:00', inDays: 2 });
  // строк нет совсем (за горизонтом) — как master-schedule: 10:00–19:00
  assert.equal(C.chatStatusOf([], at('2027-06-01T10:00:00Z')).online, true);
});

test('часы: пражская зона, а не UTC (после перехода на зимнее время)', () => {
  // 26.10 09:30 UTC = 10:30 Praha (UTC+1)
  assert.equal(C.chatStatusOf([row('2026-10-26')], at('2026-10-26T09:30:00Z')).online, true);
  // 26.10 08:30 UTC = 09:30 Praha
  assert.equal(C.chatStatusOf([row('2026-10-26')], at('2026-10-26T08:30:00Z')).online, false);
});

// ── контакт ──────────────────────────────────────────────────────────────────

test('контакт: e-mail — нижний регистр, мусор — null', () => {
  assert.deepEqual(C.parseContact('  Jana.Nova@Seznam.CZ '), { type: 'email', value: 'jana.nova@seznam.cz' });
  assert.equal(C.parseContact('jana@seznam'), null);
  assert.equal(C.parseContact('jana @seznam.cz'), null);
  assert.equal(C.parseContact(''), null);
  assert.equal(C.parseContact('x'.repeat(130) + '@a.cz'), null);
});

test('контакт: телефон — как в записи (9 цифр → +420, 00 → +), длина проверяется', () => {
  assert.deepEqual(C.parseContact('777 123 456'), { type: 'phone', value: '+420777123456' });
  assert.deepEqual(C.parseContact('+420 777-123-456'), { type: 'phone', value: '+420777123456' });
  assert.deepEqual(C.parseContact('00421 905 123 456'), { type: 'phone', value: '+421905123456' });
  assert.equal(C.parseContact('12345'), null);
  assert.equal(C.parseContact('+42077712'), null);
  assert.equal(C.parseContact('zavolejte mi'), null);
  assert.equal(C.fmtPhone('+420777123456'), '+420 777 123 456');
  assert.equal(C.fmtPhone('+421905123456'), '+421905123456');
});

// ── крон ─────────────────────────────────────────────────────────────────────

const NOW = at('2026-10-23T12:00:00Z'); // 14:00 Praha
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
const sess = (extra = {}) => ({ id: 1, sessionId: 'chat_1_abcd', visitorName: 'Jana', ...extra });
const v = (id, sec, text = 'Máte volno v sobotu?') => ({ id, sender: 'visitor', text, createdAt: ago(sec) });
const a = (id, sec, text = 'Ano, ve 13:00') => ({ id, sender: 'admin', text, createdAt: ago(sec) });

test('напоминание: 3 мин без ответа в часы салона — один раз на вопрос', () => {
  const g = { session: sess(), msgs: [v(1, 200), v(2, 100)] };
  const p = C.planChatTick([g], NOW, true);
  assert.equal(p.remind.length, 1);
  assert.equal(p.remind[0].first.id, 1);
  assert.equal(p.remind[0].count, 2);
  assert.equal(p.remind[0].waitedMin, 3);
  // уже напомнили об этом вопросе — тишина
  assert.equal(C.planChatTick([{ ...g, session: sess({ remindedFor: 1 }) }], NOW, true).remind.length, 0);
  // вне часов салона — тишина
  assert.equal(C.planChatTick([g], NOW, false).remind.length, 0);
  // 2 мин — ещё рано
  assert.equal(C.planChatTick([{ session: sess(), msgs: [v(1, 150)] }], NOW, true).remind.length, 0);
});

test('напоминание: ответили — нет; новый вопрос после ответа — новое напоминание', () => {
  assert.equal(C.planChatTick([{ session: sess(), msgs: [v(1, 600), a(2, 500)] }], NOW, true).remind.length, 0);
  const p = C.planChatTick([{ session: sess({ remindedFor: 1 }), msgs: [v(1, 900), a(2, 800), v(3, 240)] }], NOW, true);
  assert.equal(p.remind.length, 1);
  assert.equal(p.remind[0].first.id, 3);
});

test('напоминание: ночной вопрос утром — «od 22:14»; старше суток — нет', () => {
  const night = { session: sess(), msgs: [{ id: 1, sender: 'visitor', text: 'Ahoj', createdAt: '2026-10-22T20:14:00Z' }] };
  const p = C.planChatTick([night], at('2026-10-23T08:01:00Z'), true);
  assert.equal(p.remind.length, 1);
  assert.match(C.reminderTexts(p.remind[0]).telegram, /od 22:14/);
  assert.equal(C.planChatTick([{ session: sess(), msgs: [v(1, 25 * 3600)] }], NOW, true).remind.length, 0);
});

test('ушла: e-mail — непрочитанный ответ старше минуты, виджет молчит ≥ 45 с', () => {
  const s = sess({ contactEmail: 'jana@seznam.cz', lastSeenAt: ago(120), readUpTo: 1 });
  const p = C.planChatTick([{ session: s, msgs: [v(1, 600), a(2, 90), a(3, 70)] }], NOW, true);
  assert.equal(p.away.length, 1);
  assert.equal(p.away[0].via, 'email');
  assert.deepEqual(p.away[0].msgs.map((m) => m.id), [2, 3]);
});

test('ушла: на сайте, прочитала, рано, уже отправили, нет контакта — ничего', () => {
  const base = { contactEmail: 'jana@seznam.cz', lastSeenAt: ago(120) };
  const msgs = [v(1, 600), a(2, 90)];
  const none = (session, m = msgs) => assert.equal(C.planChatTick([{ session: sess(session), msgs: m }], NOW, true).away.length, 0);
  none({ ...base, lastSeenAt: ago(20) }); // ещё на сайте
  none({ ...base, readUpTo: 2 }); // открыла чат и видела
  none({ ...base, awayUpTo: 2 }); // уже отправили
  none(base, [v(1, 600), a(2, 30)]); // ответу меньше минуты — ждём, вдруг допишут
  none({ lastSeenAt: ago(120) }); // контакта нет
  none(base, [v(1, 600), a(2, 90, '  ')]); // пустое сообщение (стикер)
});

test('ушла: телефон — подсказка «напишите SMS» в Telegram', () => {
  const p = C.planChatTick([{ session: sess({ contactPhone: '+420777123456' }), msgs: [v(1, 600), a(2, 90)] }], NOW, true);
  assert.equal(p.away[0].via, 'phone');
  assert.match(C.awayTelegramText(p.away[0]), /SMS: \+420 777 123 456/);
});

test('тексты: тема с контактом ≤ 128, push с тегом сессии', () => {
  assert.equal(C.topicName('Jana', { phone: '+420777123456' }), '💬 Jana · 📞 +420 777 123 456');
  assert.ok(C.topicName('J'.repeat(200), { email: 'x'.repeat(150) + '@a.cz' }).length <= 128);
  const [r] = C.planChatTick([{ session: sess(), msgs: [{ id: 1, sender: 'visitor', text: '', telegramFileId: 'f', createdAt: ago(400) }] }], NOW, true).remind;
  const t = C.reminderTexts(r);
  assert.equal(t.push.tag, 'chat-wait-chat_1_abcd');
  assert.match(t.push.body, /📷 obrázek/);
  assert.match(C.contactTelegramText({ type: 'email', value: 'jana@seznam.cz' }), /přijde e-mailem/);
});
