// @ts-nocheck
import { requireOwner } from '../../../utils/admin-jwt';

export default {
  async sync(ctx) {
    // Роут auth:false → гейт вручную. До s182 аноним мог жечь квоту Google
    // Places и писать отзывы в БД без авторизации.
    const session = requireOwner(ctx);
    if (!session) return;
    try {
      const result = await strapi.service('api::review-sync.review-sync').syncReviews();
      strapi.log.info(`review-sync by ${session.username}: ${JSON.stringify(result)}`);
      ctx.body = result;
    } catch (err: any) {
      strapi.log.error('Review sync error:', err);
      return ctx.internalServerError(err.message || 'Failed to sync reviews');
    }
  },
};
