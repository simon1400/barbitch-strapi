// @ts-nocheck
// Автонапоминание «пора записаться снова»: письмо клиенту через ~25 дней после
// последнего визита (checkedOut-брони), если он ещё не записан на будущее.
// Аналог напоминалок Alteg.io у барберов; решение владельца s155 — полный автомат,
// без скидки, всем клиентам с e-mail.
//
// Механика:
//   - окно кандидатов = последний визит [today−31 .. today−25] (скользящее 7 дней —
//     кандидат, не отправленный сегодня из-за капа/сбоя, будет подхвачен завтра);
//   - защиты: нет будущей активной брони, нет более позднего визита, дедуп по
//     (clientDocId + lastVisitDate) в comeback-reminder-log, кулдаун 20 дней,
//     reminderOptOut (клиент ответил NEZASÍLAT — галка в Strapi CM), blacklisted,
//     дневной кап (COMEBACK_REMINDER_DAILY_CAP, дефолт 60);
//   - письмо рендерит booking-notify.buildComeback (бренд-канон), отправка через
//     его же sendEmail (гейты RESEND_API_KEY / ENGINE_NOTIFY_DRY);
//   - CTA ведёт на повторную запись ТОЙ ЖЕ услуги: /book/{serviceDocId}?v=&m=
//     (селекция из снапшота брони, формат selectionToQuery клиента); услуга
//     снята с онлайн-записи или снапшот без serviceDocId (зеркальные Noona-брони)
//     → фолбэк на /book.
//
// Гейт крона: COMEBACK_REMINDER_ENABLED=true (config/cron-tasks.ts) — без env
// деплой безопасен, ничего не шлётся. Ручной триггер: /api/comeback-reminder/run.

const BOOKING_UID = 'api::booking.booking';
const LOG_UID = 'api::comeback-reminder-log.comeback-reminder-log';
const SALON_SERVICE_UID = 'api::salon-service.salon-service';

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://barbitch.cz';
// через сколько дней после визита напоминать (владелец: «через 3–4 недели»)
const DAYS_AFTER = Math.max(1, Number(process.env.COMEBACK_REMINDER_DAYS) || 25);
const WINDOW_DAYS = 7; // ширина скользящего окна догона
const DAILY_CAP = Math.max(1, Number(process.env.COMEBACK_REMINDER_DAILY_CAP) || 60);
const COOLDOWN_DAYS = 20; // не слать одному клиенту чаще, чем раз в N дней

// Сегодня в Праге как 'YYYY-MM-DD' (сервер в UTC — брать локальную дату нельзя)
const pragueToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());

const shiftDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default {
  // dry=true — собрать кандидатов и ссылки БЕЗ отправки и БЕЗ записи в лог
  async run({ dry = false } = {}) {
    const notify = strapi.service('api::booking-engine.booking-notify');
    const today = pragueToday();
    const windowTo = shiftDays(today, -DAYS_AFTER);
    const windowFrom = shiftDays(today, -(DAYS_AFTER + WINDOW_DAYS - 1));

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

    // лог по всем кандидатам одним запросом: дедуп по паре + кулдаун по клиенту
    const ids = [...byClient.keys()];
    const logs = ids.length
      ? await strapi.documents(LOG_UID).findMany({
          filters: { clientDocId: { $in: ids } },
          fields: ['clientDocId', 'lastVisitDate', 'sentAt'],
          limit: 2000,
        })
      : [];
    const sentPairs = new Set(logs.map((l) => `${l.clientDocId}|${l.lastVisitDate}`));
    const cooldownFloor = Date.now() - COOLDOWN_DAYS * 86400000;
    const recentlySent = new Set(
      logs
        .filter((l) => l.sentAt && new Date(l.sentAt).getTime() > cooldownFloor)
        .map((l) => l.clientDocId)
    );

    const skipped = { noEmail: 0, optOut: 0, blacklisted: 0, hasLater: 0, dedup: 0, cooldown: 0 };
    const toSend = [];

    for (const [clientDocId, booking] of byClient) {
      const c = booking.client;
      const email = String(c.email || '').trim();
      if (!email || !email.includes('@')) { skipped.noEmail += 1; continue; }
      if (c.reminderOptOut) { skipped.optOut += 1; continue; }
      if (c.blacklisted) { skipped.blacklisted += 1; continue; }
      if (sentPairs.has(`${clientDocId}|${booking.date}`)) { skipped.dedup += 1; continue; }
      if (recentlySent.has(clientDocId)) { skipped.cooldown += 1; continue; }

      // визит окна — реально ПОСЛЕДНИЙ? и нет ли уже будущей активной брони.
      // Поздние noshow/cancelled не блокируют (услугу клиент не получил);
      // застрявшие в active прошлые брони (артефакт Noona-эры) игнорируются date>=today.
      const later = await strapi.documents(BOOKING_UID).count({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          $or: [
            { status: 'checkedOut', date: { $gt: String(booking.date) } },
            { status: 'active', date: { $gte: today } },
          ],
        },
      });
      if (later > 0) { skipped.hasLater += 1; continue; }

      toSend.push({ clientDocId, booking });
      if (toSend.length >= DAILY_CAP) break;
    }

    let sent = 0;
    const errors = [];
    const preview = [];
    for (const { clientDocId, booking } of toSend) {
      const c = booking.client;
      const services = Array.isArray(booking.services) ? booking.services : [];
      const serviceTitle = services.map((s) => s?.title).filter(Boolean).join(', ');
      const view = {
        clientName: c.name || '',
        serviceTitle,
        employeeName: booking.employee?.name || booking.employeeNameRaw || '',
        lastVisitDate: String(booking.date),
        bookUrl: await this._bookUrl(services[0]),
      };
      if (dry) {
        preview.push({ email: c.email, ...view });
        continue;
      }
      try {
        const { subject, html } = notify.buildComeback(view);
        const res = await notify.sendEmail({ to: c.email, subject, html });
        // без RESEND-ключа / в DRY-режиме лог НЕ пишем — отправится следующим прогоном
        if (res?.skipped || res?.dry) continue;
        await strapi.documents(LOG_UID).create({
          data: {
            clientDocId,
            clientName: c.name || '',
            email: c.email,
            lastVisitDate: String(booking.date),
            serviceTitle,
            serviceDocId: services[0]?.serviceDocId || null,
            bookingDocId: booking.documentId,
            sentAt: new Date().toISOString(),
          },
        });
        sent += 1;
      } catch (e) {
        errors.push(`${c.email}: ${e.message}`);
        strapi.log.error(`comeback-reminder send(${clientDocId}): ${e.message}`);
      }
    }

    const summary = {
      window: { from: windowFrom, to: windowTo },
      candidates: byClient.size,
      queued: toSend.length,
      sent,
      skipped,
      errors,
    };
    if (byClient.size > 0 || sent > 0) {
      strapi.log.info(
        `comeback-reminder: sent ${sent}/${toSend.length} (candidates ${byClient.size}, window ${windowFrom}..${windowTo})`
      );
    }
    return dry ? { ...summary, dry: true, preview } : summary;
  },

  // Deep-link повторной записи той же услуги (формат client selectionToQuery:
  // ?v=<variant label>&m=<modifier keys через запятую>). Услуга должна существовать,
  // быть active и onlineBookable — иначе общий /book.
  async _bookUrl(svc) {
    const docId = svc?.serviceDocId;
    if (!docId) return `${SITE_URL}/book`;
    try {
      const s = await strapi.documents(SALON_SERVICE_UID).findOne({
        documentId: docId,
        status: 'published',
        fields: ['active', 'onlineBookable'],
      });
      if (!s || s.active === false || s.onlineBookable === false) return `${SITE_URL}/book`;
    } catch {
      return `${SITE_URL}/book`;
    }
    const qs = new URLSearchParams();
    if (svc.variant) qs.set('v', svc.variant);
    if (Array.isArray(svc.modifiers) && svc.modifiers.length) qs.set('m', svc.modifiers.join(','));
    const q = qs.toString();
    return `${SITE_URL}/book/${docId}${q ? `?${q}` : ''}`;
  },
};
