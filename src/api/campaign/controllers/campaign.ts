// @ts-nocheck
// Ручка маркетинговых рассылок. Гейт — JWT владельца (тот же admin-jwt, что у
// движка: Strapi-стратегии наш HS256-токен не знают, поэтому роут auth:false
// и проверка делается вручную — паттерн s78/s171).

import { tokenFromCtx, verifySession } from '../../../utils/admin-jwt';
import { CampaignError } from '../services/campaign';

export default {
  // POST /api/campaign/send {template, subject, recipients:[{email,variables}], source?}
  async send(ctx) {
    const session = verifySession(tokenFromCtx(ctx));
    if (!session || session.role !== 'owner') {
      ctx.status = 401;
      ctx.body = {
        error: { status: 401, code: 'owner_only', message: 'Rozesílat kampaně může jen majitel' },
      };
      return;
    }
    try {
      ctx.body = await strapi.service('api::campaign.campaign').send(ctx.request.body || {}, session);
    } catch (e) {
      if (e instanceof CampaignError) {
        ctx.status = e.status;
        ctx.body = { error: { status: e.status, code: e.code, message: e.message } };
        return;
      }
      strapi.log.error('campaign send error:', e);
      ctx.status = 500;
      ctx.body = { error: { status: 500, code: 'internal', message: 'Internal error' } };
    }
  },
};
