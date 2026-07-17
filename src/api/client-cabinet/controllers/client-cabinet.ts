// @ts-nocheck
// Контроллер личного кабинета клиента. Роуты auth:false (Strapi-стратегии наш
// HS256-токен не знают — паттерн booking-engine s78/s101), защита = rate-limit
// middleware + ручная проверка client-jwt здесь. Ответы — плоский ctx.body
// (клиентский axios будет без интерсептора-разворота, паттерн engine.ts s101).

import { clientTokenFromCtx, verifyClientSession } from '../../../utils/client-jwt';
import { CabinetError } from '../services/client-cabinet';

const svc = () => strapi.service('api::client-cabinet.client-cabinet');

const handle = async (ctx, fn) => {
  try {
    ctx.body = await fn();
  } catch (e) {
    if (e instanceof CabinetError) {
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

  // GET /api/cabinet/me (JWT)
  async me(ctx) {
    const session = requireClient(ctx);
    if (!session) return;
    await handle(ctx, () => svc().me(session));
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
};
