// @ts-nocheck
import { requireManagement } from '../../../utils/admin-jwt';

export default {
  async revert(ctx) {
    // Роут auth:false (users-permissions не знает наш HS256) → гейт вручную.
    // До s182 откатить закрытую смену мог любой аноним по дате.
    const session = requireManagement(ctx);
    if (!session) return;
    try {
      const date = ctx.request.body?.date || ctx.query?.date;
      const result = await strapi.service('api::shift-revert.shift-revert').revertShift(date);
      strapi.log.info(`shift-revert ${date} by ${session.username}`);
      // Admin Axios interceptor unwraps response.data.data → wrap in { data }.
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error('Shift revert error:', err);
      return ctx.badRequest(err.message || 'Failed to revert shift');
    }
  },
};
