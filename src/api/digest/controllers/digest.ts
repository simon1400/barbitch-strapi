// @ts-nocheck

// Ручной триггер дайджеста: POST/GET /api/digest/send?secret=...
// Защита простым секретом (env DIGEST_SECRET) — без него endpoint отключён,
// чтобы никто не мог спамить владельцу в Telegram.

export default {
  async send(ctx) {
    const secret = process.env.DIGEST_SECRET;
    if (!secret) {
      return ctx.forbidden('DIGEST_SECRET is not configured');
    }
    if (ctx.query.secret !== secret) {
      return ctx.forbidden('Invalid secret');
    }
    try {
      const result = await strapi.service('api::digest.digest').sendDigest();
      ctx.body = result;
    } catch (err) {
      strapi.log.error('digest send error:', err);
      return ctx.internalServerError(err.message || 'Failed to send digest');
    }
  },
};
