// Роуты движка бронирования (content-api → авто-префикс /api).
// auth:false везде: публичные защищает rate-limit, админские — ручной admin-jwt
// в контроллере (Strapi-стратегии наш HS256-токен не знают, паттерн s78/s93).

const pub = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: ['global::rate-limit-engine'] },
});

const admin = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: [] },
});

export default {
  routes: [
    pub('GET', '/engine/services', 'booking-engine.listServices'),
    pub('GET', '/engine/services/:id', 'booking-engine.getService'),
    pub('GET', '/engine/services/:id/employees', 'booking-engine.listServiceEmployees'),
    pub('GET', '/engine/availability', 'booking-engine.availability'),
    pub('POST', '/engine/holds', 'booking-engine.createHold'),
    pub('GET', '/engine/holds/:id', 'booking-engine.getHold'),
    pub('POST', '/engine/bookings', 'booking-engine.createBooking'),
    pub('GET', '/engine/cancel/:token', 'booking-engine.getCancel'),
    pub('POST', '/engine/cancel/:token', 'booking-engine.postCancel'),
    // дозапись с thank-you: предложения услуг других категорий в окно сразу после брони (−15%)
    pub('GET', '/engine/rebook/:token/offers', 'booking-engine.rebookOffers'),
    pub('POST', '/engine/rebook/:token', 'booking-engine.rebookCreate'),
    // управление бронью клиентом (страница /rezervace/{token}: перенос термина + отмена)
    pub('GET', '/engine/manage/:token', 'booking-engine.getManage'),
    pub('GET', '/engine/manage/:token/availability', 'booking-engine.manageAvailability'),
    pub('POST', '/engine/manage/:token/reschedule', 'booking-engine.postReschedule'),
    // сервисные ручки нотификаций (гейт секретом DIGEST_SECRET в контроллере, паттерн digest)
    admin('GET', '/engine/notify/preview', 'booking-engine.notifyPreview'),
    admin('POST', '/engine/notify/run-reminders', 'booking-engine.notifyRunReminders'),
    // Web Push (PWA мастеров): публичный VAPID-ключ + подписка/отписка устройства
    pub('GET', '/engine/push/vapid', 'booking-engine.pushVapid'),
    admin('POST', '/engine/push/subscribe', 'booking-engine.pushSubscribe'),
    admin('POST', '/engine/push/unsubscribe', 'booking-engine.pushUnsubscribe'),
    // день календаря: единственный источник броней для сетки. Для роли master
    // сервер вырезает контакты клиентов и деньги ЧУЖИХ броней — раньше админка
    // тянула /api/bookings напрямую и всё это приезжало в браузер мастера.
    admin('GET', '/engine/admin/calendar/day', 'booking-engine.adminCalendarDay'),
    admin('GET', '/engine/admin/calendar/week', 'booking-engine.adminCalendarWeek'),
    admin('GET', '/engine/admin/clients/history', 'booking-engine.adminClientHistory'),
    // аналитика: вся история броней и список клиентов одним сжатым ответом вместо
    // десятка постраничных запросов админки к /api/bookings и /api/clients
    admin('GET', '/engine/admin/analytics/history', 'booking-engine.adminAnalyticsHistory'),
    admin('GET', '/engine/admin/analytics/clients', 'booking-engine.adminAnalyticsClients'),
    admin('POST', '/engine/admin/bookings', 'booking-engine.adminCreateBooking'),
    admin('PATCH', '/engine/admin/bookings/:id', 'booking-engine.adminPatchBooking'),
    admin('DELETE', '/engine/admin/bookings/:id', 'booking-engine.adminDeleteBooking'),
    // закрытие визита из календаря (D2): запись «Оказанная услуга» по брони
    admin('GET', '/engine/admin/bookings/:id/checkout', 'booking-engine.adminCheckoutGet'),
    admin('POST', '/engine/admin/bookings/:id/checkout', 'booking-engine.adminCheckoutCreate'),
    admin('PATCH', '/engine/admin/checkout/:id', 'booking-engine.adminCheckoutPatch'),
    admin('DELETE', '/engine/admin/checkout/:id', 'booking-engine.adminCheckoutDelete'),
    // лояльность bitchcard в календаре: награды клиента брони + применить/снять скидку по коду
    admin('GET', '/engine/admin/bookings/:id/redemptions', 'booking-engine.adminBookingRedemptions'),
    admin('POST', '/engine/admin/bookings/:id/redemption', 'booking-engine.adminApplyRedemption'),
    admin('DELETE', '/engine/admin/bookings/:id/redemption', 'booking-engine.adminReleaseRedemption'),
    // скидка дозаписи (rebook −15%): снять / вернуть из drawer календаря
    admin('POST', '/engine/admin/bookings/:id/rebook-discount', 'booking-engine.adminRestoreRebookDiscount'),
    admin('DELETE', '/engine/admin/bookings/:id/rebook-discount', 'booking-engine.adminRemoveRebookDiscount'),
    // модуль «Дозаписи администраторов» (s197): кандидаты дня, дозапись −10 % с
    // черновиком комиссии администратору, «мои дозаписи» за месяц
    admin('GET', '/engine/admin/upsell/day', 'booking-engine.adminUpsellDay'),
    admin('POST', '/engine/admin/upsell', 'booking-engine.adminUpsellCreate'),
    admin('GET', '/engine/admin/upsell/mine', 'booking-engine.adminUpsellMine'),
    admin('POST', '/engine/admin/blocks', 'booking-engine.adminCreateBlock'),
    admin('GET', '/engine/admin/blocks/pending', 'booking-engine.adminPendingBlocks'),
    admin('POST', '/engine/admin/blocks/:id/approval', 'booking-engine.adminSetBlockApproval'),
    admin('PATCH', '/engine/admin/blocks/:id', 'booking-engine.adminPatchBlock'),
    admin('DELETE', '/engine/admin/blocks/:id', 'booking-engine.adminDeleteBlock'),
  ],
};
