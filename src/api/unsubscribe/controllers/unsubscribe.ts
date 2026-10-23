// @ts-nocheck
// Отписка по ссылке из письма (s271). Логика и правила — services/unsubscribe.ts.

import { originOf } from '../../../utils/unsubscribe-token';

const svc = () => strapi.service('api::unsubscribe.unsubscribe');

const fail = (ctx, status, code) => {
  ctx.status = status;
  ctx.body = { error: { status, code } };
};

const handle = async (ctx, fn) => {
  try {
    ctx.body = await fn();
  } catch (e) {
    if (e?.status && e?.code) return fail(ctx, e.status, e.code);
    strapi.log.error(`unsubscribe: ${e?.message || e}`);
    return fail(ctx, 500, 'server_error');
  }
};

export default {
  async info(ctx) {
    await handle(ctx, () => svc().info(ctx.params.token));
  },

  async change(ctx) {
    const body = ctx.request.body || {};
    const origin = originOf(ctx.query.z);
    // RFC 8058: почтовик шлёт POST application/x-www-form-urlencoded
    // с телом «List-Unsubscribe=One-Click» — без людей, без JS, без cookies.
    if (body['List-Unsubscribe'] === 'One-Click') {
      return handle(ctx, () => svc().unsubscribe(ctx.params.token, { via: 'one_click', origin }));
    }
    if (body.action === 'unsubscribe') {
      return handle(ctx, () => svc().unsubscribe(ctx.params.token, { via: 'link', origin }));
    }
    if (body.action === 'resubscribe') {
      return handle(ctx, () => svc().resubscribe(ctx.params.token, { origin }));
    }
    return fail(ctx, 400, 'bad_action');
  },

  async reason(ctx) {
    const body = ctx.request.body || {};
    await handle(ctx, () => svc().reason(ctx.params.token, { reason: body.reason, comment: body.comment }));
  },
};
