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

  // ── управление бронью клиентом по токену (страница /rezervace/{token}) ──

  // GET /api/engine/manage/:token — детали брони + флаги cancellable/reschedulable
  async getManage(ctx) {
    await handle(ctx, () => svc().getManage(ctx.params.token));
  },

  // GET /api/engine/manage/:token/availability?from=&to= — слоты для переноса
  // (услуга/мастер из самой брони, её интервал исключён из занятости)
  async manageAvailability(ctx) {
    await handle(ctx, () => svc().manageAvailability(ctx.params.token, ctx.query.from, ctx.query.to));
  },

  // POST /api/engine/manage/:token/reschedule {date, time} — самостоятельный перенос термина
  async postReschedule(ctx) {
    const b = ctx.request.body || {};
    await handle(ctx, () => svc().postReschedule(ctx.params.token, { date: b.date, time: b.time }));
  },

  // ── сервисные ручки нотификаций (гейт DIGEST_SECRET, паттерн digest) ──

  // GET /api/engine/notify/preview?secret=&type=confirmation|reminder|cancellation&booking=<docId>
  async notifyPreview(ctx) {
    const secret = process.env.DIGEST_SECRET;
    if (!secret || ctx.query.secret !== secret) {
      ctx.status = 403;
      ctx.body = { error: { status: 403, code: 'forbidden', message: 'Bad secret' } };
      return;
    }
    await handle(ctx, () =>
      strapi
        .service('api::booking-engine.booking-notify')
        .preview(ctx.query.type || 'confirmation', ctx.query.booking)
    );
  },

  // POST /api/engine/notify/run-reminders?secret= — ручной прогон reminder-крона
  async notifyRunReminders(ctx) {
    const secret = process.env.DIGEST_SECRET;
    if (!secret || ctx.query.secret !== secret) {
      ctx.status = 403;
      ctx.body = { error: { status: 403, code: 'forbidden', message: 'Bad secret' } };
      return;
    }
    await handle(ctx, () => strapi.service('api::booking-engine.booking-notify').sendReminders());
  },

  // ── админские (admin-jwt, роли owner/administrator) ──

  // POST /api/engine/admin/bookings
  // {employee, date, time, services:[{service, variant?, modifiers?, priceOverride?}],
  //  clientDocId? | client:{name, phone, email?}, priceOverride?, comment?, notify?}
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
        notify: b.notify === true,
      })
    );
  },

  // PATCH /api/engine/admin/bookings/:id {date?, time?, employee?, status?, comment?, totalPrice?, notify?}
  async adminPatchBooking(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => svc().adminPatchBooking(ctx.params.id, ctx.request.body || {}, session));
  },

  // DELETE /api/engine/admin/bookings/:id — полное удаление брони (не отмена)
  async adminDeleteBooking(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => svc().adminDeleteBooking(ctx.params.id, session));
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
        recurrence: b.recurrence,
      })
    );
  },

  // PATCH /api/engine/admin/blocks/:id {startMin?, endMin?, title?}
  async adminPatchBlock(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().adminPatchBlock(ctx.params.id, { startMin: b.startMin, endMin: b.endMin, title: b.title }, session)
    );
  },

  // DELETE /api/engine/admin/blocks/:id[?series=1] — series=1 удаляет все повторения
  async adminDeleteBlock(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const series = ctx.query.series === '1' || ctx.query.series === 'true';
    await handle(ctx, () => svc().adminDeleteBlock(ctx.params.id, { series }));
  },
};
