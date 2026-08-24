/**
 * Обмен сессии сотрудника на серверный API-токен (s175).
 *
 * 🟥 ЗАЧЕМ. Админка — статическая SPA, и в её бандл был вкомпилирован
 * `VITE_STRAPI_TOKEN` — full-access токен Strapi. Кто открыл JS админки, тот
 * получил постоянный полный доступ к API: токен не истекает и не привязан к
 * человеку. Плюс большая часть GET-ов админки шла вообще без токена, опираясь
 * на права роли Public — из-за чего наружу были открыты зарплаты, расходы и
 * персональные данные покупателей ваучеров.
 *
 * КАК РАБОТАЕТ. Админка теперь шлёт СВОЙ токен сессии (HS256 admin-jwt, 7 дней,
 * привязан к admin-user и его роли). Этот middleware проверяет подпись и, если
 * сессия валидна, подменяет заголовок на серверный API-токен
 * (`ADMIN_PROXY_API_TOKEN`), который в браузер никогда не попадает. Дальше
 * работает штатная авторизация Strapi — ничего в роутах менять не пришлось.
 *
 * ⚠️ Оригинал сессии кладётся в `ctx.state.adminJwt` ДО подмены: наши
 * собственные ручки (engine, campaign, cabinet) читают Bearer как сессию через
 * `tokenFromCtx`, и без этого у них сломались бы все гейты ролей.
 *
 * Что это НЕ делает: доступ по-прежнему не разграничен по ролям на уровне
 * коллекций — любая валидная сессия сотрудника получает те же права API-токена.
 * Выигрыш в том, что доступ стал именным, истекающим и отзываемым (деактивация
 * пользователя), а вечный токен исчез из браузера. Разграничение по ролям —
 * отдельная задача.
 */

import { tokenFromCtx, verifySession } from '../utils/admin-jwt';

// 🟥 РЕГРЕССИЯ 24.08.2026 — почему тут ДВА жёстких ограничения.
// Панель Strapi (/admin) подписывает свои токены ТЕМ ЖЕ `ADMIN_JWT_SECRET`,
// что и наши сессии: у обоих HS256 и валидный `exp`, поэтому `verifySession`
// принимал токен панели за сессию сотрудника. Middleware подменял ему заголовок
// на API-токен, панель теряла авторизацию и уходила в цикл перезагрузок на
// странице логина.
//   1. Работаем ТОЛЬКО на /api/** — маршруты панели (/admin/**) не трогаем.
//   2. Требуем нашу роль в payload: у токена панели Strapi её нет вообще.
// Любое из двух условий закрыло бы дыру, но нужны оба: первое защищает панель,
// второе — от чужого токена с тем же секретом на прикладных маршрутах.
const STAFF_ROLES = new Set(['owner', 'administrator', 'master']);

export default (_config: unknown, { strapi }: { strapi: any }) => {
  let warned = false;
  return async (ctx: any, next: () => Promise<void>) => {
    const path: string = ctx?.request?.path || ctx?.path || '';
    if (!path.startsWith('/api/')) {
      await next();
      return;
    }
    const raw = tokenFromCtx(ctx);
    if (raw) {
      const session = verifySession(raw);
      if (session && STAFF_ROLES.has(session.role)) {
        // сохраняем ДО подмены — иначе гейты собственных ручек ослепнут
        ctx.state.adminJwt = raw;
        ctx.state.adminSession = session;
        const proxyToken = process.env.ADMIN_PROXY_API_TOKEN;
        if (proxyToken) {
          ctx.request.header.authorization = `Bearer ${proxyToken}`;
        } else if (!warned) {
          warned = true;
          strapi.log.warn(
            'admin-session: ADMIN_PROXY_API_TOKEN не задан — запросы админки к коллекциям будут отклонены'
          );
        }
      }
    }
    await next();
  };
};
