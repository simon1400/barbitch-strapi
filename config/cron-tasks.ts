// Cron-задачи Strapi. Подключаются в config/server.ts (cron.tasks).
// Дайджест шлётся только если заданы env TELEGRAM_DIGEST_BOT_TOKEN/CHAT_ID
// и NOONA_TOKEN/NOONA_COMPANY_ID — иначе тихий skip (см. сервис digest).

export default {
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
