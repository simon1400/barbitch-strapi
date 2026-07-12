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
    // сервисные ручки нотификаций (гейт секретом DIGEST_SECRET в контроллере, паттерн digest)
    admin('GET', '/engine/notify/preview', 'booking-engine.notifyPreview'),
    admin('POST', '/engine/notify/run-reminders', 'booking-engine.notifyRunReminders'),
    admin('POST', '/engine/admin/bookings', 'booking-engine.adminCreateBooking'),
    admin('PATCH', '/engine/admin/bookings/:id', 'booking-engine.adminPatchBooking'),
    admin('POST', '/engine/admin/blocks', 'booking-engine.adminCreateBlock'),
    admin('DELETE', '/engine/admin/blocks/:id', 'booking-engine.adminDeleteBlock'),
  ],
};
