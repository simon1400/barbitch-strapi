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
    // EngineError + LoyaltyError (duck-type: оба несут числовой status и строковый
    // code — redemption_unavailable/loyalty_disabled/... из сервиса лояльности)
    if (e instanceof EngineError || (typeof e?.status === 'number' && typeof e?.code === 'string')) {
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

// любой залогиненный сотрудник (owner/administrator/master) — для push-подписки
const requireStaff = (ctx) => {
  const session = verifySession(tokenFromCtx(ctx));
  if (!session) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'unauthorized', message: 'Vyžadováno přihlášení' } };
    return null;
  }
  return session;
};

const pushSvc = () => strapi.service('api::booking-engine.push-notify');

// personal.documentId по имени сотрудника (session.username = полное имя = personal.name)
const resolvePersonalByName = async (name) => {
  if (!name) return null;
  const rows = await strapi.documents('api::personal.personal').findMany({
    filters: { name: { $eqi: String(name).trim() } },
    fields: ['name'],
    limit: 1,
  });
  return rows[0]?.documentId || null;
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

  // POST /api/engine/cancel/:token — body { reason? } (необязательная причина отмены)
  async postCancel(ctx) {
    await handle(ctx, () => svc().postCancel(ctx.params.token, ctx.request.body?.reason));
  },

  // ── дозапись с thank-you (аутентификация cancelToken исходной брони) ──

  // GET /api/engine/rebook/:token/offers — предложения дозаписи (другие категории,
  // окно мастера сразу после конца визита, −15%, таймер REBOOK_OFFER_TTL_MIN)
  async rebookOffers(ctx) {
    await handle(ctx, () => strapi.service('api::booking-engine.rebook').offers(ctx.params.token));
  },

  // POST /api/engine/rebook/:token {service, employee} — дозапись в 1 клик
  // (клиент из исходной брони, цена −15% с priceOverride, серверная пере-валидация окна)
  async rebookCreate(ctx) {
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      strapi.service('api::booking-engine.rebook').create(ctx.params.token, {
        serviceDocId: b.service,
        employeeDocId: b.employee,
      })
    );
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

  // GET /api/engine/push/vapid — публичный VAPID-ключ для подписки на устройстве
  async pushVapid(ctx) {
    await handle(ctx, async () => ({ publicKey: pushSvc().vapidPublicKey() }));
  },

  // POST /api/engine/push/subscribe {subscription, userAgent?} — подписать устройство
  // залогиненного сотрудника (personal резолвится по имени из сессии)
  async pushSubscribe(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, async () => {
      const personalDocId = await resolvePersonalByName(session.username);
      return pushSvc().subscribe({
        personalDocId,
        employeeName: session.username || '',
        subscription: b.subscription,
        userAgent: b.userAgent || ctx.request.headers['user-agent'] || '',
      });
    });
  },

  // POST /api/engine/push/unsubscribe {endpoint}
  async pushUnsubscribe(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () => pushSvc().unsubscribe(b.endpoint));
  },

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

  // ── лояльность bitchcard в календаре (walk-in флоу, К4) ──

  // GET /api/engine/admin/bookings/:id/redemptions — награды клиента брони:
  // available + применённая к этой брони (карточка в drawer)
  async adminBookingRedemptions(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, async () => {
      const booking = await strapi.documents('api::booking.booking').findOne({
        documentId: ctx.params.id,
        populate: { client: { fields: ['name'] } },
      });
      if (!booking) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');
      const loyalty = strapi.service('api::loyalty.loyalty');
      if (!loyalty.enabled()) return { enabled: false, redemptions: [] };
      if (!booking.client?.documentId) return { enabled: true, redemptions: [] };
      const [redemptions, progress] = await Promise.all([
        loyalty.redemptionsForAdmin(booking.client.documentId, ctx.params.id),
        loyalty.clientProgress(booking.client.documentId),
      ]);
      return { enabled: true, redemptions, progress };
    });
  },

  // POST /api/engine/admin/bookings/:id/redemption {code} — админ вводит код
  // с карточки клиентки → скидка на totalPrice + redemption used (одна транзакция)
  async adminApplyRedemption(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, async () => {
      const booking = await strapi.documents('api::booking.booking').findOne({
        documentId: ctx.params.id,
        populate: { client: { fields: ['name'] } },
      });
      if (!booking) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');
      const result = await strapi
        .service('api::loyalty.loyalty')
        .applyRedemptionToBooking(booking, ctx.request.body?.code, booking.client?.documentId);
      strapi.log.info(
        `booking-engine: admin ${session.username || '?'} applied redemption ${result.code} to booking ${ctx.params.id}`
      );
      return result;
    });
  },

  // DELETE /api/engine/admin/bookings/:id/redemption — снять скидку (ошибочный ввод):
  // redemption → available, цена брони восстанавливается
  async adminReleaseRedemption(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () =>
      strapi.service('api::loyalty.loyalty').releaseRedemptionForBooking(ctx.params.id)
    );
  },

  // DELETE /api/engine/admin/bookings/:id/rebook-discount — снять скидку дозаписи
  // (цена брони возвращается к полной, скидка помечается applied:false)
  async adminRemoveRebookDiscount(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, async () => {
      const result = await strapi.service('api::booking-engine.rebook').removeDiscount(ctx.params.id);
      strapi.log.info(
        `booking-engine: admin ${session.username || '?'} removed rebook discount from booking ${ctx.params.id}`
      );
      return result;
    });
  },

  // POST /api/engine/admin/bookings/:id/rebook-discount — вернуть снятую скидку дозаписи
  async adminRestoreRebookDiscount(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, async () => {
      const result = await strapi.service('api::booking-engine.rebook').restoreDiscount(ctx.params.id);
      strapi.log.info(
        `booking-engine: admin ${session.username || '?'} restored rebook discount on booking ${ctx.params.id}`
      );
      return result;
    });
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
    await handle(ctx, () => svc().adminDeleteBlock(ctx.params.id, { series }, session));
  },
};
