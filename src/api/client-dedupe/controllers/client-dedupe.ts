// @ts-nocheck
// Ручки модуля «Дубли клиентов» (admin-апка, owner + administrator).
// Паттерн s78: роуты auth:false + ручная проверка admin-jwt здесь
// (Strapi-стратегии наш HS256-токен не знают).

import { tokenFromCtx, verifySession } from '../../../utils/admin-jwt';
import { DedupeError } from '../services/client-dedupe';

const svc = () => strapi.service('api::client-dedupe.client-dedupe');

const ALLOWED_ROLES = new Set(['owner', 'administrator']);

const requireStaff = (ctx) => {
  const session = verifySession(tokenFromCtx(ctx));
  // слияние/удаление карточек клиентов — владелец и администраторы
  if (!session || !ALLOWED_ROLES.has(session.role)) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'unauthorized', message: 'Доступ только для владельца и администраторов' } };
    return null;
  }
  return session;
};

const handle = async (ctx, fn) => {
  try {
    ctx.body = await fn();
  } catch (e) {
    if (e instanceof DedupeError || (typeof e?.status === 'number' && typeof e?.code === 'string')) {
      ctx.status = e.status;
      ctx.body = { error: { status: e.status, code: e.code, message: e.message } };
      return;
    }
    strapi.log.error('client-dedupe error:', e);
    ctx.status = 500;
    ctx.body = { error: { status: 500, code: 'internal', message: 'Internal error' } };
  }
};

export default {
  async groups(ctx) {
    if (!requireStaff(ctx)) return;
    await handle(ctx, () => svc().findGroups());
  },

  async merge(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().merge({
        primaryDocId: b.primaryDocId,
        docIds: b.docIds,
        renameBookings: b.renameBookings !== false,
        actorName: session.username,
      })
    );
  },

  async updateClient(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().updateClient({
        docId: b.docId,
        patch: b.patch || {},
        renameBookings: b.renameBookings !== false,
        actorName: session.username,
      })
    );
  },

  async blacklist(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().setBlacklist({
        docIds: b.docIds,
        blacklisted: Boolean(b.blacklisted),
        reason: b.reason,
        actorName: session.username,
      })
    );
  },

  async ignore(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () => svc().ignore({ docIds: b.docIds, note: b.note, actorName: session.username }));
  },

  async unignore(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () => svc().unignore({ groupKey: b.groupKey, actorName: session.username }));
  },

  async history(ctx) {
    if (!requireStaff(ctx)) return;
    await handle(ctx, () => svc().history(Number(ctx.query.limit) || 50));
  },
};
