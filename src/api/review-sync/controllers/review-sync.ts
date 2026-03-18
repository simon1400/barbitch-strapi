// @ts-nocheck

export default {
  async sync(ctx) {
    try {
      const result = await strapi.service('api::review-sync.review-sync').syncReviews();
      ctx.body = result;
    } catch (err: any) {
      strapi.log.error('Review sync error:', err);
      return ctx.internalServerError(err.message || 'Failed to sync reviews');
    }
  },
};
