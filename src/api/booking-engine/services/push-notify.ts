// @ts-nocheck
// Web Push уведомления мастерам (PWA admin-календарь): когда к КОНКРЕТНОМУ мастеру
// создают/переносят/отменяют бронь — пуш на его телефон с инфой о клиенте/услуге/времени.
//
// Гейт (безопасно всегда): работает ТОЛЬКО при заданных VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY
// (иначе тихий skip). Вызовы из движка — fire-and-forget, сбой пуша не роняет бронь.
// Подписки хранятся в коллекции push-subscription (endpoint + p256dh/auth + personal).
//
// iOS: Web Push приходит ТОЛЬКО в УСТАНОВЛЕННОМ PWA (Přidat na plochu), iOS 16.4+.

import webpush from 'web-push';

import { minToHHMM, utcToPragueMinClamped } from './slots-core';

const SUB_UID = 'api::push-subscription.push-subscription';
const BOOKING_UID = 'api::booking.booking';

let vapidReady = false;
const ensureVapid = () => {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@barbitch.cz', pub, priv);
    vapidReady = true;
  }
  return true;
};

const czDate = (iso, date) =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
  }).format(new Date(iso || `${date}T12:00:00Z`));

const KIND_META = {
  new: { title: '🟢 Nová rezervace' },
  reschedule: { title: '🟠 Změna termínu' },
  cancel: { title: '❌ Zrušená rezervace' },
};

export default {
  vapidPublicKey() {
    return process.env.VAPID_PUBLIC_KEY || null;
  },

  // upsert подписки устройства по endpoint (одно устройство = одна строка)
  async subscribe({ personalDocId, employeeName, subscription, userAgent }) {
    if (!subscription?.endpoint) throw new Error('subscription.endpoint required');
    const existing = await strapi
      .documents(SUB_UID)
      .findMany({ filters: { endpoint: subscription.endpoint }, limit: 1 });
    const data = {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys?.p256dh || '',
      auth: subscription.keys?.auth || '',
      employeeName: employeeName || '',
      userAgent: userAgent || '',
      ...(personalDocId ? { personal: personalDocId } : {}),
    };
    if (existing[0]) {
      await strapi.documents(SUB_UID).update({ documentId: existing[0].documentId, data });
      return { updated: true };
    }
    await strapi.documents(SUB_UID).create({ data });
    return { created: true };
  },

  async unsubscribe(endpoint) {
    const rows = await strapi.documents(SUB_UID).findMany({ filters: { endpoint }, limit: 10 });
    for (const s of rows) await strapi.documents(SUB_UID).delete({ documentId: s.documentId });
    return { deleted: rows.length };
  },

  async _subsFor(personalDocId, employeeName) {
    if (personalDocId) {
      const byRel = await strapi
        .documents(SUB_UID)
        .findMany({ filters: { personal: { documentId: personalDocId } }, limit: 50 });
      if (byRel.length) return byRel;
    }
    if (employeeName) {
      return strapi.documents(SUB_UID).findMany({ filters: { employeeName }, limit: 50 });
    }
    return [];
  },

  // отправить пуш всем устройствам мастера; мёртвые подписки (404/410) чистим
  async _send(subs, payload) {
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body
          );
          sent++;
        } catch (e) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await strapi.documents(SUB_UID).delete({ documentId: s.documentId }).catch(() => {});
          } else {
            strapi.log.error(`push-notify send failed (${e?.statusCode}): ${e?.message}`);
          }
        }
      })
    );
    return sent;
  },

  // Главная точка входа из движка: уведомить мастера брони о событии (kind).
  // extra.from = снимок СТАРОГО термина при переносе ({startsAt, date, time}) —
  // бронь на момент пуша уже перезаписана, старое время можно получить только снаружи.
  async notifyBookingEvent(bookingDocId, kind, extra = {}) {
    if (!ensureVapid()) return { skipped: 'no_vapid' };
    const meta = KIND_META[kind];
    if (!meta) return { skipped: 'bad_kind' };
    const booking = await strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      populate: { employee: { fields: ['documentId', 'name'] } },
    });
    if (!booking) return { skipped: 'no_booking' };

    const personalDocId = booking.employee?.documentId || booking.engineEmployeeId || null;
    const employeeName = booking.employee?.name || booking.employeeNameRaw || '';
    const subs = await this._subsFor(personalDocId, employeeName);
    if (!subs.length) return { sent: 0 };

    const time = booking.startsAt
      ? minToHHMM(utcToPragueMinClamped(booking.startsAt, String(booking.date)))
      : '';
    const services = Array.isArray(booking.services) ? booking.services : [];
    const svcTitle = services.map((s) => s?.title).filter(Boolean).join(', ');
    const client = booking.clientNameRaw || booking.client?.name || 'Klient';
    // Формат по решению владельца (s118): термин в заголовке, тело = клиент и услуги
    // отдельными строками — чтобы пуш влезал в ~4 строки закрытого экрана iOS.
    const when = `${czDate(booking.startsAt, booking.date)}${time ? ` v ${time}` : ''}`;
    const bodyLines = [client, svcTitle].filter(Boolean);
    // перенос: первой строкой «откуда → куда»; если день тот же — только времена
    if (kind === 'reschedule' && extra?.from?.time) {
      const sameDate = String(extra.from.date) === String(booking.date);
      const oldPart = sameDate
        ? extra.from.time
        : `${czDate(extra.from.startsAt, extra.from.date)} ${extra.from.time}`;
      const newPart = sameDate ? time : when;
      bodyLines.unshift(`${oldPart} → ${newPart}`);
    }

    const sent = await this._send(subs, {
      title: `${meta.title} - ${when}`,
      body: bodyLines.join('\n'),
      // клик по пушу → календарь сразу на дне брони + подсветка её карточки
      url: `/calendar?date=${booking.date}&highlight=${bookingDocId}`,
      tag: `booking-${bookingDocId}`,
    });
    return { sent };
  },
};
