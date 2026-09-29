// @ts-nocheck
// Контроллер движка бронирования. Публичные ручки — auth:false + rate-limit
// (global::rate-limit-engine); админские — ручная проверка admin-jwt (паттерн s78:
// Strapi-стратегии наш HS256-токен не знают, роуты остаются auth:false).

import { isManagementRole, sessionFromCtx } from '../../../utils/admin-jwt';
import { findSessionPersonal } from '../../../utils/staff-identity';
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
      // карточка сотрудника (s224): 409 future_bookings несёт список броней
      if (e.details) ctx.body.error.details = e.details;
      return;
    }
    strapi.log.error('booking-engine error:', e);
    ctx.status = 500;
    ctx.body = { error: { status: 500, code: 'internal', message: 'Internal error' } };
  }
};

const requireAdmin = (ctx) => {
  const session = sessionFromCtx(ctx);
  if (!session || !['owner', 'manager', 'administrator'].includes(session.role)) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'unauthorized', message: 'Vyžadováno přihlášení administrátora' } };
    return null;
  }
  return session;
};

// только руководство (владелец + управляющая, s213) — подтверждение блоков, отчёты
const requireManagement = (ctx) => {
  const session = sessionFromCtx(ctx);
  if (!session || !isManagementRole(session.role)) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'owner_only', message: 'Tuto akci může provést jen vedení salonu' } };
    return null;
  }
  return session;
};

// любой залогиненный сотрудник (owner/administrator/master) — для push-подписки
const requireStaff = (ctx) => {
  const session = sessionFromCtx(ctx);
  if (!session) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'unauthorized', message: 'Vyžadováno přihlášení' } };
    return null;
  }
  return session;
};

const pushSvc = () => strapi.service('api::booking-engine.push-notify');
const visitCloseSvc = () => strapi.service('api::booking-engine.visit-close');
const analyticsSvc = () => strapi.service('api::booking-engine.admin-analytics');
const upsellSvc = () => strapi.service('api::booking-engine.upsell');
const correctionsSvc = () => strapi.service('api::booking-engine.corrections');
const timeOffsSvc = () => strapi.service('api::booking-engine.time-offs');
const shiftsSvc = () => strapi.service('api::booking-engine.shifts');
const scheduleSvc = () => strapi.service('api::booking-engine.master-schedule');
const birthdaysSvc = () => strapi.service('api::booking-engine.birthdays');
const staffSvc = () => strapi.service('api::booking-engine.staff');
const myMonthSvc = () => strapi.service('api::booking-engine.my-month');

// personal.documentId сотрудника сессии: по связи учётки, без связи — по имени (s229, §5а.1)
const resolveSessionPersonalDocId = async (session) =>
  (await findSessionPersonal(strapi, session))?.documentId || null;

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

  // GET /api/engine/services/:id/employees?variant=&modifiers=a,b — мастера услуги
  // (страница выбора мастера). Выбор с шага /extras отсекает мастеров, которым эта
  // комбинация не разрешена (salon-service.restrictions).
  async listServiceEmployees(ctx) {
    await handle(ctx, () =>
      svc().publicServiceEmployees(ctx.params.id, ctx.query.variant || null, parseModifiers(ctx.query.modifiers))
    );
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

  // POST /api/engine/bookings {holdId, name, phone, email?, customerComment?, attribution?}
  // attribution — откуда пришёл клиент (first/last касание), чистится в сервисе (s200)
  async createBooking(ctx) {
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().createBooking({
        holdId: b.holdId,
        name: b.name,
        phone: b.phone,
        email: b.email,
        customerComment: b.customerComment,
        attribution: b.attribution,
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

  // ── админские (admin-jwt, роли owner/manager/administrator) ──

  // GET /api/engine/push/vapid — публичный VAPID-ключ для подписки на устройстве
  async pushVapid(ctx) {
    await handle(ctx, async () => ({ publicKey: pushSvc().vapidPublicKey() }));
  },

  // POST /api/engine/push/subscribe {subscription, userAgent?} — подписать устройство
  // залогиненного сотрудника (personal — по связи учётки, без связи — по имени)
  async pushSubscribe(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, async () => {
      const personalDocId = await resolveSessionPersonalDocId(session);
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

  // GET /api/engine/admin/calendar/day?date=YYYY-MM-DD
  // Брони дня для сетки календаря. Отдаёт МАССИВ той же формы, что раньше
  // приходил из /api/bookings, — админка подменила только источник.
  //
  // 🟥 Зачем ручка: мастеру нужен дневной график ВСЕГО салона (кто когда занят),
  // но не чужие деньги и не контакты чужих клиентов. Раньше фильтрация была
  // только в рендере: e-mail, телефон и суммы всех броней дня уже лежали в
  // браузере мастера и доставались из DevTools одной строкой.
  async adminCalendarDay(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const date = String(ctx.query?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      ctx.status = 400;
      ctx.body = { error: { status: 400, code: 'bad_date', message: 'Očekáván formát YYYY-MM-DD' } };
      return;
    }
    await handle(ctx, () => svc().calendarDayForSession({ date, session }));
  },

  // GET /api/engine/admin/calendar/week?monday=YYYY-MM-DD&employee=<noonaEmployeeId>
  // Неделя одного мастера. Для роли master employee игнорируется и подставляется
  // его собственный — чужую неделю с ценами получить нельзя.
  async adminCalendarWeek(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    const monday = String(ctx.query?.monday || '').trim();
    const sunday = String(ctx.query?.sunday || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(monday) || !/^\d{4}-\d{2}-\d{2}$/.test(sunday)) {
      ctx.status = 400;
      ctx.body = { error: { status: 400, code: 'bad_date', message: 'Očekáván formát YYYY-MM-DD' } };
      return;
    }
    await handle(ctx, () =>
      svc().calendarWeekForSession({
        monday,
        sunday,
        employee: String(ctx.query?.employee || '').trim() || null,
        session,
      })
    );
  },

  // GET /api/engine/admin/analytics/history
  // ВСЯ история броней для табов аналитики, колоночно (см. services/admin-analytics).
  // Раньше админка собирала это сама десятком запросов к /api/bookings.
  async adminAnalyticsHistory(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => analyticsSvc().history());
  },

  // GET /api/engine/admin/analytics/clients?contacts=0|1
  // Клиенты колоночно. contacts=0 — только ключ и имя (нужно сверке смены).
  async adminAnalyticsClients(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const withContacts = String(ctx.query?.contacts ?? '1') !== '0';
    await handle(ctx, () => analyticsSvc().clients({ withContacts }));
  },

  // GET /api/engine/admin/clients/history?clientDocId=…|clientName=…
  // История визитов клиента. Мастеру отдаются только ЕГО визиты с этим клиентом.
  async adminClientHistory(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    await handle(ctx, () =>
      svc().clientHistoryForSession({
        clientDocId: String(ctx.query?.clientDocId || '').trim() || null,
        clientName: String(ctx.query?.clientName || '').trim() || null,
        session,
      })
    );
  },

  // POST /api/engine/admin/bookings
  // {employee, date, time, services:[{service, variant?, modifiers?, priceOverride?}],
  //  clientDocId? | client:{name, phone, email?}, priceOverride?, comment?, notify?,
  //  internal?, internalFor?}
  // internal:true — «Interní rezervace» (s203): запись СОТРУДНИКА, время мастера не
  // занимает; клиент не нужен и не создаётся, вместо него internalFor = documentId
  // активного `personal` (кого обслуживают).
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
        internal: b.internal === true,
        internalFor: b.internalFor || null,
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

  // ── закрытие визита из календаря («Uzavřít návštěvu», вариант D2) ──

  // GET /api/engine/admin/bookings/:id/checkout — запись чекаута (или null) + подсказка расчёта
  async adminCheckoutGet(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => visitCloseSvc().getForBooking(ctx.params.id));
  },

  // POST /api/engine/admin/bookings/:id/checkout
  // {staffSalaries, salonSalaries, tip?, sale?, cash?, internal?, voucherDocId?, comment?}
  async adminCheckoutCreate(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => visitCloseSvc().createForBooking(ctx.params.id, ctx.request.body || {}, session));
  },

  // PATCH /api/engine/admin/checkout/:id — правка сумм/галок (только черновик)
  async adminCheckoutPatch(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => visitCloseSvc().patch(ctx.params.id, ctx.request.body || {}, session));
  },

  // DELETE /api/engine/admin/checkout/:id — отменить закрытие визита (бронь → active)
  async adminCheckoutDelete(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => visitCloseSvc().remove(ctx.params.id, session));
  },

  // GET /api/engine/admin/bookings/:id/korekce-candidates — визиты того же клиента за
  // 14 дней до брони-коррекции (s210). Владелец + администраторы; мастеру закрыто.
  async adminKorekceCandidates(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => strapi.service('api::booking-engine.korekce-transfer').candidates(ctx.params.id));
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

  // ── модуль «Дозаписи администраторов» (s197) ──

  // GET /api/engine/admin/upsell/day?date=YYYY-MM-DD — клиенты дня и варианты дозаписи
  async adminUpsellDay(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => upsellSvc().dayCandidates({ date: String(ctx.query?.date || '').trim() || null }));
  },

  // POST /api/engine/admin/upsell {anchorBooking, service, employee, mode:'after'|'before'}
  async adminUpsellCreate(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      upsellSvc().create({
        session,
        anchorBookingDocId: b.anchorBooking,
        serviceDocId: b.service,
        employeeDocId: b.employee,
        mode: b.mode,
      })
    );
  },

  // GET /api/engine/admin/upsell/mine?month=YYYY-MM — администратору свои, владельцу все
  async adminUpsellMine(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => upsellSvc().mine({ session, month: String(ctx.query?.month || '').trim() }));
  },

  // POST /api/engine/admin/upsell/result {client, outcome:'declined'|'not_offered', reason, comment?}
  // — результат предложения по клиенту, который сегодня уже пришёл (s199)
  async adminUpsellResult(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      upsellSvc().saveResult({
        session,
        clientDocId: b.client,
        outcome: b.outcome,
        reason: b.reason,
        comment: b.comment,
      })
    );
  },

  // GET /api/engine/admin/upsell/report?month=YYYY-MM — контроль предложений, руководство (s213)
  async adminUpsellReport(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => upsellSvc().report({ month: String(ctx.query?.month || '').trim() }));
  },

  // GET /api/engine/admin/attribution/report?from=&to=&basis=created|visit&touch=first|last
  // «Источники броней» (s200) — руководство (s213)
  async adminAttributionReport(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    const q = ctx.query || {};
    await handle(ctx, () =>
      strapi.service('api::booking-engine.attribution').report({
        from: String(q.from || '').trim(),
        to: String(q.to || '').trim(),
        basis: String(q.basis || 'created'),
        touch: String(q.touch || 'first'),
      })
    );
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
  // GET /api/engine/admin/blocks/pending — блоки, ждущие подтверждения руководства
  // GET /api/engine/admin/today?date=YYYY-MM-DD — дашборд «Сегодня» (s214), только руководство
  async adminToday(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => strapi.service('api::booking-engine.today').overview({ date: ctx.query?.date }));
  },

  // Дни рождения сотрудников (s221): ближайшие 30 дней, только день и месяц —
  // руководство и администраторы, мастеру нет
  // GET /api/engine/admin/my-month?from=ISO&to=ISO — кабинет мастера (s229): своя карточка
  // с услугами, штрафы, доплаты, выплаты. «Своя» — по связи учётки из базы; чужую не запросить.
  async adminMyMonth(ctx) {
    const session = requireStaff(ctx);
    if (!session) return;
    await handle(ctx, () => myMonthSvc().get({ session, from: ctx.query?.from, to: ctx.query?.to }));
  },

  // GET /api/engine/admin/birthdays
  async adminBirthdays(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => birthdaysSvc().list({ session }));
  },

  // Корректировки зарплат (s215): штрафы, доп. заработок, списания, авансы, выплаты — руководство
  // GET /api/engine/admin/corrections?month=YYYY-MM[&personal=<documentId>]
  async adminCorrectionsList(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      correctionsSvc().list({ month: ctx.query?.month, personal: ctx.query?.personal })
    );
  },

  // POST /api/engine/admin/corrections {kind, personal, date, sum, text}
  async adminCorrectionCreate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => correctionsSvc().create({ session, body: ctx.request.body }));
  },

  // DELETE /api/engine/admin/corrections/:kind/:id — только записи без source
  async adminCorrectionDelete(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      correctionsSvc().remove({ session, kind: ctx.params.kind, documentId: ctx.params.id })
    );
  },

  // Отпуска / больничные (s216): запись + серия блоков мастеру — руководство
  // GET /api/engine/admin/time-offs/conflicts?personal=&startDate=&endDate= — брони мастера на эти дни
  async adminTimeOffConflicts(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    const q = ctx.query || {};
    await handle(ctx, () =>
      timeOffsSvc().conflicts({ personal: q.personal, startDate: q.startDate, endDate: q.endDate })
    );
  },

  // POST /api/engine/admin/time-offs {personal, type, startDate, endDate, paid, comment}
  async adminTimeOffCreate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => timeOffsSvc().create({ session, body: ctx.request.body }));
  },

  // PATCH /api/engine/admin/time-offs/:id — любые поля формы; серия блоков доводится
  async adminTimeOffUpdate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      timeOffsSvc().update({ session, documentId: ctx.params.id, body: ctx.request.body })
    );
  },

  // DELETE /api/engine/admin/time-offs/:id — запись + её блоки
  async adminTimeOffDelete(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => timeOffsSvc().remove({ session, documentId: ctx.params.id }));
  },

  // Смены администраторов (s217): график недели «кто дежурит» — руководство
  // GET /api/engine/admin/shifts?from=<понедельник>&weeks=N
  async adminShiftsList(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => shiftsSvc().list({ from: ctx.query?.from, weeks: ctx.query?.weeks }));
  },

  // PUT /api/engine/admin/shifts/:monday {days: {monday…sunday}, base: updatedAt|null}
  async adminShiftSave(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      shiftsSvc().save({ session, monday: ctx.params.monday, body: ctx.request.body })
    );
  },

  // DELETE /api/engine/admin/shifts/:monday[?base=updatedAt] — график недели целиком
  async adminShiftDelete(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      shiftsSvc().remove({ session, monday: ctx.params.monday, base: ctx.query?.base })
    );
  },

  // ── Плановый график мастеров (s218). Смотреть и предлагать — администратор тоже
  // (requireAdmin: мастеру ручки закрыты — сам себе он ничего не меняет); шаблон,
  // решения по предложениям и замена старых блоков — только руководство.

  // GET /api/engine/admin/schedule?month=YYYY-MM — сетка мастера × дни
  async adminScheduleGrid(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => scheduleSvc().grid({ month: ctx.query?.month, session }));
  },

  // POST /api/engine/admin/schedule/:personal/preview {template?:{from,days} | changes:[…]} — брони в новом нерабочем времени
  async adminSchedulePreview(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => scheduleSvc().preview({ personal: ctx.params.personal, body: ctx.request.body }));
  },

  // PUT /api/engine/admin/schedule/:personal/template {from, days:{'0'..'6'}, base}
  async adminScheduleTemplate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      scheduleSvc().saveTemplate({ session, personal: ctx.params.personal, body: ctx.request.body })
    );
  },

  // PUT /api/engine/admin/schedule/:personal/days {changes:[{date,state,from?,to?}], note?, base}
  // руководство — сразу, администратор — предложение на согласование
  async adminScheduleDays(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    await handle(ctx, () => scheduleSvc().saveDays({ session, personal: ctx.params.personal, body: ctx.request.body }));
  },

  // POST /api/engine/admin/schedule/:personal/requests/:date {status:'approved'|'rejected'}
  async adminScheduleDecide(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      scheduleSvc().decide({ session, personal: ctx.params.personal, date: ctx.params.date, body: ctx.request.body })
    );
  },

  // GET /api/engine/admin/schedule/:personal/legacy — старые серии, которые план покрывает
  async adminScheduleLegacy(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => scheduleSvc().legacyCandidates({ personal: ctx.params.personal }));
  },

  // POST /api/engine/admin/schedule/:personal/legacy {keys:[…]} — удалить их будущие блоки
  async adminScheduleLegacyReplace(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      scheduleSvc().replaceLegacy({ session, personal: ctx.params.personal, body: ctx.request.body })
    );
  },

  // ── Карточка сотрудника (s224): только руководство; владелец скрыт от управляющей
  // (правило в сервисе). Личные данные — отдельной ручкой /private.

  // GET /api/engine/admin/staff — список без личных данных
  async adminStaffList(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().list({ session }));
  },

  // GET /api/engine/admin/staff-reminders — «Сегодня» (s227): сроки документов работающих,
  // стирание личных данных через 3 года после ухода, ушедшие без даты ухода
  async adminStaffReminders(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().reminders({ session }));
  },

  // GET /api/engine/admin/staff/:id — карточка без личных данных
  async adminStaffCard(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().card({ session, id: ctx.params.id }));
  },

  // GET /api/engine/admin/staff/:id/private — личные данные + документы
  async adminStaffPrivate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    ctx.set('Cache-Control', 'no-store');
    await handle(ctx, () => staffSvc().privateData({ session, id: ctx.params.id }));
  },

  // PATCH /api/engine/admin/staff/:id {section: basic|booking|pay|private, data, base}
  async adminStaffPatch(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().patch({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  // POST /api/engine/admin/staff/:id/rates {typeWork, rate, hourlyRate?, from, base}
  async adminStaffRate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().addRate({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  // POST /api/engine/admin/staff/:id/files — multipart: files, target=photo|document, kind, title, validUntil
  async adminStaffFileUpload(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      staffSvc().uploadFile({ session, id: ctx.params.id, body: ctx.request.body, files: ctx.request.files })
    );
  },

  // GET /api/engine/admin/staff/:id/files/:fileId — скан потоком (не кэшировать)
  async adminStaffFileDownload(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, async () => {
      const f = await staffSvc().download({ session, id: ctx.params.id, fileId: ctx.params.fileId });
      ctx.set('Content-Type', f.mime);
      ctx.set('Content-Length', String(f.size));
      ctx.set('Content-Disposition', f.disposition);
      ctx.set('Cache-Control', 'no-store');
      ctx.set('X-Content-Type-Options', 'nosniff');
      return f.stream;
    });
  },

  // PATCH /api/engine/admin/staff/:id/files/:fileId {kind?, title?, validUntil?}
  async adminStaffFileUpdate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      staffSvc().updateFile({ session, id: ctx.params.id, fileId: ctx.params.fileId, body: ctx.request.body })
    );
  },

  // DELETE /api/engine/admin/staff/:id/files/:fileId
  async adminStaffFileDelete(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().deleteFile({ session, id: ctx.params.id, fileId: ctx.params.fileId }));
  },

  // POST /api/engine/admin/staff/:id/notes {text}
  async adminStaffNoteCreate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().addNote({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  // PATCH /api/engine/admin/staff/:id/notes/:noteId {text} — автор или владелец
  async adminStaffNoteUpdate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () =>
      staffSvc().updateNote({ session, id: ctx.params.id, noteId: ctx.params.noteId, body: ctx.request.body })
    );
  },

  // DELETE /api/engine/admin/staff/:id/notes/:noteId — автор или владелец
  async adminStaffNoteDelete(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().deleteNote({ session, id: ctx.params.id, noteId: ctx.params.noteId }));
  },

  // ── Карточка сотрудника, шаг 4 (s225): создание, учётка, переименование, уход, стирание.
  // Ответы с паролем (создание, учётка) — не кэшировать.

  // POST /api/engine/admin/staff {name, position, tier?, hiredAt?, ratePercent?, rate?, private?, account?}
  async adminStaffCreate(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    ctx.set('Cache-Control', 'no-store');
    await handle(ctx, () => staffSvc().create({ session, body: ctx.request.body }));
  },

  // POST /api/engine/admin/staff/:id/account {action: create|disable|enable|reset_password}
  async adminStaffAccount(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    ctx.set('Cache-Control', 'no-store');
    await handle(ctx, () => staffSvc().account({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  // POST /api/engine/admin/staff/:id/rename {name, base}
  async adminStaffRename(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().rename({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  // GET /api/engine/admin/staff/:id/leave — предпросмотр «Завершить работу»
  async adminStaffLeavePreview(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().leavePreview({ session, id: ctx.params.id }));
  },

  // POST /api/engine/admin/staff/:id/leave {leftAt?, base}
  async adminStaffLeave(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().leave({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  // POST /api/engine/admin/staff/:id/erase {confirmName, base} — через 3 года после ухода
  async adminStaffErase(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => staffSvc().erase({ session, id: ctx.params.id, body: ctx.request.body }));
  },

  async adminPendingBlocks(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    await handle(ctx, () => svc().adminPendingBlocks());
  },

  // POST /api/engine/admin/blocks/:id/approval {status:'approved'|'rejected', series?:boolean}
  async adminSetBlockApproval(ctx) {
    const session = requireManagement(ctx);
    if (!session) return;
    const b = ctx.request.body || {};
    await handle(ctx, () =>
      svc().adminSetBlockApproval(ctx.params.id, { status: b.status, series: b.series === true }, session)
    );
  },

  async adminDeleteBlock(ctx) {
    const session = requireAdmin(ctx);
    if (!session) return;
    const series = ctx.query.series === '1' || ctx.query.series === 'true';
    await handle(ctx, () => svc().adminDeleteBlock(ctx.params.id, { series }, session));
  },
};
