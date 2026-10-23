/**
 * Чат на сайте (s272): чтобы клиентка не терялась, если администраторка не успела ответить.
 *   • контакт — одно поле «e-mail или телефон» в виджете (вне часов салона сразу, в часы —
 *     если 2 мин без ответа); e-mail → непрочитанный ответ из Telegram уходит письмом,
 *     телефон → в тему Telegram «клиентка ушла, напишите SMS» (SMS шлёт администраторка сама);
 *   • вне часов салона виджет сразу показывает «offline» и когда откроемся (`chatStatusOf`);
 *   • напоминание администраторкам: 3 мин без ответа в часы салона → строка в теме + push.
 * Часы — `salon_hours` (как запись), нет строки на дату — 10:00–19:00 (как master-schedule).
 * Телефон и e-mail — те же правила, что у записи и кабинета.
 *
 * Здесь только чистые функции (tests/chat-core.test.mjs), сервис — chat.ts.
 */

import { minToHHMM, pragueDateOf, pragueMinOf } from '../../booking-engine/services/slots-core';
import { addDaysYmd, DEFAULT_CLOSE_MIN, DEFAULT_OPEN_MIN, salonWindow } from '../../booking-engine/services/master-schedule';
import { normalizePhone } from '../../booking-engine/services/booking-engine';
import { looksLikeEmail } from '../../client-cabinet/services/client-cabinet';

/** Без ответа столько минут в часы салона → напомнить администраторкам (один раз на вопрос). */
export const REMIND_AFTER_MIN = 3;
/** Вопрос старше — не напоминаем (утром — только о вчерашнем вечере и ночи). */
export const REMIND_MAX_AGE_H = 24;
/** Ответ лежит непрочитанным столько секунд — можно писать на e-mail (несколько ответов подряд — одним письмом). */
export const AWAY_DELAY_SEC = 60;
/** Виджет не спрашивал сервер столько секунд — клиентки на сайте нет (фоновый опрос — 30 с). */
export const AWAY_AFTER_SEC = 45;
/** Окно, в котором крон смотрит сообщения. */
export const TICK_WINDOW_DAYS = 3;
/** Сколько дней вперёд искать «когда откроемся». */
export const NEXT_OPEN_LOOKAHEAD_DAYS = 14;

// ── часы ─────────────────────────────────────────────────────────────────────

/** Окно салона на дату: строка `salon_hours` (закрыто → null), строки нет — 10:00–19:00. */
const windowOn = (byDate: Map<string, any>, date: string) =>
  byDate.has(date) ? salonWindow(byDate.get(date)) : { openMin: DEFAULT_OPEN_MIN, closeMin: DEFAULT_CLOSE_MIN };

/**
 * Онлайн ли чат сейчас и когда откроемся. `rows` — строки `salon_hours` с сегодня на
 * NEXT_OPEN_LOOKAHEAD_DAYS вперёд. `next` — ближайшее открытие, если сейчас закрыто.
 */
export const chatStatusOf = (rows: any[], now: Date) => {
  const byDate = new Map((rows || []).map((r) => [String(r.date), r]));
  const today = pragueDateOf(now);
  const min = pragueMinOf(now);
  const win = windowOn(byDate, today);
  if (win && min >= win.openMin && min < win.closeMin) {
    return { online: true, closesAt: minToHHMM(win.closeMin), next: null };
  }
  for (let i = 0; i <= NEXT_OPEN_LOOKAHEAD_DAYS; i++) {
    const date = addDaysYmd(today, i);
    const w = windowOn(byDate, date);
    if (!w || (i === 0 && min >= w.openMin)) continue;
    return { online: false, closesAt: null, next: { date, time: minToHHMM(w.openMin), inDays: i } };
  }
  return { online: false, closesAt: null, next: null };
};

// ── контакт ──────────────────────────────────────────────────────────────────

/** «e-mail или телефон» из одного поля → нормализованное значение или null. */
export const parseContact = (raw: unknown): { type: 'email' | 'phone'; value: string } | null => {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 120) return null;
  if (s.includes('@')) {
    const email = s.toLowerCase();
    return looksLikeEmail(email) ? { type: 'email', value: email } : null;
  }
  if (!/^[+\d][\d\s\-().]*$/.test(s)) return null;
  const phone = normalizePhone(s);
  const digits = phone.replace(/\D/g, '').length;
  return digits >= 11 && digits <= 15 ? { type: 'phone', value: phone } : null;
};

/** +420777123456 → «+420 777 123 456». */
export const fmtPhone = (p: string): string => {
  const m = /^\+420(\d{3})(\d{3})(\d{3})$/.exec(p);
  return m ? `+420 ${m[1]} ${m[2]} ${m[3]}` : p;
};

// ── крон: напоминание и «клиентка ушла» ──────────────────────────────────────

export type TickMsg = { id: number; sender: 'visitor' | 'admin'; text?: string | null; telegramFileId?: string | null; createdAt: string };
export type TickSession = {
  id: number;
  sessionId: string;
  visitorName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  lastSeenAt?: string | null;
  readUpTo?: number | null;
  awayUpTo?: number | null;
  remindedFor?: number | null;
};
export type TickPlan = {
  remind: { session: TickSession; first: TickMsg; count: number; waitedMin: number }[];
  /** непрочитанные ответы клиентке, которой уже нет на сайте: e-mail — письмо, телефон — подсказка в Telegram */
  away: { session: TickSession; msgs: TickMsg[]; via: 'email' | 'phone' }[];
};

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const hasContent = (m: TickMsg) => Boolean(String(m.text ?? '').trim() || m.telegramFileId);

/**
 * Что делать на минутном кроне. `groups` — сессия и её сообщения из окна; `online` —
 * `chatStatusOf(...).online` (напоминаем только в часы салона).
 *   • remind — первый вопрос после последнего ответа ждёт ≥ REMIND_AFTER_MIN и о нём ещё
 *     не напоминали (`remindedFor` < его id);
 *   • away — есть ответы после `readUpTo`/`awayUpTo`, первому ≥ AWAY_DELAY_SEC, а виджет
 *     молчит ≥ AWAY_AFTER_SEC (клиентки нет на сайте).
 */
export const planChatTick = (groups: { session: TickSession; msgs: TickMsg[] }[], now: Date, online: boolean): TickPlan => {
  const t = now.getTime();
  const plan: TickPlan = { remind: [], away: [] };
  for (const { session, msgs: raw } of groups) {
    const msgs = [...raw].sort((a, b) => a.id - b.id);
    if (!msgs.length) continue;

    let lastAdmin = -1;
    msgs.forEach((m, i) => {
      if (m.sender === 'admin') lastAdmin = i;
    });
    const pending = msgs.slice(lastAdmin + 1).filter((m) => m.sender === 'visitor' && hasContent(m));
    const first = pending[0];
    if (first && online && first.id > Number(session.remindedFor || 0)) {
      const waited = t - ms(first.createdAt);
      if (waited >= REMIND_AFTER_MIN * 60_000 && waited <= REMIND_MAX_AGE_H * 3_600_000) {
        plan.remind.push({ session, first, count: pending.length, waitedMin: Math.floor(waited / 60_000) });
      }
    }

    const via = session.contactEmail ? 'email' : session.contactPhone ? 'phone' : null;
    if (!via) continue;
    const base = Math.max(Number(session.readUpTo || 0), Number(session.awayUpTo || 0));
    const unread = msgs.filter((m) => m.sender === 'admin' && m.id > base && hasContent(m));
    if (!unread.length || t - ms(unread[0].createdAt) < AWAY_DELAY_SEC * 1000) continue;
    const seen = ms(session.lastSeenAt);
    if (Number.isFinite(seen) && t - seen < AWAY_AFTER_SEC * 1000) continue;
    plan.away.push({ session, msgs: unread, via });
  }
  return plan;
};

// ── тексты (чешский — администраторки) ───────────────────────────────────────

const cut = (s: unknown, n: number) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/** Строка в тему Telegram и push администраторкам. Ждёт дольше часа (ночной вопрос) — «od 22:14». */
export const reminderTexts = ({ session, first, count, waitedMin }: TickPlan['remind'][number]) => {
  const name = cut(session.visitorName || 'Návštěvník', 40);
  const wait = waitedMin < 60 ? `${waitedMin} min` : `od ${minToHHMM(pragueMinOf(first.createdAt))}`;
  const what = String(first.text ?? '').trim() ? cut(first.text, 90) : '📷 obrázek';
  const contact = session.contactEmail
    ? ' Odpověď jí přijde i e-mailem.'
    : session.contactPhone
      ? ` Telefon: ${fmtPhone(session.contactPhone)}.`
      : '';
  return {
    telegram: `⏰ Klientka čeká na odpověď (${wait}${count > 1 ? `, zpráv: ${count}` : ''}).${contact}`,
    push: { title: `💬 Chat: ${name} čeká ${wait}`, body: `${what}\nOdpovězte v Telegramu`, tag: `chat-wait-${session.sessionId}` },
  };
};

/** Подсказка в тему, когда ответ не прочитан, а клиентки на сайте нет. */
export const awayTelegramText = ({ session, via }: TickPlan['away'][number]): string =>
  via === 'email'
    ? `✉️ Klientka už není na webu — odpověď jsme jí poslali e-mailem (${session.contactEmail}).`
    : `📵 Klientka už není na webu a odpověď neviděla. Napište jí SMS: ${fmtPhone(String(session.contactPhone))}`;

/** Сообщение в тему при сохранении контакта. */
export const contactTelegramText = (c: { type: 'email' | 'phone'; value: string }): string =>
  c.type === 'email'
    ? `📇 Klientka nechala e-mail: ${c.value}\nKdyž odejde z webu, vaše odpověď jí přijde e-mailem automaticky.`
    : `📇 Klientka nechala telefon: ${fmtPhone(c.value)}\nKdyž odejde z webu dřív, než odpovíte, napište jí SMS.`;

/** Имя темы: «💬 Jana · 📞 +420 777 123 456» (Telegram — до 128 символов). */
export const topicName = (visitorName: string | null | undefined, c: { email?: string | null; phone?: string | null } = {}): string => {
  const parts = [`💬 ${cut(visitorName || 'Návštěvník', 40)}`];
  if (c.phone) parts.push(`📞 ${fmtPhone(c.phone)}`);
  if (c.email) parts.push(`📧 ${c.email}`);
  return parts.join(' · ').slice(0, 128);
};
