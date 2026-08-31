// @ts-nocheck
// Нотификации движка бронирования (own-booking шаг 6): e-mail через Resend HTTP API
// (подтверждение с ICS-вложением, reminder T−24ч, отмена) + Telegram-оповещения салону.
//
// Гейты (безопасно деплоить всегда):
//   - e-mail шлётся ТОЛЬКО при заданном RESEND_API_KEY (иначе тихий skip с логом);
//   - Telegram — ТОЛЬКО при ENGINE_NOTIFY_TELEGRAM_ENABLED=true (бот/чат:
//     ENGINE_NOTIFY_TG_BOT_TOKEN/CHAT_ID, фолбэк на TELEGRAM_DIGEST_*);
//   - reminder-крон — ТОЛЬКО при ENGINE_REMINDERS_ENABLED=true (config/cron-tasks.ts);
//   - ENGINE_NOTIFY_DRY=true — рендер+лог без реальной отправки (локальные тесты).
// Ошибка нотификации НИКОГДА не роняет бронь: вызовы из движка fire-and-forget.

import {
  CANCEL_MIN_HOURS,
  minToHHMM,
  utcToPragueMinClamped,
} from './slots-core';
// только для превью письма-просьбы об отзыве (сборка ссылки из GOOGLE_PLACE_ID);
// модуль на загрузке ничего не делает, кроме чтения env — цикла импорта нет
import { reviewUrl } from '../../review-request/services/review-request';

const BOOKING_UID = 'api::booking.booking';

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://barbitch.cz';
const SALON_NAME = 'Bar.Bitch Brno';
const SALON_ADDRESS = 'Křenová 294/16, Brno 602 00';
const SALON_PHONE = '+420 776 527 194';
const LOGO_URL = 'https://barbitch.cz/assets/logo-email.png';
const RESEND_URL = 'https://api.resend.com/emails';
const TG_API = 'https://api.telegram.org/bot';

const FROM = process.env.RESEND_FROM_EMAIL || `Bar.Bitch <info@barbitch.cz>`;

const isDry = () => ['true', '1'].includes(String(process.env.ENGINE_NOTIFY_DRY || ''));

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ── представление брони для писем/сообщений ──

const czDateLabel = (iso) =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));

// Короткая дата для Telegram: «út 21. 7.» (сокр. день недели + D. M., без года).
const czDateShort = (iso) =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
  }).format(new Date(iso));

// Цена с разделением тысяч: «1 190 Kč», «935 Kč».
const fmtKc = (n) => `${Number(n).toLocaleString('cs-CZ')} Kč`;

// Дата брони как «YYYY-MM-DD» в пражской зоне (сервер в UTC — сравнивать
// getDate() нельзя). Нужна reminder'у, чтобы отличить «dnes» от «zítra».
const pragueYmd = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

// Следующий день от «YYYY-MM-DD» (через полдень UTC — DST не сдвигает).
const nextYmd = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// 'today' | 'tomorrow' | 'later' — термин относительно СЕЙЧАС (Прага).
// Reminder-крон ловит окно now..+24ч, туда попадают и сегодняшние брони
// (клиентка записалась утром на вечер того же дня) — им нельзя писать «zítra».
const dayRelation = (iso: string): 'today' | 'tomorrow' | 'later' => {
  if (!iso) return 'later';
  const target = pragueYmd(new Date(iso));
  const today = pragueYmd(new Date());
  if (target === today) return 'today';
  if (target === nextYmd(today)) return 'tomorrow';
  return 'later';
};

export interface BookingNotifyView {
  bookingId: string;
  dateLabel: string; // «neděle 12. 7. 2026»
  dateShort: string; // «ne 12. 7.» (для Telegram)
  time: string; // «14:00»
  startsAt: string;
  endsAt: string;
  serviceTitle: string;
  serviceTitles: string[]; // каждая услуга отдельно (мульти-бронь → построчно в Telegram)
  employeeName: string;
  price: number | null;
  // Полная цена ДО ВСЕХ скидок (senior-каталог). Заполнена ТОЛЬКО когда разбивка
  // сходится: price + junior + bitchcard + dozápis = fullPrice. При ручной цене
  // админа (priceOverride) сумма не сойдётся → null, и тогда ни письмо, ни Telegram
  // про скидки не пишут вообще (лучше молчать, чем приписать скидке чужие деньги).
  fullPrice: number | null;
  // Скидка за junior-тир мастера. Процент считается ОТ КАТАЛОГА (senior→junior),
  // а НЕ от оплаченной суммы — иначе к нему приплюсовывались бы bitchcard и dozápis
  // (реальный баг: бронь 990→792 junior + 158 bitchcard показывалась как «junior −36 %»).
  juniorDiscount: { percent: number; discountKc: number } | null;
  // Погашенная награда bitchcard (коллекция redemption, к брони цепляется отдельно).
  redemption: { discountKc: number; title: string } | null;
  // Дозапись (rebook, s133): бронь со скидкой −15 % сразу после визита.
  isRebook: boolean; // discount.type==='rebook' — штамп «Dozápis»
  rebookDiscount: { percent: number; discountKc: number; originalPrice: number } | null; // только пока скидка applied
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  cancelUrl: string;
  manageUrl: string; // страница «Moje rezervace»: перенос термина + отмена
}

const viewFromBookingDoc = (booking): BookingNotifyView => {
  const services = Array.isArray(booking.services) ? booking.services : [];
  const svc = services[0] || null;
  const price = booking.totalPrice != null ? Number(booking.totalPrice) : null;
  // Две суммы каталожного снапшота брони: `price` позиции — цена ПО ТИРУ мастера
  // (у junior уже −20 %), `seniorPrice` — та же услуга по полному прайсу. Разница
  // между ними и есть junior-скидка; всё остальное (bitchcard, dozápis) снимается
  // уже с каталожной суммы и в снапшоте не отражено.
  const catalogTotal = services.reduce((sum, s) => sum + Number(s?.price ?? s?.seniorPrice ?? 0), 0);
  const seniorTotal = services.reduce((sum, s) => sum + Number(s?.seniorPrice ?? s?.price ?? 0), 0);
  // Junior-скидка: только у junior-мастера И когда senior-цена реально выше
  // каталожной (у зеркальных Noona-броней цен в снапшоте нет → скидки нет).
  const juniorKc =
    booking.employee?.tier === 'junior' && seniorTotal > catalogTotal + 0.5
      ? Math.round(seniorTotal - catalogTotal)
      : 0;
  const juniorDiscount = juniorKc
    ? { percent: Math.round((1 - catalogTotal / seniorTotal) * 100), discountKc: juniorKc }
    : null;
  // Дозапись: скидка живёт в booking.discount (json). Штамп «Dozápis» — по type;
  // строка со скидкой — только пока applied (админ мог её снять из drawer календаря).
  const disc = booking.discount;
  const isRebook = disc?.type === 'rebook';
  const rebookDiscount =
    isRebook && disc.applied && Number(disc.discountKc) > 0
      ? {
          percent: Number(disc.percent) || 15,
          discountKc: Number(disc.discountKc),
          originalPrice: Number(disc.originalPrice),
        }
      : null;
  // Погашенная награда bitchcard: цепляется к брони в loadBooking/attachRedemptions
  // (в самой брони её нет — сумма живёт в отдельной коллекции redemption).
  const redemptionKc = Math.max(0, Math.round(Number(booking.__redemptionKc) || 0));
  const redemption = redemptionKc
    ? { discountKc: redemptionKc, title: String(booking.__redemptionTitle || '') }
    : null;
  // Сверка: разбивка показывается ТОЛЬКО если оплаченная сумма и все известные
  // скидки складываются в senior-каталог. Не сошлось (ручная цена админа) → о
  // скидках молчим и печатаем один итог.
  const discountsKc = juniorKc + (rebookDiscount?.discountKc || 0) + redemptionKc;
  const reconciles =
    price != null && seniorTotal > 0 && Math.abs(price + discountsKc - seniorTotal) <= 1;
  const serviceTitles = services.map((s) => s?.title).filter(Boolean);
  return {
    bookingId: booking.documentId,
    dateLabel: booking.startsAt ? czDateLabel(booking.startsAt) : String(booking.date),
    dateShort: booking.startsAt ? czDateShort(booking.startsAt) : String(booking.date),
    time: booking.startsAt
      ? minToHHMM(utcToPragueMinClamped(booking.startsAt, String(booking.date)))
      : '',
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    serviceTitle: serviceTitles.join(', ') || svc?.title || '',
    serviceTitles,
    employeeName: booking.employee?.name || booking.employeeNameRaw || '',
    price,
    fullPrice: reconciles && discountsKc > 0.5 ? Math.round(seniorTotal) : null,
    juniorDiscount: reconciles ? juniorDiscount : null,
    redemption: reconciles ? redemption : null,
    isRebook,
    rebookDiscount: reconciles ? rebookDiscount : null,
    clientName: booking.client?.name || booking.clientNameRaw || '',
    clientEmail: booking.client?.email || '',
    clientPhone: booking.client?.phone || '',
    cancelUrl: booking.cancelToken ? `${SITE_URL}/rezervace/zrusit/${booking.cancelToken}` : '',
    manageUrl: booking.cancelToken ? `${SITE_URL}/rezervace/${booking.cancelToken}` : '',
  };
};

// ── ICS (VEVENT в UTC — без VTIMEZONE) ──

const icsDt = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const icsEscape = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

export const buildIcs = (v: BookingNotifyView): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Barbitch//Booking Engine//CS',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${v.bookingId}@barbitch.cz`,
    `DTSTAMP:${icsDt(new Date().toISOString())}`,
    `DTSTART:${icsDt(v.startsAt)}`,
    `DTEND:${icsDt(v.endsAt)}`,
    `SUMMARY:${icsEscape(`${v.serviceTitle} — ${SALON_NAME}`)}`,
    `LOCATION:${icsEscape(SALON_ADDRESS)}`,
    `DESCRIPTION:${icsEscape(
      `Mistrová: ${v.employeeName}${v.price != null ? `\nCena: ${v.price} Kč` : ''}${v.manageUrl ? `\nZměna či zrušení rezervace: ${v.manageUrl}` : ''}`
    )}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

// ── e-mail рендер (бренд-канон = client send-mail-voucher/htmlTemplate.ts) ──

const detailRow = (label, value) => `
  <tr>
    <td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#bdbdbd;padding:4px 0;">
      <strong style="color:#ffffff;">${esc(label)}:</strong> ${esc(value)}
    </td>
  </tr>`;

// То же, но значение — уже готовый HTML (многострочная разбивка скидок).
// Экранирует ВЫЗЫВАЮЩИЙ: сюда попадают только собранные нами строки.
const detailRowHtml = (label, valueHtml) => `
  <tr>
    <td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#bdbdbd;padding:4px 0;">
      <strong style="color:#ffffff;">${esc(label)}:</strong> ${valueHtml}
    </td>
  </tr>`;

const renderEmail = ({ heading, intro, rows, note, ctaLabel, ctaUrl, secondaryHtml }) => `<!DOCTYPE html>
<html lang="cs">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(heading)}</title>
    <style>
      @media (max-width:600px){
        .container{width:100%!important}
        .px{padding-left:16px!important;padding-right:16px!important}
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#1f1f1f;-webkit-text-size-adjust:100%;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#e71e6e;">
      <tr>
        <td>
          <table role="presentation" align="center" width="600" class="container" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;background:#161615;color:#ffffff;width:600px;">
            <tr>
              <td style="padding:24px;text-align:center;background:#e71e6e;">
                <img src="${LOGO_URL}" alt="Bar.Bitch" width="220" style="max-width:220px;height:auto;display:block;margin:0 auto;">
              </td>
            </tr>
            <tr>
              <td class="px" style="padding:24px 24px 0 24px;text-align:center;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;line-height:1.3;color:#ffffff;margin:0;">
                  ${heading}
                </div>
              </td>
            </tr>
            <tr>
              <td class="px" style="padding:16px 24px 20px 24px;text-align:center;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#e6e6e6;margin:0;">
                  ${intro}
                </div>
              </td>
            </tr>
            <tr>
              <td class="px" style="padding:0 24px 8px 24px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;">
                  <tr>
                    <td style="padding:14px 16px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                        ${rows}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ${
              ctaLabel && ctaUrl
                ? `<tr>
              <td class="px" style="padding:20px 24px 4px 24px;text-align:center;">
                <a href="${ctaUrl}" style="display:inline-block;background:#e71e6e;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:24px;">
                  ${esc(ctaLabel)} →
                </a>
              </td>
            </tr>`
                : ''
            }
            ${secondaryHtml || ''}
            ${
              note
                ? `<tr>
              <td class="px" style="padding:18px 24px 4px 24px;text-align:center;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:19px;color:#a0a0a0;margin:0;">
                  ${note}
                </div>
              </td>
            </tr>`
                : ''
            }
            <tr>
              <td style="padding:22px 24px;text-align:center;background:#0f0f0f;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#a0a0a0;">
                  ${esc(SALON_NAME)} · ${esc(SALON_ADDRESS)}<br>
                  <a href="tel:${SALON_PHONE.replace(/\s/g, '')}" style="color:#e71e6e;text-decoration:none;">${esc(SALON_PHONE)}</a>
                  · <a href="${SITE_URL}" style="color:#e71e6e;text-decoration:none;">barbitch.cz</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

// Разбивка скидок брони — ЕДИНЫЙ источник для письма клиенту и Telegram салону
// (иначе две копии расчёта неминуемо разъезжаются). Пусто, когда сумма не сошлась
// (ручная цена админа) — тогда ни письмо, ни TG про скидки ничего не утверждают.
// Текст НЕ экранирован — экранирует рендерер (в title награды приходят данные из CM).
const discountParts = (v: BookingNotifyView): { icon: string; text: string }[] => {
  const out: { icon: string; text: string }[] = [];
  if (v.juniorDiscount) {
    out.push({
      icon: '🎓',
      text: `Junior mistrová −${v.juniorDiscount.percent} % (−${fmtKc(v.juniorDiscount.discountKc)})`,
    });
  }
  if (v.redemption) {
    out.push({
      icon: '🎟',
      text: `Bitchcard${v.redemption.title ? ` — ${v.redemption.title}` : ''} (−${fmtKc(v.redemption.discountKc)})`,
    });
  }
  if (v.rebookDiscount) {
    out.push({
      icon: '🏷',
      text: `Sleva za dozápis ${v.rebookDiscount.percent} % (−${fmtKc(v.rebookDiscount.discountKc)})`,
    });
  }
  return out;
};

const discountRow = (v: BookingNotifyView) => {
  const parts = discountParts(v);
  if (!parts.length) return '';
  const lines = parts.map((p) => esc(p.text));
  if (v.fullPrice != null) lines.push(`běžná cena ${esc(fmtKc(v.fullPrice))}`);
  return detailRowHtml('Sleva', lines.join('<br>'));
};

const bookingRows = (v: BookingNotifyView) =>
  [
    detailRow('Datum', `${v.dateLabel} v ${v.time}`),
    detailRow('Služba', v.serviceTitle),
    detailRow('Mistrová', v.employeeName),
    v.price != null ? detailRow('Cena', `${v.price} Kč (platba na pobočce)`) : '',
    discountRow(v),
    detailRow('Adresa', SALON_ADDRESS),
  ].join('');

const cancelNote = (v: BookingNotifyView) =>
  `Termín můžete změnit nebo zrušit nejpozději ${CANCEL_MIN_HOURS} hodiny předem${
    v.manageUrl
      ? ` — <a href="${v.manageUrl}" style="color:#e71e6e;">spravovat rezervaci zde</a>`
      : ''
  }. Poté prosím volejte do salonu.`;

// Кнопка «SPRAVOVAT REZERVACI» (перенос/отмена) — в подтверждении, reminder-е и письме о переносе.
const manageCta = (v: BookingNotifyView) =>
  v.manageUrl ? { ctaLabel: 'SPRAVOVAT REZERVACI', ctaUrl: v.manageUrl } : {};

// CTA věrnostního programu bitchcard (К4) — блок в письме-подтверждении.
// Только при включённой программе (LOYALTY_ENABLED); без env писем это не касается.
const loyaltyCtaHtml = () =>
  process.env.LOYALTY_ENABLED === 'true'
    ? `<tr>
      <td class="px" style="padding:18px 24px 4px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0f0f0f;border:1px dashed #e71e6e;border-radius:8px;">
          <tr>
            <td style="padding:14px 16px;text-align:center;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;margin:0 0 6px 0;">
                ✦ Sbírejte nálepky bitchcard ✦
              </div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:19px;color:#e6e6e6;margin:0 0 10px 0;">
                Za každých utracených 1&nbsp;000&nbsp;Kč nálepka — odměny až sleva 50&nbsp;%.
                Sledujte svou kartu v klientském kabinetu.
              </div>
              <a href="${SITE_URL}/cabinet" style="display:inline-block;color:#e71e6e;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;text-decoration:none;">
                Můj účet →
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
    : '';

// ── транспорты ──

export default {
  async sendEmail({ to, subject, html, attachments }) {
    const key = process.env.RESEND_API_KEY;
    if (!to) {
      strapi.log.info('booking-notify: no recipient e-mail — skip');
      return { skipped: 'no_recipient' };
    }
    if (!key) {
      strapi.log.info(`booking-notify: RESEND_API_KEY not set — skip e-mail "${subject}" → ${to}`);
      return { skipped: 'no_api_key' };
    }
    if (isDry()) {
      strapi.log.info(`booking-notify DRY e-mail → ${to} | ${subject} | html ${html.length}b | att ${attachments?.length || 0}`);
      return { dry: true };
    }
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, attachments }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  },

  async sendTelegram(text) {
    if (process.env.ENGINE_NOTIFY_TELEGRAM_ENABLED !== 'true') {
      strapi.log.info('booking-notify: telegram disabled (ENGINE_NOTIFY_TELEGRAM_ENABLED != true) — skip');
      return { skipped: 'disabled' };
    }
    const botToken = process.env.ENGINE_NOTIFY_TG_BOT_TOKEN || process.env.TELEGRAM_DIGEST_BOT_TOKEN;
    const chatId = process.env.ENGINE_NOTIFY_TG_CHAT_ID || process.env.TELEGRAM_DIGEST_CHAT_ID;
    if (!botToken || !chatId) {
      strapi.log.info('booking-notify: telegram bot/chat env not set — skip');
      return { skipped: 'no_creds' };
    }
    if (isDry()) {
      strapi.log.info(`booking-notify DRY telegram → ${chatId}: ${text}`);
      return { dry: true };
    }
    const res = await fetch(`${TG_API}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  },

  // Структурированное тело сообщения о брони для Telegram (каждый údaj на своей
  // строке): термин · мастер · услуги · цена (+ скидка) · клиент. Заголовок
  // (🟢 Nová rezervace / ❌ / 🟠) добавляет вызывающая функция.
  // opts.fromShort — старый термин «дд · чч:мм» для строки переноса (from → to).
  buildBookingTgBody(v: BookingNotifyView, opts: { fromShort?: string } = {}) {
    const L: string[] = [];
    // термин
    if (opts.fromShort) {
      L.push(`🗓 <s>${esc(opts.fromShort)}</s> → <b>${esc(v.dateShort)} · ${esc(v.time)}</b>`);
    } else {
      L.push(`🗓 <b>${esc(v.dateShort)} · ${esc(v.time)}</b>`);
    }
    // мастер
    if (v.employeeName) L.push(`💇 <b>${esc(v.employeeName)}</b>`);
    // услуги (каждая отдельной строкой; для доп. строк лёгкий отступ под текст)
    const titles = v.serviceTitles.length ? v.serviceTitles : v.serviceTitle ? [v.serviceTitle] : [];
    titles.forEach((t, i) => L.push(i === 0 ? `💅 ${esc(t)}` : `       ${esc(t)}`));
    // цена + КАЖДАЯ скидка отдельной строкой (их может быть несколько сразу:
    // junior-тир + bitchcard + дозапись). Зачёркнутая рядом с итогом — полная
    // senior-цена; её нет, когда разбивка не сошлась (цена задана админом руками).
    if (v.price != null) {
      L.push(
        v.fullPrice != null && v.fullPrice > v.price
          ? `💰 <b>${fmtKc(v.price)}</b>  <s>${fmtKc(v.fullPrice)}</s>`
          : `💰 <b>${fmtKc(v.price)}</b>`
      );
      for (const p of discountParts(v)) L.push(`${p.icon} ${esc(p.text)}`);
    }
    // клиент (без телефона)
    if (v.clientName) L.push(`👤 ${esc(v.clientName)}`);
    return L.join('\n');
  },

  // ── сборка писем (используется и превью-ручкой) ──

  buildConfirmation(v: BookingNotifyView) {
    const subject = `Rezervace potvrzena — ${v.dateLabel} v ${v.time} | Bar.Bitch`;
    const html = renderEmail({
      heading: 'Rezervace potvrzena ✨',
      intro: `${esc(v.clientName || 'Dobrý den')}, těšíme se na vás v ${esc(SALON_NAME)}! Detaily vaší návštěvy najdete níže, pozvánku do kalendáře přikládáme.`,
      rows: bookingRows(v),
      note: cancelNote(v),
      secondaryHtml: loyaltyCtaHtml(),
      ...manageCta(v),
    });
    const ics = buildIcs(v);
    return {
      subject,
      html,
      ics,
      attachments: [
        {
          filename: 'rezervace.ics',
          content: Buffer.from(ics, 'utf8').toString('base64'),
          content_type: 'text/calendar',
        },
      ],
    };
  },

  buildReminder(v: BookingNotifyView) {
    // Термин может быть и сегодняшним (запись утром на вечер того же дня) —
    // заголовок/текст обязаны это отражать, иначе клиентка придёт не в тот день.
    const rel = dayRelation(v.startsAt);
    const heading =
      rel === 'today'
        ? 'Vidíme se už dnes! 💕'
        : rel === 'tomorrow'
          ? 'Vidíme se už zítra! 💕'
          : 'Připomínka rezervace 💕';
    const when = rel === 'today' ? 'dnešní ' : rel === 'tomorrow' ? 'zítřejší ' : '';
    const subjectPrefix = rel === 'today' ? 'dnes — ' : rel === 'tomorrow' ? 'zítra — ' : '';
    const subject = `Připomínka: ${subjectPrefix}${v.dateLabel} v ${v.time} | Bar.Bitch`;
    const html = renderEmail({
      heading,
      intro: `${esc(v.clientName || 'Dobrý den')}, připomínáme vaši ${when}rezervaci v ${esc(SALON_NAME)}.`,
      rows: bookingRows(v),
      note: cancelNote(v),
      ...manageCta(v),
    });
    return { subject, html };
  },

  buildCancellation(v: BookingNotifyView) {
    const subject = `Rezervace zrušena — ${v.dateLabel} | Bar.Bitch`;
    const html = renderEmail({
      heading: 'Rezervace byla zrušena',
      intro: `${esc(v.clientName || 'Dobrý den')}, vaše rezervace byla zrušena. Budeme se těšit příště!`,
      rows: bookingRows(v),
      ctaLabel: 'REZERVOVAT NOVÝ TERMÍN',
      ctaUrl: `${SITE_URL}/book`,
    });
    return { subject, html };
  },

  buildReschedule(v: BookingNotifyView, fromLabel) {
    const subject = `Změna termínu — nově ${v.dateLabel} v ${v.time} | Bar.Bitch`;
    const origLine = fromLabel ? `Původní termín: <strong style="color:#ffffff;">${esc(fromLabel)}</strong>. ` : '';
    const html = renderEmail({
      heading: 'Změna termínu ✨',
      intro: `${esc(v.clientName || 'Dobrý den')}, váš termín v ${esc(SALON_NAME)} byl přesunut. Aktuální údaje najdete níže, novou pozvánku do kalendáře přikládáme.`,
      rows: bookingRows(v),
      note: `${origLine}${cancelNote(v)}`,
      ...manageCta(v),
    });
    const ics = buildIcs(v);
    return {
      subject,
      html,
      ics,
      attachments: [
        {
          filename: 'rezervace.ics',
          content: Buffer.from(ics, 'utf8').toString('base64'),
          content_type: 'text/calendar',
        },
      ],
    };
  },

  // ── comeback-напоминание «пора записаться снова» (~25 дней после визита) ──
  // Рендер живёт здесь (бренд-канон renderEmail); логику кандидатов/дедупа ведёт
  // сервис api::comeback-reminder.comeback-reminder (cron + ручной триггер).
  // cv = { clientName, serviceTitle, employeeName, lastVisitDate: 'YYYY-MM-DD', bookUrl }

  buildComeback(cv) {
    // полдень UTC — чтобы Intl с TZ Прага не уехал на соседний день
    const lastLabel = cv.lastVisitDate ? czDateLabel(`${cv.lastVisitDate}T12:00:00Z`) : '';
    const subject = 'Čas na další termín? | Bar.Bitch';
    const rows = [
      cv.serviceTitle ? detailRow('Služba', cv.serviceTitle) : '',
      cv.employeeName ? detailRow('Mistrová', cv.employeeName) : '',
      lastLabel ? detailRow('Poslední návštěva', lastLabel) : '',
      detailRow('Adresa', SALON_ADDRESS),
    ].join('');
    const html = renderEmail({
      heading: 'Čas na další návštěvu ✨',
      intro: `${esc(cv.clientName || 'Dobrý den')}, už je to skoro měsíc od vaší poslední návštěvy v ${esc(SALON_NAME)}. Rádi bychom vám připomněli, že možná nastal čas rezervovat si další termín${
        cv.serviceTitle
          ? ` služby <strong style="color:#ffffff;">${esc(cv.serviceTitle)}</strong>`
          : ''
      }.`,
      rows,
      note: 'Toto je jednorázové připomenutí po vaší návštěvě. Pokud si podobná připomenutí nepřejete, odpovězte na tento e-mail slovem <strong style="color:#ffffff;">NEZASÍLAT</strong>.',
      ctaLabel: 'REZERVOVAT TERMÍN',
      ctaUrl: cv.bookUrl || `${SITE_URL}/book`,
    });
    return { subject, html };
  },

  // ── просьба оставить отзыв на Google (через день после визита) ──
  // Рендер живёт здесь (бренд-канон renderEmail); отбор кандидатов/дедуп ведёт
  // сервис api::review-request.review-request (cron + ручной триггер).
  // rv = { clientName, serviceTitle, employeeName, visitDate: 'YYYY-MM-DD', visitCount, reviewUrl }
  //
  // 🟥 Текст намеренно НЕ фильтрует по впечатлению («líbilo se vám?» → только
  // довольных на Google) и ничего не обещает взамен — и то, и другое запрещено
  // политикой Google и грозит сносом всех отзывов профиля.

  buildReviewRequest(rv) {
    // полдень UTC — чтобы Intl с TZ Прага не уехал на соседний день
    const visitLabel = rv.visitDate ? czDateLabel(`${rv.visitDate}T12:00:00Z`) : '';
    const subject = 'Jak se vám u nás líbilo? | Bar.Bitch';
    const rows = [
      rv.serviceTitle ? detailRow('Služba', rv.serviceTitle) : '',
      rv.employeeName ? detailRow('Mistrová', rv.employeeName) : '',
      visitLabel ? detailRow('Návštěva', visitLabel) : '',
    ].join('');
    const html = renderEmail({
      heading: 'Děkujeme za návštěvu 💕',
      intro: `${esc(rv.clientName || 'Dobrý den')}, děkujeme, že se k nám vracíte! Budeme moc rádi, když věnujete minutku a napíšete nám recenzi na Google — pomůže to ostatním holkám vybrat si salon a nám dělá obrovskou radost.`,
      rows,
      // Кто уже оставил отзыв, мы знать не можем (Google не отдаёт связь
      // «отзыв → клиент», а Places API показывает лишь 5 последних под именами
      // Google-аккаунтов). Поэтому случай закрыт текстом, а не фильтром.
      note: 'Napište prosím upřímně, jak to u nás bylo — ceníme si každé zpětné vazby. Pokud jste nám recenzi už napsali, moc děkujeme a tento e-mail prosím ignorujte. Nepřejete-li si podobné e-maily, odpovězte na tento e-mail slovem <strong style="color:#ffffff;">NEZASÍLAT</strong>.',
      ctaLabel: 'NAPSAT RECENZI',
      ctaUrl: rv.reviewUrl,
    });
    return { subject, html };
  },

  // ── личный кабинет клиента: magic-link вход (К1) ──

  buildCabinetLogin(email, url) {
    const subject = 'Přihlášení do Bar.Bitch';
    const html = renderEmail({
      heading: 'Přihlášení do kabinetu ✨',
      intro: `Dobrý den, pro přihlášení do vašeho klientského kabinetu ${esc(SALON_NAME)} klikněte na tlačítko níže.`,
      rows: [detailRow('E-mail', email), detailRow('Platnost odkazu', '15 minut')].join(''),
      note: 'Odkaz platí 15 minut a lze ho použít jen jednou. Pokud jste o přihlášení nežádali, tento e-mail ignorujte.',
      ctaLabel: 'PŘIHLÁSIT SE',
      ctaUrl: url,
    });
    return { subject, html };
  },

  async sendCabinetLogin(email, url) {
    const { subject, html } = this.buildCabinetLogin(email, url);
    return this.sendEmail({ to: email, subject, html });
  },

  // ── события движка (вызываются fire-and-forget) ──

  async notifyBookingCreated(bookingDocId) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);

    const tg =
      `🟢 <b>Nová rezervace</b>${v.isRebook ? ' · 🔁 <b>Dozápis</b>' : ''}\n` +
      this.buildBookingTgBody(v);

    await Promise.allSettled([
      (async () => {
        const { subject, html, attachments } = this.buildConfirmation(v);
        await this.sendEmail({ to: v.clientEmail, subject, html, attachments });
      })(),
      this.sendTelegram(tg),
    ]).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') strapi.log.error(`booking-notify created(${bookingDocId}): ${r.reason?.message || r.reason}`);
      }
    });
  },

  async notifyBookingCancelled(bookingDocId, reason) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);

    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const tg =
      `❌ <b>Klient zrušil rezervaci</b>${v.isRebook ? ' · 🔁 <b>Dozápis</b>' : ''}\n` +
      this.buildBookingTgBody(v) +
      (cleanReason ? `\n📝 <b>Důvod:</b> ${esc(cleanReason)}` : '');

    await Promise.allSettled([
      (async () => {
        const { subject, html } = this.buildCancellation(v);
        await this.sendEmail({ to: v.clientEmail, subject, html });
      })(),
      this.sendTelegram(tg),
    ]).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') strapi.log.error(`booking-notify cancelled(${bookingDocId}): ${r.reason?.message || r.reason}`);
      }
    });
  },

  // ── админские действия (чекбокс «уведомить клиента», роадмап §4.2/4.3) ──
  // Только письмо клиенту, БЕЗ Telegram салону: действие сделал сам админ,
  // дублировать его в салонный чат не нужно.

  async notifyBookingCreatedByAdmin(bookingDocId) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);
    const { subject, html, attachments } = this.buildConfirmation(v);
    await this.sendEmail({ to: v.clientEmail, subject, html, attachments });
  },

  async notifyBookingCancelledByAdmin(bookingDocId) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);
    const { subject, html } = this.buildCancellation(v);
    await this.sendEmail({ to: v.clientEmail, subject, html });
  },

  // Перенос брони админом: письмо клиенту с новыми деталями + ICS.
  // from = снимок старого термина (для строки «Původní termín»).
  // (Уведомление мастеру — отдельная задача, пока не реализовано.)
  async notifyBookingRescheduledByAdmin(bookingDocId, from) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);
    if (!v.clientEmail) return;
    const fromLabel = from
      ? `${from.startsAt ? czDateLabel(from.startsAt) : from.date || ''} v ${from.time || ''}${
          from.employeeName ? ` · ${from.employeeName}` : ''
        }`.trim()
      : '';
    const { subject, html, attachments } = this.buildReschedule(v, fromLabel);
    await this.sendEmail({ to: v.clientEmail, subject, html, attachments });
  },

  // Перенос брони САМИМ клиентом (страница /rezervace/{token}): письмо клиенту
  // с новыми деталями + ICS И Telegram салону — салон должен узнать о переносе
  // (в отличие от админских действий, которые сделал сам салон).
  async notifyBookingRescheduledByClient(bookingDocId, from) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);
    const fromLabel = from
      ? `${from.startsAt ? czDateLabel(from.startsAt) : from.date || ''} v ${from.time || ''}${
          from.employeeName ? ` · ${from.employeeName}` : ''
        }`.trim()
      : '';
    // Короткий старый термин «дд · чч:мм» для строки переноса в Telegram.
    const fromShort = from
      ? `${from.startsAt ? czDateShort(from.startsAt) : from.date || ''} · ${from.time || ''}`.trim()
      : '';

    const tg =
      `🟠 <b>Klient si přesunul rezervaci</b>${v.isRebook ? ' · 🔁 <b>Dozápis</b>' : ''}\n` +
      this.buildBookingTgBody(v, { fromShort });

    await Promise.allSettled([
      (async () => {
        const { subject, html, attachments } = this.buildReschedule(v, fromLabel);
        await this.sendEmail({ to: v.clientEmail, subject, html, attachments });
      })(),
      this.sendTelegram(tg),
    ]).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') strapi.log.error(`booking-notify client-rescheduled(${bookingDocId}): ${r.reason?.message || r.reason}`);
      }
    });
  },

  async loadBooking(bookingDocId) {
    try {
      const booking = await strapi.documents(BOOKING_UID).findOne({
        documentId: bookingDocId,
        populate: {
          employee: { fields: ['name', 'tier'] },
          client: { fields: ['name', 'email', 'phone'] },
        },
      });
      return booking ? (await this.attachRedemptions([booking]))[0] : booking;
    } catch (e) {
      strapi.log.error(`booking-notify loadBooking(${bookingDocId}): ${e.message}`);
      return null;
    }
  },

  // Погашенная награда bitchcard лежит в ОТДЕЛЬНОЙ коллекции redemption — в самой
  // брони от неё только уменьшенный totalPrice. Без этого junior-скидке
  // приписывалась и сумма bitchcard («junior −36 %» вместо −20 % + 158 Kč).
  // Берём ГОТОВУЮ пачечную карту лояльности (bookingDocId → {code, discountKc,
  // rewardTitle}), которой уже пользуется кабинет клиента — один запрос на пачку
  // (крон напоминаний берёт до 500 броней за прогон).
  // Сбой чтения НИКОГДА не роняет нотификацию: без сумм скидок разбивка просто
  // не сойдётся и письмо/TG напечатают один итог, без утверждений о скидках.
  // При выключенном LOYALTY_ENABLED карта пустая — то же безопасное поведение.
  async attachRedemptions(bookings) {
    const ids = (bookings || []).map((b) => b?.documentId).filter(Boolean);
    if (!ids.length) return bookings;
    try {
      const map = (await strapi.service('api::loyalty.loyalty').usedRedemptionsForBookings(ids)) || {};
      for (const b of bookings) {
        const hit = b?.documentId ? map[b.documentId] : null;
        const kc = Number(hit?.discountKc) || 0;
        if (kc > 0) {
          b.__redemptionKc = kc;
          b.__redemptionTitle = hit.rewardTitle || '';
        }
      }
    } catch (e) {
      strapi.log.error(`booking-notify attachRedemptions: ${e.message}`);
    }
    return bookings;
  },

  // ── reminder T−24ч (cron, идемпотентно по remindersSent) ──
  // Только БРОНИ ДВИЖКА (noonaEventId пуст): зеркальным броням reminders шлёт сама
  // Noona до cutover. Свежесозданные (<2ч) скипаются — подтверждение только что пришло.

  async sendReminders() {
    const now = Date.now();
    const windowEnd = new Date(now + 24 * 3600000).toISOString();
    const nowIso = new Date(now).toISOString();

    const candidates = await strapi.documents(BOOKING_UID).findMany({
      filters: {
        status: 'active',
        startsAt: { $gt: nowIso, $lte: windowEnd },
        noonaEventId: { $null: true },
        cancelToken: { $notNull: true },
      },
      populate: {
        // tier обязателен: без него напоминание не покажет junior-скидку, хотя
        // подтверждение той же брони её показало (расхождение в двух письмах).
        employee: { fields: ['name', 'tier'] },
        client: { fields: ['name', 'email', 'phone'] },
      },
      limit: 500,
    });
    await this.attachRedemptions(candidates);

    let sent = 0;
    for (const booking of candidates) {
      const already = Array.isArray(booking.remindersSent) ? booking.remindersSent : [];
      if (already.includes('24h')) continue;
      if (booking.createdAt && now - new Date(booking.createdAt).getTime() < 2 * 3600000) continue;
      // Бронь на СЕГОДНЯ (клиентка записалась на этот же день) — напоминание не шлём:
      // подтверждение она получила только что, а «Vidíme se už zítra» вводило в
      // заблуждение (реальный кейс 12.08.2026 — пришла бы не в тот день).
      // Отметку remindersSent не ставим: бронь всё равно уйдёт из окна сама.
      if (dayRelation(booking.startsAt) === 'today') continue;

      const v = viewFromBookingDoc(booking);
      try {
        if (v.clientEmail) {
          const { subject, html } = this.buildReminder(v);
          await this.sendEmail({ to: v.clientEmail, subject, html });
        }
        // отметка ставится и без e-mail (иначе бронь без адреса перебиралась бы каждый прогон)
        await strapi.documents(BOOKING_UID).update({
          documentId: booking.documentId,
          data: { remindersSent: [...already, '24h'] },
        });
        sent += 1;
      } catch (e) {
        strapi.log.error(`booking-notify reminder(${booking.documentId}): ${e.message}`);
      }
    }
    if (sent > 0 || candidates.length > 0) {
      strapi.log.info(`booking-notify reminders: ${sent} sent / ${candidates.length} candidates`);
    }
    return { sent, candidates: candidates.length };
  },

  // ── превью для ручной проверки (гейт секретом в контроллере) ──

  async preview(type, bookingDocId) {
    // comeback-напоминание не привязано к конкретной брони — фиктивные данные
    if (type === 'comeback') {
      return this.buildComeback({
        clientName: 'Preview Klientka',
        serviceTitle: 'Gel lak manikúra + Design basic',
        employeeName: 'Mistrová',
        lastVisitDate: '2026-07-06',
        bookUrl: `${SITE_URL}/book`,
      });
    }
    // просьба об отзыве не привязана к конкретной брони — фиктивные данные
    if (type === 'review-request') {
      return this.buildReviewRequest({
        clientName: 'Preview Klientka',
        serviceTitle: 'Gel lak manikúra + Design basic',
        employeeName: 'Mistrová',
        visitDate: '2026-08-23',
        visitCount: 3,
        reviewUrl: reviewUrl() || `${SITE_URL}`,
      });
    }
    // cabinet-login не привязан к брони — рендерим с фиктивными данными
    if (type === 'cabinet-login') {
      return this.buildCabinetLogin(
        'preview@example.com',
        `${SITE_URL}/cabinet/verify?token=preview-token`
      );
    }
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return { error: 'booking_not_found' };
    const v = viewFromBookingDoc(booking);
    if (type === 'reminder') return { view: v, ...this.buildReminder(v) };
    if (type === 'cancellation') return { view: v, ...this.buildCancellation(v) };
    if (type === 'reschedule') return { view: v, ...this.buildReschedule(v, '') };
    const { subject, html, ics } = this.buildConfirmation(v);
    return { view: v, subject, html, ics };
  },
};
