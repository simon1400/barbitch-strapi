// @ts-nocheck

export default {
  async check(ctx) {
    try {
      const date = ctx.query?.date;
      const result = await strapi
        .service('api::shift-selfcheck.shift-selfcheck')
        .runSelfCheck(date);
      // Strapi admin useFetchClient НЕ разворачивает .data.data → отдаём объект как есть.
      ctx.body = result;
    } catch (err: any) {
      strapi.log.error('Shift self-check error:', err);
      return ctx.badRequest(err.message || 'Failed to run shift self-check');
    }
  },
};
