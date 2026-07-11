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
