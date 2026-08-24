// @ts-nocheck
// Письмо-просьба оставить отзыв на Google — через день после визита, только
// постоянным клиентам (2+ визита). Цель: ровный ручеёк свежих отзывов в GBP.
//
// Механика (сделано по образцу api::comeback-reminder — те же защиты):
//   - окно кандидатов = визит [today−(DELAY+WINDOW−1) .. today−DELAY], по умолчанию
//     вчерашний день + скользящее окно догона (кандидат, не отправленный из-за
//     капа/сбоя, будет подхвачен на следующих прогонах);
//   - «постоянный клиент» = у него ≥ REVIEW_REQUEST_MIN_VISITS завершённых визитов
//     (checkedOut) включая этот. Это НЕ review gating (см. ниже) — фильтр по
//     нейтральному признаку «клиент вернулся», не по его оценке салона;
//   - защиты: нет e-mail / reminderOptOut (клиент ответил NEZASÍLAT) / blacklisted /
//     есть более поздний визит (его подхватит своё окно) / кулдаун по клиенту
//     (REVIEW_REQUEST_COOLDOWN_DAYS, дефолт 365 — практически «просим раз в год») /
//     дневной кап (REVIEW_REQUEST_DAILY_CAP, дефолт 10);
//   - письмо рендерит booking-notify.buildReviewRequest (бренд-канон), отправка через
//     его же sendEmail (гейты RESEND_API_KEY / ENGINE_NOTIFY_DRY);
//   - CTA ведёт прямо на форму отзыва Google (см. reviewUrl ниже).
//
// 🟥 ПОЛИТИКА GOOGLE — почему тут нет «фильтра довольных» и бонусов:
//   Google запрещает review gating (сначала спросить «понравилось?» и отправлять на
//   Google только довольных) и любые вознаграждения за отзыв (скидка, баллы bitchcard).
//   Нарушение = снос всех отзывов профиля. Поэтому письмо уходит ВСЕМ подходящим
//   клиентам без предварительного опроса и ничего не обещает взамен.
//   Дневной кап важен и по второй причине: пачка отзывов за один день выглядит для
//   антиспама Google подозрительно — ровный поток безопаснее.
//
// Гейт крона: REVIEW_REQUEST_ENABLED=true (config/cron-tasks.ts) — без env деплой
// безопасен, ничего не шлётся. Ручной триггер: /api/review-request/run?secret=…&dry=1

const BOOKING_UID = 'api::booking.booking';
const LOG_UID = 'api::review-request-log.review-request-log';

// через сколько дней после визита просить отзыв (1 = на следующий день)
const DELAY_DAYS = Math.max(0, Number(process.env.REVIEW_REQUEST_DELAY_DAYS) || 1);
const WINDOW_DAYS = 5; // ширина скользящего окна догона
const MIN_VISITS = Math.max(1, Number(process.env.REVIEW_REQUEST_MIN_VISITS) || 2);
const DAILY_CAP = Math.max(1, Number(process.env.REVIEW_REQUEST_DAILY_CAP) || 10);
const COOLDOWN_DAYS = Math.max(1, Number(process.env.REVIEW_REQUEST_COOLDOWN_DAYS) || 365);

// Сегодня в Праге как 'YYYY-MM-DD' (сервер в UTC — брать локальную дату нельзя)
const pragueToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());

const shiftDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Прямая ссылка на форму «написать отзыв» в профиле салона.
// REVIEW_LINK_URL перебивает всё (можно подставить короткую ссылку g.page/r/…),
// иначе собирается из GOOGLE_PLACE_ID (тот же, что у review-sync).
// Нет ни того, ни другого → прогон вообще не стартует (см. run).
export const reviewUrl = () => {
  const direct = String(process.env.REVIEW_LINK_URL || '').trim();
  if (direct) return direct;
  const placeId = String(process.env.GOOGLE_PLACE_ID || '').trim();
  if (!placeId) return '';
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
};

export default {
  // dry=true — собрать кандидатов БЕЗ отправки и БЕЗ записи в лог
  async run({ dry = false } = {}) {
    const notify = strapi.service('api::booking-engine.booking-notify');
    const url = reviewUrl();
    if (!url) {
      strapi.log.warn('review-request: ни REVIEW_LINK_URL, ни GOOGLE_PLACE_ID не заданы — skip');
      return { skipped: 'no_review_url', candidates: 0, queued: 0, sent: 0 };
    }

    const today = pragueToday();
    const windowTo = shiftDays(today, -DELAY_DAYS);
    const windowFrom = shiftDays(today, -(DELAY_DAYS + WINDOW_DAYS - 1));

    const visits = await strapi.documents(BOOKING_UID).findMany({
      filters: { status: 'checkedOut', date: { $gte: windowFrom, $lte: windowTo } },
      populate: {
        client: { fields: ['name', 'email', 'reminderOptOut', 'blacklisted'] },
        employee: { fields: ['name'] },
      },
      fields: ['date', 'services', 'employeeNameRaw'],
      limit: 1000,
    });

    // последний визит окна per клиент (у клиента с двумя визитами в окне — поздний)
    const byClient = new Map();
    for (const b of visits) {
      if (!b.client?.documentId) continue;
      const prev = byClient.get(b.client.documentId);
      if (!prev || String(b.date) > String(prev.date)) byClient.set(b.client.documentId, b);
    }

    // лог по всем кандидатам одним запросом: кулдаун по клиенту
    const ids = [...byClient.keys()];
    const logs = ids.length
      ? await strapi.documents(LOG_UID).findMany({
          filters: { clientDocId: { $in: ids } },
          fields: ['clientDocId', 'sentAt'],
          limit: 2000,
        })
      : [];
    const cooldownFloor = Date.now() - COOLDOWN_DAYS * 86400000;
    const recentlyAsked = new Set(
      logs
        .filter((l) => !l.sentAt || new Date(l.sentAt).getTime() > cooldownFloor)
        .map((l) => l.clientDocId)
    );

    const skipped = { noEmail: 0, optOut: 0, blacklisted: 0, hasLater: 0, cooldown: 0, tooFewVisits: 0 };
    const toSend = [];

    for (const [clientDocId, booking] of byClient) {
      const c = booking.client;
      const email = String(c.email || '').trim();
      if (!email || !email.includes('@')) { skipped.noEmail += 1; continue; }
      if (c.reminderOptOut) { skipped.optOut += 1; continue; }
      if (c.blacklisted) { skipped.blacklisted += 1; continue; }
      if (recentlyAsked.has(clientDocId)) { skipped.cooldown += 1; continue; }

      // Есть визит ПОЗЖЕ этого? Тогда просим по нему — его подхватит своё окно
      // (иначе письмо ссылалось бы на устаревший визит).
      const later = await strapi.documents(BOOKING_UID).count({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          status: 'checkedOut',
          date: { $gt: String(booking.date) },
        },
      });
      if (later > 0) { skipped.hasLater += 1; continue; }

      // «Постоянный клиент»: сколько завершённых визитов всего (включая этот).
      // Первый визит пропускаем — просить отзыв после одного раза рано, да и
      // конверсия ниже; вернувшийся клиент пишет охотнее.
      const visitCount = await strapi.documents(BOOKING_UID).count({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          status: 'checkedOut',
          date: { $lte: String(booking.date) },
        },
      });
      if (visitCount < MIN_VISITS) { skipped.tooFewVisits += 1; continue; }

      toSend.push({ clientDocId, booking, visitCount });
      if (toSend.length >= DAILY_CAP) break;
    }

    let sent = 0;
    const errors = [];
    const preview = [];
    for (const { clientDocId, booking, visitCount } of toSend) {
      const c = booking.client;
      const services = Array.isArray(booking.services) ? booking.services : [];
      const serviceTitle = services.map((s) => s?.title).filter(Boolean).join(', ');
      const employeeName = booking.employee?.name || booking.employeeNameRaw || '';
      const view = {
        clientName: c.name || '',
        serviceTitle,
        employeeName,
        visitDate: String(booking.date),
        visitCount,
        reviewUrl: url,
      };
      if (dry) {
        preview.push({ email: c.email, ...view });
        continue;
      }
      try {
        const { subject, html } = notify.buildReviewRequest(view);
        const res = await notify.sendEmail({ to: c.email, subject, html });
        // без RESEND-ключа / в DRY-режиме лог НЕ пишем — отправится следующим прогоном
        if (res?.skipped || res?.dry) continue;
        await strapi.documents(LOG_UID).create({
          data: {
            clientDocId,
            clientName: c.name || '',
            email: c.email,
            visitDate: String(booking.date),
            visitCount,
            serviceTitle,
            employeeName,
            bookingDocId: booking.documentId,
            sentAt: new Date().toISOString(),
          },
        });
        sent += 1;
      } catch (e) {
        errors.push(`${c.email}: ${e.message}`);
        strapi.log.error(`review-request send(${clientDocId}): ${e.message}`);
      }
    }

    const summary = {
      window: { from: windowFrom, to: windowTo },
      minVisits: MIN_VISITS,
      dailyCap: DAILY_CAP,
      candidates: byClient.size,
      queued: toSend.length,
      sent,
      skipped,
      errors,
    };
    if (byClient.size > 0 || sent > 0) {
      strapi.log.info(
        `review-request: sent ${sent}/${toSend.length} (candidates ${byClient.size}, window ${windowFrom}..${windowTo})`
      );
    }
    return dry ? { ...summary, dry: true, reviewUrl: url, preview } : summary;
  },
};
