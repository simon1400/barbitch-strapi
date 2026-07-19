// @ts-nocheck

// Ручной триггер лояльности: POST/GET /api/loyalty/run?secret=...&mode=daily|backfill|expire
// Защита секретом (env DIGEST_SECRET — паттерн digest). Без LOYALTY_ENABLED → 503.
//   mode=daily (дефолт) — начисление окна последних дней + expire-проход
//   mode=backfill&year=2026 — бэкфил карточного года (старт программы, решение (в))
//   mode=expire — только expire-проход

export default {
  async run(ctx) {
    const secret = process.env.DIGEST_SECRET;
    if (!secret) {
      return ctx.forbidden('DIGEST_SECRET is not configured');
    }
    if (ctx.query.secret !== secret) {
      return ctx.forbidden('Invalid secret');
    }
    const svc = strapi.service('api::loyalty.loyalty');
    try {
      svc.assertEnabled();
      const mode = String(ctx.query.mode || 'daily');
      if (mode === 'backfill') {
        ctx.body = await svc.backfillYear(Number(ctx.query.year));
        return;
      }
      if (mode === 'expire') {
        ctx.body = await svc.expirePass();
        return;
      }
      ctx.body = await svc.runDaily();
    } catch (e) {
      if (typeof e?.status === 'number' && typeof e?.code === 'string') {
        ctx.status = e.status;
        ctx.body = { error: { status: e.status, code: e.code, message: e.message } };
        return;
      }
      strapi.log.error('loyalty run error:', e);
      return ctx.internalServerError(e.message || 'Loyalty run failed');
    }
  },
};
