// @ts-nocheck

// Ручной триггер синка зеркала: GET/POST /api/booking-mirror/sync?secret=...
// Гейт секретом (env MIRROR_SYNC_SECRET, фолбэк DIGEST_SECRET) — паттерн digest.
// Опционально ?from=ISO&to=ISO — синк произвольного окна событий (customers всегда все).

export default {
  async sync(ctx) {
    const secret = process.env.MIRROR_SYNC_SECRET || process.env.DIGEST_SECRET;
    if (!secret) {
      return ctx.forbidden('MIRROR_SYNC_SECRET is not configured');
    }
    if (ctx.query.secret !== secret) {
      return ctx.forbidden('Invalid secret');
    }
    try {
      const service = strapi.service('api::booking-mirror.booking-mirror');
      const { from, to } = ctx.query;
      if (from && to) {
        const customers = await service.syncCustomers();
        const events = await service.syncEvents(String(from), String(to));
        // salon-hours принимают даты 'YYYY-MM-DD' — берём из from/to (обрезаем время)
        const hours = await service.syncSalonHours(String(from).slice(0, 10), String(to).slice(0, 10));
        ctx.body = { window: { from, to }, customers, events, hours };
        return;
      }
      ctx.body = await service.syncRecent();
    } catch (err) {
      strapi.log.error('booking-mirror sync error:', err);
      return ctx.internalServerError(err.message || 'Mirror sync failed');
    }
  },
};
