// Роуты личного кабинета клиента (content-api → авто-префикс /api).
// auth:false везде: защита = global::rate-limit-cabinet (login строгий:
// per-email 5/15мин + per-IP 20/15мин; остальные per-IP 300/5мин) + ручная
// проверка client-jwt в контроллере (паттерн booking-engine).

const route = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: ['global::rate-limit-cabinet'] },
});

export default {
  routes: [
    route('POST', '/cabinet/login', 'client-cabinet.login'),
    route('GET', '/cabinet/login/verify', 'client-cabinet.verify'),
    route('GET', '/cabinet/me', 'client-cabinet.me'),
    route('PATCH', '/cabinet/me', 'client-cabinet.patchMe'),
    route('GET', '/cabinet/bookings', 'client-cabinet.bookings'),
    route('POST', '/cabinet/bookings/:id/cancel', 'client-cabinet.cancelBooking'),
    route('GET', '/cabinet/bookings/:id/availability', 'client-cabinet.bookingAvailability'),
    route('POST', '/cabinet/bookings/:id/reschedule', 'client-cabinet.rescheduleBooking'),
    route('GET', '/cabinet/loyalty', 'client-cabinet.loyalty'),
    route('POST', '/cabinet/bookings/:id/redemption', 'client-cabinet.applyRedemption'),
    route('DELETE', '/cabinet/bookings/:id/redemption', 'client-cabinet.releaseRedemption'),
  ],
};
