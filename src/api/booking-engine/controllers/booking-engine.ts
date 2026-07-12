// @ts-nocheck
// Контроллер движка бронирования. Публичные ручки — auth:false + rate-limit
// (global::rate-limit-engine); админские — ручная проверка admin-jwt (паттерн s78:
// Strapi-стратегии наш HS256-токен не знают, роуты остаются auth:false).

import { tokenFromCtx, verifySession } from '../../../utils/admin-jwt';
import { EngineError } from '../services/booking-engine';

const svc = () => strapi.service('api::booking-engine.booking-engine');

const handle = async (ctx, fn) => {
  try {
    ctx.body = await fn();
  } catch (e) {
    if (e instanceof EngineError) {
      ctx.status = e.status;
      ctx.body = { error: { status: e.status, code: e.code, message: e.message } };
      return;
    }
    strapi.log.error('booking-engine error:', e);
    ctx.status = 500;
    ctx.body = { error: { status: 500, code: 'internal', message: 'Internal error' } };
  }
};

const requireAdmin = (ctx) => {
  const session = verifySession(tokenFromCtx(ctx));
  if (!session || !['owner', 'administrator'].includes(session.role)) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'unauthorized', message: 'Vyžadováno přihlášení administrátora' } };
    return null;
  }
  return session;
};

const parseModifiers = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

export default {
  // GET /api/engine/services — публичный каталог для сайта (/book), сгруппирован по категориям
  async listServices(ctx) {
    await handle(ctx, () => svc().publicCatalog());
  },

  // GET /api/engine/services/:id — одна услуга (шаг /extras); :id = documentId или легаси noonaBaseId
  async getService(ctx) {
    await handle(ctx, () => svc().publicService(ctx.params.id));
  },

  // GET /api/engine/services/:id/employees — мастера услуги (страница выбора мастера)
  async listServiceEmployees(ctx) {
    await handle(ctx, () => svc().publicServiceEmployees(ctx.params.id));
  },

  // GET /api/engine/availability?service=&variant=&modifiers=a,b&employee=id|any&from=&to=
  async availability(ctx) {
    await handle(ctx, () =>
      svc().getAvailability({
        serviceDocId: ctx.query.service,
        variantLabel: ctx.query.variant || null,
        modifierKeys: parseModifiers(ctx.query.modifiers),
        employee: ctx.query.employee || 'any',
        fromDate: ctx.query.from,
        toDate: ctx.query.to,
      })
    );
  },

  // POST /api/engine/holds {service, variant?, modifiers?, employee|'any', date, time, sessionKey?}
  async createHold(ctx) {
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().createHold({
        serviceDocId: b.service,
        variantLabel: b.variant || null,
        modifierKeys: parseModifiers(b.modifiers),
        employee: b.employee || 'any',
        date: b.date,
        time: b.time,
        sessionKey: b.sessionKey,
      })
    );
  },

  // GET /api/engine/holds/:id
  async getHold(ctx) {
    await handle(ctx, () => svc().getHold(ctx.params.id));
  },

  // POST /api/engine/bookings {holdId, name, phone, email?, customerComment?}
  async createBooking(ctx) {
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().createBooking({
        holdId: b.holdId,
        name: b.name,
        phone: b.phone,
        email: b.email,
        customerComment: b.customerComment,
      })
    );
  },

  // GET /api/engine/cancel/:token
  async getCancel(ctx) {
    await handle(ctx, () => svc().getCancel(ctx.params.token));
  },

  // POST /api/engine/cancel/:token
  async postCancel(ctx) {
    await handle(ctx, () => svc().postCancel(ctx.params.token));
  },

  // ── админские (admin-jwt, роли owner/administrator) ──

  // POST /api/engine/admin/bookings
  // {employee, date, time, services:[{service, variant?, modifiers?, priceOverride?}],
  //  clientDocId? | client:{name, phone, email?}, priceOverride?, comment?}
  async adminCreateBooking(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().adminCreateBooking({
        session,
        employee: b.employee,
        date: b.date,
        time: b.time,
        serviceItems: (b.services || []).map((i) => ({ ...i, modifiers: parseModifiers(i.modifiers) })),
        client: b.client,
        clientDocId: b.clientDocId,
        priceOverride: b.priceOverride,
        comment: b.comment,
      })
    );
  },

  // PATCH /api/engine/admin/bookings/:id {date?, time?, employee?, status?, comment?, totalPrice?}
  async adminPatchBooking(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => svc().adminPatchBooking(ctx.params.id, ctx.request.body || {}, session));
  },

  // POST /api/engine/admin/blocks {employee, date, startMin, endMin, title?}
  async adminCreateBlock(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().adminCreateBlock({
        session,
        employee: b.employee,
        date: b.date,
        startMin: Number(b.startMin),
        endMin: Number(b.endMin),
        title: b.title,
      })
    );
  },

  // DELETE /api/engine/admin/blocks/:id
  async adminDeleteBlock(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => svc().adminDeleteBlock(ctx.params.id));
  },
};
