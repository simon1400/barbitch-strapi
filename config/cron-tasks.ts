// Cron-задачи Strapi. Подключаются в config/server.ts (cron.tasks).
// Дайджест шлётся только если заданы env TELEGRAM_DIGEST_BOT_TOKEN/CHAT_ID
// и NOONA_TOKEN/NOONA_COMPANY_ID — иначе тихий skip (см. сервис digest).

export default {
  // Синк-зеркало Noona → client/booking (own-booking фаза 1). Выключен по умолчанию:
  // включается ТОЛЬКО env MIRROR_SYNC_ENABLED=true (+ NOONA_TOKEN/NOONA_COMPANY_ID).
  // На проде без явного включения не запустится.
  mirrorSync: {
    task: async ({ strapi }) => {
      if (process.env.MIRROR_SYNC_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-mirror.booking-mirror').syncRecent();
      } catch (e) {
        strapi.log.error(`booking-mirror cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '*/10 * * * *', // каждые 10 минут
      tz: 'Europe/Prague',
    },
  },
  // Чистка протухших слот-холдов движка бронирования (own-booking). Безвредна
  // везде: до появления таблицы slot_holds сервис тихо возвращает 0.
  engineHoldsCleanup: {
    task: async ({ strapi }) => {
      try {
        await strapi.service('api::booking-engine.booking-engine').cleanupHolds();
      } catch (e) {
        strapi.log.error(`engine holds cleanup cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '* * * * *', // каждую минуту
      tz: 'Europe/Prague',
    },
  },
  // Reminder T−24ч по броням ДВИЖКА (own-booking шаг 6). Выключен по умолчанию:
  // включается ТОЛЬКО env ENGINE_REMINDERS_ENABLED=true (+ RESEND_API_KEY для писем).
  // Идемпотентен (отметка remindersSent), зеркальные Noona-брони не трогает.
  engineReminders: {
    task: async ({ strapi }) => {
      if (process.env.ENGINE_REMINDERS_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-engine.booking-notify').sendReminders();
      } catch (e) {
        strapi.log.error(`engine reminders cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '*/15 * * * *', // каждые 15 минут
      tz: 'Europe/Prague',
    },
  },
  // Лояльность bitchcard (К3): начисление копилки по checkedOut-броням окна
  // последних дней (идемпотентно по bookingDocId) + авто-награды при пересечении
  // порогов + expire-проход. Выключено по умолчанию: ТОЛЬКО env LOYALTY_ENABLED=true.
  loyaltyDaily: {
    task: async ({ strapi }) => {
      if (process.env.LOYALTY_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::loyalty.loyalty').runDaily();
        strapi.log.info(
          `loyalty daily: +${res.created} tx (${res.skipped} skip), redemptions +${res.redemptionsCreated}, expired ${res.expired}`
        );
      } catch (e) {
        strapi.log.error(`loyalty daily cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '30 4 * * *', // каждый день в 04:30 (после закрытия смены, до дайджеста)
      tz: 'Europe/Prague',
    },
  },
  dailyDigest: {
    task: async ({ strapi }) => {
      try {
        await strapi.service('api::digest.digest').sendDigest();
      } catch (e) {
        strapi.log.error(`daily digest cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 8 * * *', // каждый день в 08:00
      tz: 'Europe/Prague',
    },
  },
};
