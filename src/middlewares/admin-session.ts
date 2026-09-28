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
const STAFF_ROLES = new Set(['owner', 'manager', 'administrator', 'master']);

// 🟥 Коллекции, закрытые для роли MASTER (s182).
//
// До этого любая сессия сотрудника получала права full-access токена, поэтому
// мастер мог запросить `/api/bookings` без фильтров и вытащить e-mail, телефоны
// и суммы ВСЕХ броней салона — в интерфейсе это было скрыто, но данные лежали
// в браузере и брались из DevTools одной строкой.
//
// Всё, что мастеру действительно нужно, теперь приходит через ручки движка
// (`/api/engine/admin/calendar/day|week`, `/api/engine/admin/clients/history`),
// где сервер сам режет чужие деньги и контакты. Прямые коллекции ему больше
// не нужны:
//   bookings    — календарь и история идут через движок;
//   clients     — поиск клиента и блэклист есть только у администратора;
//   redemptions — суммы bitchcard теперь приходят внутри ответа движка.
// Панель Strapi и ручки движка тут не задеты: проверка только на /api/<коллекция>.
const MASTER_DENIED = new Set(['bookings', 'clients', 'redemptions']);

const collectionOf = (path: string): string => path.slice('/api/'.length).split(/[/?]/)[0];

const deniedForMaster = (path: string): boolean => MASTER_DENIED.has(collectionOf(path));

// 🟥 Коллекции ТОЛЬКО ДЛЯ ЧТЕНИЯ любой сессии сотрудника (s218).
//
// Сессия получает права full-access токена, поэтому мастер (и администратор) мог
// `POST /api/time-blocks` напрямую: блок лёг бы сразу действующим (default схемы —
// approved) — мимо согласования, журнала и планового графика. Решение владельца:
// мастер сам себе блоков не ставит, администратор меняет блоки через согласование.
// Админка пишет блоки исключительно ручками движка (/api/engine/admin/blocks,
// /schedule), а эти коллекции лишь читает (календарь, «Загрузка», «Окна»).
// Панель Strapi (/admin/**) не задета: часы салона владелец правит в CM как раньше.
const STAFF_READ_ONLY = new Set(['time-blocks', 'salon-hours', 'master-schedules']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const deniedWriteForStaff = (path: string, method: string): boolean =>
  STAFF_READ_ONLY.has(collectionOf(path)) && !READ_METHODS.has(String(method || 'GET').toUpperCase());

// 🟥 Паспортные данные сотрудников закрыты ЛЮБОЙ сессии сотрудника (s221).
//
// Компонент `personal.oficial` — номер документа, адреса, дата рождения, телефон,
// сканы документов. Сессия получает права full-access токена, поэтому мастер мог
// одной строкой (`/api/personals?populate=oficial`) вытащить документы всех коллег.
// Админке компонент не нужен ВООБЩЕ: единственное, что из него показывается, —
// день и месяц рождения, и их отдаёт ручка движка `/api/engine/admin/birthdays`
// (сервер читает сам, год наружу не уходит). Поэтому три замка, все роли:
//   1. запрос, где `oficial` упомянут в query (populate / filters / sort / fields), —
//      403: фильтр `filters[oficial][documentNumber][$startsWith]` подбирал бы
//      значение по символу, даже если сам компонент в ответ не попадает;
//   2. запись с `oficial` в теле — 403 (правится только в панели Strapi);
//   3. из ЛЮБОГО ответа ключ `oficial` вырезается на любой глубине — закрывает
//      `populate=*` и вложенный populate через связи (услуги → personal → …),
//      которые по тексту запроса не распознать.
//   4. медиатека (`/api/upload/**`) закрыта целиком: в ней лежат сканы документов,
//      а `GET /api/upload/files` отдавал их списком со ссылками. Админка медиатеку
//      не читает и файлов не загружает.
// Панель Strapi (/admin/**) не задета — владелец ведёт данные там же.
const SECRET_KEY = 'oficial';
const STAFF_DENIED = new Set(['upload']);

export const deniedForStaff = (path: string): boolean => STAFF_DENIED.has(collectionOf(path));
const MAX_DEPTH = 12;

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Запрос упоминает закрытый компонент (в т.ч. в дважды закодированном виде). */
export const queryTouchesSecret = (querystring: string): boolean => {
  const raw = String(querystring || '');
  return [raw, safeDecode(raw), safeDecode(safeDecode(raw))].some((q) => q.toLowerCase().includes(SECRET_KEY));
};

/** В теле запроса есть ключ закрытого компонента (на любой глубине). */
export const bodyTouchesSecret = (body: unknown, depth = 0): boolean => {
  if (!body || typeof body !== 'object' || depth > MAX_DEPTH) return false;
  if (Array.isArray(body)) return body.some((v) => bodyTouchesSecret(v, depth + 1));
  return Object.entries(body as Record<string, unknown>).some(
    ([k, v]) => k.toLowerCase() === SECRET_KEY || bodyTouchesSecret(v, depth + 1)
  );
};

const isPlain = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Вырезает закрытый компонент из ответа (меняет объект на месте); true — что-то вырезано. */
export const stripSecret = (body: unknown, depth = 0): boolean => {
  if (depth > MAX_DEPTH) return false;
  let hit = false;
  if (Array.isArray(body)) {
    for (const v of body) if (stripSecret(v, depth + 1)) hit = true;
    return hit;
  }
  // потоки, Buffer, даты — не трогаем
  if (!isPlain(body)) return false;
  const obj = body as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === SECRET_KEY) {
      delete obj[k];
      hit = true;
    } else if (stripSecret(obj[k], depth + 1)) hit = true;
  }
  return hit;
};

const denySecret = (ctx: any) => {
  ctx.status = 403;
  ctx.body = {
    error: {
      status: 403,
      code: 'personal_data_closed',
      message: 'Osobní údaje zaměstnanců jsou dostupné jen v administraci Strapi',
    },
  };
};

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
        if (session.role === 'master' && deniedForMaster(path)) {
          ctx.status = 403;
          ctx.body = {
            error: {
              status: 403,
              code: 'forbidden_for_master',
              message: 'Tato data jsou dostupná jen přes kalendář',
            },
          };
          return;
        }
        if (deniedWriteForStaff(path, ctx.request?.method || ctx.method)) {
          ctx.status = 403;
          ctx.body = {
            error: {
              status: 403,
              code: 'engine_only',
              message: 'Změny bloků jen přes kalendář nebo plán směn',
            },
          };
          return;
        }
        if (
          deniedForStaff(path) ||
          queryTouchesSecret(ctx.request?.querystring || ctx.querystring || '') ||
          bodyTouchesSecret(ctx.request?.body)
        ) {
          denySecret(ctx);
          return;
        }
        const proxyToken = process.env.ADMIN_PROXY_API_TOKEN;
        if (proxyToken) {
          ctx.request.header.authorization = `Bearer ${proxyToken}`;
        } else if (!warned) {
          warned = true;
          strapi.log.warn(
            'admin-session: ADMIN_PROXY_API_TOKEN не задан — запросы админки к коллекциям будут отклонены'
          );
        }
        await next();
        stripSecret(ctx.body);
        return;
      }
    }
    await next();
  };
};
