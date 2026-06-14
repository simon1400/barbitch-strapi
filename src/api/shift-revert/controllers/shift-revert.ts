// @ts-nocheck

export default {
  async revert(ctx) {
    try {
      const date = ctx.request.body?.date || ctx.query?.date;
      const result = await strapi.service('api::shift-revert.shift-revert').revertShift(date);
      // Admin Axios interceptor unwraps response.data.data → wrap in { data }.
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error('Shift revert error:', err);
      return ctx.badRequest(err.message || 'Failed to revert shift');
    }
  },
};
