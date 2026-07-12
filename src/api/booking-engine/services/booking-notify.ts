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

export interface BookingNotifyView {
  bookingId: string;
  dateLabel: string; // «neděle 12. 7. 2026»
  time: string; // «14:00»
  startsAt: string;
  endsAt: string;
  serviceTitle: string;
  employeeName: string;
  price: number | null;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  cancelUrl: string;
}

const viewFromBookingDoc = (booking): BookingNotifyView => {
  const svc = Array.isArray(booking.services) ? booking.services[0] : null;
  return {
    bookingId: booking.documentId,
    dateLabel: booking.startsAt ? czDateLabel(booking.startsAt) : String(booking.date),
    time: booking.startsAt
      ? minToHHMM(utcToPragueMinClamped(booking.startsAt, String(booking.date)))
      : '',
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    serviceTitle: svc?.title || '',
    employeeName: booking.employee?.name || booking.employeeNameRaw || '',
    price: booking.totalPrice != null ? Number(booking.totalPrice) : null,
    clientName: booking.client?.name || booking.clientNameRaw || '',
    clientEmail: booking.client?.email || '',
    clientPhone: booking.client?.phone || '',
    cancelUrl: booking.cancelToken ? `${SITE_URL}/rezervace/zrusit/${booking.cancelToken}` : '',
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
      `Mistrová: ${v.employeeName}${v.price != null ? `\nCena: ${v.price} Kč` : ''}${v.cancelUrl ? `\nZrušení rezervace: ${v.cancelUrl}` : ''}`
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

const bookingRows = (v: BookingNotifyView) =>
  [
    detailRow('Datum', `${v.dateLabel} v ${v.time}`),
    detailRow('Služba', v.serviceTitle),
    detailRow('Mistrová', v.employeeName),
    v.price != null ? detailRow('Cena', `${v.price} Kč (platba na pobočce)`) : '',
    detailRow('Adresa', SALON_ADDRESS),
  ].join('');

const cancelNote = (v: BookingNotifyView) =>
  `Rezervaci lze zrušit nejpozději ${CANCEL_MIN_HOURS} hodiny předem${
    v.cancelUrl
      ? ` — <a href="${v.cancelUrl}" style="color:#e71e6e;">zrušit rezervaci zde</a>`
      : ''
  }. Poté prosím volejte do salonu.`;

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

  // ── сборка писем (используется и превью-ручкой) ──

  buildConfirmation(v: BookingNotifyView) {
    const subject = `Rezervace potvrzena — ${v.dateLabel} v ${v.time} | Bar.Bitch`;
    const html = renderEmail({
      heading: 'Rezervace potvrzena ✨',
      intro: `${esc(v.clientName || 'Dobrý den')}, těšíme se na vás v ${esc(SALON_NAME)}! Detaily vaší návštěvy najdete níže, pozvánku do kalendáře přikládáme.`,
      rows: bookingRows(v),
      note: cancelNote(v),
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
    const subject = `Připomínka: ${v.dateLabel} v ${v.time} | Bar.Bitch`;
    const html = renderEmail({
      heading: 'Vidíme se už zítra! 💕',
      intro: `${esc(v.clientName || 'Dobrý den')}, připomínáme vaši rezervaci v ${esc(SALON_NAME)}.`,
      rows: bookingRows(v),
      note: cancelNote(v),
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

  // ── события движка (вызываются fire-and-forget) ──

  async notifyBookingCreated(bookingDocId) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);

    const tg =
      `🆕 <b>Nová rezervace z webu</b>\n` +
      `${v.dateLabel} v <b>${v.time}</b> · ${v.employeeName}\n` +
      `${v.serviceTitle}${v.price != null ? ` · ${v.price} Kč` : ''}\n` +
      `Klient: <b>${v.clientName}</b>${v.clientPhone ? ` · <code>${v.clientPhone}</code>` : ''}`;

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

  async notifyBookingCancelled(bookingDocId) {
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return;
    const v = viewFromBookingDoc(booking);

    const tg =
      `❌ <b>Klient zrušil rezervaci</b>\n` +
      `${v.dateLabel} v <b>${v.time}</b> · ${v.employeeName}\n` +
      `${v.serviceTitle}${v.price != null ? ` · ${v.price} Kč` : ''}\n` +
      `Klient: <b>${v.clientName}</b>${v.clientPhone ? ` · <code>${v.clientPhone}</code>` : ''}`;

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

  async loadBooking(bookingDocId) {
    try {
      return await strapi.documents(BOOKING_UID).findOne({
        documentId: bookingDocId,
        populate: {
          employee: { fields: ['name'] },
          client: { fields: ['name', 'email', 'phone'] },
        },
      });
    } catch (e) {
      strapi.log.error(`booking-notify loadBooking(${bookingDocId}): ${e.message}`);
      return null;
    }
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
        employee: { fields: ['name'] },
        client: { fields: ['name', 'email', 'phone'] },
      },
      limit: 500,
    });

    let sent = 0;
    for (const booking of candidates) {
      const already = Array.isArray(booking.remindersSent) ? booking.remindersSent : [];
      if (already.includes('24h')) continue;
      if (booking.createdAt && now - new Date(booking.createdAt).getTime() < 2 * 3600000) continue;

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
    const booking = await this.loadBooking(bookingDocId);
    if (!booking) return { error: 'booking_not_found' };
    const v = viewFromBookingDoc(booking);
    if (type === 'reminder') return { view: v, ...this.buildReminder(v) };
    if (type === 'cancellation') return { view: v, ...this.buildCancellation(v) };
    const { subject, html, ics } = this.buildConfirmation(v);
    return { view: v, subject, html, ics };
  },
};
