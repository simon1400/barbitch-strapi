// @ts-nocheck

// Ручной триггер comeback-напоминаний: GET/POST /api/comeback-reminder/run?secret=...
// Гейт секретом (env DIGEST_SECRET — тот же, что у дайджеста/лояльности).
// ?dry=1 — вернуть кандидатов и ссылки БЕЗ отправки писем и записи в лог.

export default {
  async run(ctx) {
    const secret = process.env.DIGEST_SECRET;
    if (!secret) {
      return ctx.forbidden('DIGEST_SECRET is not configured');
    }
    if (ctx.query.secret !== secret) {
      return ctx.forbidden('Invalid secret');
    }
    try {
      const result = await strapi
        .service('api::comeback-reminder.comeback-reminder')
        .run({ dry: Boolean(ctx.query.dry) });
      ctx.body = result;
    } catch (err) {
      strapi.log.error('comeback-reminder run error:', err);
      return ctx.internalServerError(err.message || 'Failed to run comeback reminders');
    }
  },
};
