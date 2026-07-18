// @ts-nocheck
// Контроллер личного кабинета клиента. Роуты auth:false (Strapi-стратегии наш
// HS256-токен не знают — паттерн booking-engine s78/s101), защита = rate-limit
// middleware + ручная проверка client-jwt здесь. Ответы — плоский ctx.body
// (клиентский axios будет без интерсептора-разворота, паттерн engine.ts s101).

import {
  clientTokenFromCtx,
  shouldRenewSession,
  signClientSession,
  verifyClientSession,
} from '../../../utils/client-jwt';
import { CabinetError } from '../services/client-cabinet';

const svc = () => strapi.service('api::client-cabinet.client-cabinet');

const handle = async (ctx, fn) => {
  try {
    ctx.body = await fn();
  } catch (e) {
    // CabinetError + EngineError движка (duck-type: оба несут числовой status
    // и строковый code — too_late/slot_taken/reschedule_limit/... из manage-ядра).
    if (e instanceof CabinetError || (typeof e?.status === 'number' && typeof e?.code === 'string')) {
      ctx.status = e.status;
      ctx.body = { error: { status: e.status, code: e.code, message: e.message } };
      return;
    }
    strapi.log.error('client-cabinet error:', e);
    ctx.status = 500;
    ctx.body = { error: { status: 500, code: 'internal', message: 'Internal error' } };
  }
};

// JWT-гейт: 503 без CLIENT_JWT_SECRET (кабинет выключен), 401 без/с битым токеном.
const requireClient = (ctx) => {
  try {
    svc().assertEnabled();
  } catch (e) {
    ctx.status = e.status || 503;
    ctx.body = { error: { status: e.status || 503, code: e.code || 'cabinet_disabled', message: e.message } };
    return null;
  }
  const session = verifyClientSession(clientTokenFromCtx(ctx));
  if (!session) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, code: 'unauthorized', message: 'Vyžadováno přihlášení' } };
    return null;
  }
  return session;
};

export default {
  // POST /api/cabinet/login {email} — magic-link письмо; ответ ВСЕГДА {ok:true}
  async login(ctx) {
    await handle(ctx, () => svc().login(ctx.request.body?.email));
  },

  // GET /api/cabinet/login/verify?token= — погашение токена → {jwt, client}
  async verify(ctx) {
    await handle(ctx, () => svc().verify(ctx.query.token));
  },

  // GET /api/cabinet/me (JWT). Скользящее продление сессии: токен старше суток →
  // в ответ добавляется renewedJwt со свежим exp (клиент кладёт его в localStorage).
  async me(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, async () => {
      const me = await svc().me(session);
      if (shouldRenewSession(session)) {
        return {
          ...me,
          renewedJwt: signClientSession({ clientDocId: session.clientDocId, email: session.email }),
        };
      }
      return me;
    });
  },

  // PATCH /api/cabinet/me (JWT) {name?, phone?, birthday?, marketingConsent?}
  async patchMe(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () => svc().patchMe(session, ctx.request.body || {}));
  },

  // GET /api/cabinet/bookings (JWT) → {upcoming, history}
  async bookings(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () => svc().bookings(session));
  },

  // POST /api/cabinet/bookings/:id/cancel (JWT) — отмена своей брони (анти-BOLA 404)
  async cancelBooking(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () => svc().cancelBooking(session, ctx.params.id));
  },

  // GET /api/cabinet/bookings/:id/availability?from&to (JWT) — слоты для переноса
  async bookingAvailability(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () =>
      svc().bookingAvailability(session, ctx.params.id, ctx.query.from, ctx.query.to)
    );
  },

  // POST /api/cabinet/bookings/:id/reschedule {date,time} (JWT) — перенос своей брони
  async rescheduleBooking(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () => svc().rescheduleBooking(session, ctx.params.id, ctx.request.body || {}));
  },

  // GET /api/cabinet/loyalty (JWT) — цифровая bitchcard: баланс/наклейки/трек/транзакции
  async loyalty(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () => svc().loyalty(session));
  },
};
