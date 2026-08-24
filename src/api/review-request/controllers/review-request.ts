// @ts-nocheck

// Ручной триггер писем-просьб об отзыве: GET/POST /api/review-request/run?secret=...
// Гейт секретом (env DIGEST_SECRET — тот же, что у дайджеста/лояльности/comeback).
// ?dry=1 — вернуть кандидатов БЕЗ отправки писем и записи в лог.

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
        .service('api::review-request.review-request')
        .run({ dry: Boolean(ctx.query.dry) });
      ctx.body = result;
    } catch (err) {
      strapi.log.error('review-request run error:', err);
      return ctx.internalServerError(err.message || 'Failed to run review requests');
    }
  },
};
