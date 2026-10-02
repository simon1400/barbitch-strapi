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
 *
 * С тех пор правила ниже закрывают конкретные коллекции (s182, s218, s221, s223),
 * а с s223 сессия на каждом запросе сверяется с учёткой в базе (utils/admin-account):
 * отключение, смена роли или логина гасят её сразу, а не через 7 дней.
 */

import { tokenFromCtx, verifySession } from '../utils/admin-jwt';
import { loadAdminAccount, sessionMismatch } from '../utils/admin-account';

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

// 🟥 Регистр (s223). Роутер Strapi (@koa/router, `sensitive: false`) сопоставляет пути
// БЕЗ учёта регистра: `/API/Time-Blocks` попадает в тот же роут, что `/api/time-blocks`.
// Сравнение по имени коллекции как есть пропускало такие запросы мимо всех правил ниже
// (s182, s218, s221), а `/API/...` — мимо middleware целиком. Поэтому путь сравнивается
// только в нижнем регистре. Закодированные буквы (`%70ersonals`) роутер не раскодирует —
// такой путь не совпадает ни с одним роутом.
const segmentsOf = (path: string): string[] => path.toLowerCase().slice('/api/'.length).split(/[?]/)[0].split('/');

const collectionOf = (path: string): string => segmentsOf(path)[0];

// 🟥 Роль MASTER — БЕЛЫЙ список коллекций (s229, план «Карточка сотрудника» §15.4).
//
// Кабинет мастера читал `/api/penalties`, `/api/add-moneys`, `/api/payrolls` и
// `/api/personals?populate=offersDone` прямым REST, а фильтр «только мои» ставил браузер:
// мастер снимал его и читал выплаты, штрафы, доплаты и заработок коллег. Кабинет теперь
// ходит в ручку движка `/api/engine/admin/my-month` (карточку сессии определяет сервер),
// а роли master из коллекций (content-types `api::*` и пользователи плагина) открыты
// только те, что читают её два экрана — календарь и кабинет:
//   personals      — список мастеров календаря (с ограничениями ниже);
//   salon-hours, time-blocks, shifts — сетка дня/недели и дежурный администратор;
//   salon-services — каталог (карточки услуг в шторке брони);
//   admin-users    — вход и свой статус (свои правила ниже, s223).
// Всё остальное (деньги, ваучеры, журналы, токены клиентов, отпуска коллег) — 403.
// Кастомные ручки (`/api/engine/**`, дедупликация и т. п.) не задеты: у них свои гейты.
export const MASTER_COLLECTIONS = new Set(['personals', 'salon-hours', 'time-blocks', 'shifts', 'salon-services', 'admin-users']);

/** Имена коллекций REST (plural и singular типов `api::*` + пользователи плагина), в нижнем регистре. */
export const contentCollectionsOf = (contentTypes: Record<string, any> | undefined): Set<string> => {
  const out = new Set<string>(['users']);
  for (const ct of Object.values(contentTypes || {})) {
    if (!String(ct?.uid || '').startsWith('api::')) continue;
    for (const n of [ct?.info?.pluralName, ct?.info?.singularName]) if (n) out.add(String(n).toLowerCase());
  }
  return out;
};

export const deniedForMaster = (path: string, collections: Set<string> = new Set()): boolean => {
  const c = collectionOf(path);
  if (MASTER_DENIED.has(c)) return true;
  return collections.has(c) && !MASTER_COLLECTIONS.has(c);
};

// `/api/personals` для мастера (s229): только чтение списка для календаря.
//   • query — только известные ключи: фильтры по полям календаря, fields из списка ниже,
//     сортировка по имени/порядку, пагинация, статус. `populate` и фильтр/сортировка по
//     деньгам (`ratePercent` сортировкой подбирался бы у коллег по порядку) — 403;
//   • ответ — у чужих карточек только поля календаря, процент — только у своей
//     (своя = связь учётки из базы; у учётки без связи — имя = логин, как до s229).
export const MASTER_PERSONAL_FIELDS = new Set(['name', 'noonaEmployeeId', 'tier', 'calendarOrder', 'ratePercent', 'position', 'isActive']);
const MASTER_PERSONAL_FILTERS = new Set(['isActive', 'position', 'documentId', 'name', 'noonaEmployeeId', 'tier']);
const MASTER_PERSONAL_SORT = new Set(['name', 'calendarOrder']);
const MASTER_PERSONAL_KEEP = new Set([
  'id', 'documentId', 'name', 'noonaEmployeeId', 'tier', 'calendarOrder', 'position', 'isActive',
  'createdAt', 'updatedAt', 'publishedAt', 'locale',
]);

export const deniedMasterPersonalsQuery = (querystring: string): boolean => {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(String(querystring || ''));
  } catch {
    return true;
  }
  for (const [key, value] of params) {
    let m: RegExpExecArray | null;
    if ((m = /^filters\[([A-Za-z]+)\]\[\$(eq|eqi|ne|in|null|notNull)\](\[\d+\])?$/.exec(key))) {
      if (!MASTER_PERSONAL_FILTERS.has(m[1])) return true;
    } else if (/^fields(\[\d+\])?$/.test(key)) {
      if (value.split(',').some((f) => !MASTER_PERSONAL_FIELDS.has(f.trim()))) return true;
    } else if (/^sort(\[\d+\])?$/.test(key)) {
      if (value.split(',').some((f) => !MASTER_PERSONAL_SORT.has(f.trim().split(':')[0]))) return true;
    } else if (/^pagination\[(page|pageSize|start|limit|withCount)\]$/.test(key)) {
      continue;
    } else if (key === 'status' || key === 'locale') {
      continue;
    } else {
      return true;
    }
  }
  return false;
};

/** Проекция ответа `/api/personals` для мастера (меняет на месте). */
export const projectPersonalsForMaster = (body: unknown, own: { docId: string; username: string }): void => {
  const data = isPlain(body) ? (body as Record<string, unknown>).data : undefined;
  const rows = Array.isArray(data) ? data : isPlain(data) ? [data] : [];
  const name = own.username.trim().toLowerCase();
  for (const row of rows) {
    if (!isPlain(row)) continue;
    const r = row as Record<string, unknown>;
    const mine = own.docId ? r.documentId === own.docId : !!name && String(r.name ?? '').trim().toLowerCase() === name;
    for (const k of Object.keys(r)) {
      if (MASTER_PERSONAL_KEEP.has(k) || (mine && k === 'ratePercent')) continue;
      delete r[k];
    }
  }
};

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

// 🟥 Затраты (s236, план EXPENSES §3.7). Админка пишет затраты только ручками движка
// (`/api/engine/admin/costs`): там белый список полей, автор, журнал и одобрение
// владельцем правок управляющей. Прямой REST `POST/PUT/DELETE /api/costs` обходил всё
// это, а администратор (full-access токен) мог так завести или стереть любую затрату.
//   1. `costs` — только чтение для ЛЮБОЙ сессии сотрудника (итоги месяца читают REST).
//   2. Роль ADMINISTRATOR: `costs` и журнал `calendar-logs` закрыты целиком, чтение тоже
//      (решение владельца: затраты администраторам не показывать). Кабинет администратора
//      больше не грузит данные месяца — график «Записи» берёт брони напрямую.
// Мастеру оба уже закрыты белым списком (s229). Панель Strapi (/admin/**) не задета.
const ENGINE_WRITE_ONLY = new Set(['costs']);
export const ADMINISTRATOR_DENIED = new Set(['costs', 'calendar-logs']);

export const deniedCostWrite = (path: string, method: string): boolean =>
  ENGINE_WRITE_ONLY.has(collectionOf(path)) && !READ_METHODS.has(String(method || 'GET').toUpperCase());

export const deniedForAdministrator = (path: string): boolean => ADMINISTRATOR_DENIED.has(collectionOf(path));

// 🟥 Журнал действий (s240, «Výkaz práce» Фаза 2). По `calendar-logs` строится сводка
// «Systém zaznamenal» под отчётом управляющей — `POST /api/calendar-logs` с чужим или своим
// `actorName` подделал бы её (сессия получает full-access токен). Пишет журнал только сервер
// (calendar-log.write из ручек движка); админка его лишь читает и чистит из модалки —
// поэтому создание и правка закрыты ЛЮБОЙ сессии. Удалять записи может только ВЛАДЕЛЕЦ
// (решение владельца 02.10.2026, §10.4.1 плана): иначе управляющая убирала бы свои же
// действия из сводки под своим отчётом. Чтение — как было.
const JOURNAL = 'calendar-logs';
const JOURNAL_WRITE = new Set(['POST', 'PUT', 'PATCH']);

export const deniedJournalWrite = (path: string, method: string, role: string): boolean => {
  if (collectionOf(path) !== JOURNAL) return false;
  const m = String(method || 'GET').toUpperCase();
  return JOURNAL_WRITE.has(m) || (m === 'DELETE' && role !== 'owner');
};

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

// 🟥 Учётки и карточки сотрудников (s223, план «Карточка сотрудника» §3.9).
//
// Сессия получает права full-access токена, а у `admin-user` и `personal` есть штатный
// REST. Поэтому любой сотрудник мог `PUT /api/admin-users/<id>` с `{role:'owner'}` или
// новым паролем владельца (`GET /api/admin-users` отдавал все логины и роли), а мастер —
// `PUT /api/personals/<id>` со своим процентом, ставкой или `isActive`.
//   1. `/api/admin-users` — сессиям только три кастомные ручки (вход, свой статус,
//      кабинет администратора); остальное 403. Метод и число сегментов сверяются точно:
//      `PUT /api/admin-users/login` иначе попал бы в штатный `PUT /admin-users/:id`.
//   2. `/api/personals` — чтение как было. Запись: мастеру — никакой; остальным — только
//      `PUT /api/personals/<documentId>` с `{ data }` из трёх ключей, которые пишут
//      существующие экраны: каталог (`services`), «Pořadí» календаря (`calendarOrder`),
//      приоритет мастеров (`bookingPriority`). Создание, удаление, прочие поля — 403.
// Панель Strapi (/admin/**) не задета — владелец правит учётки и карточки там же.
const ADMIN_USERS_OPEN: ReadonlyArray<{ method: string; segment: string; length: number }> = [
  { method: 'POST', segment: 'login', length: 2 },
  { method: 'GET', segment: 'check-status', length: 3 },
  { method: 'GET', segment: 'administrator-data', length: 3 },
];

const methodOf = (method: string): string => String(method || 'GET').toUpperCase();

export const deniedAdminUsers = (path: string, method: string): boolean => {
  const seg = segmentsOf(path);
  if (seg[0] !== 'admin-users') return false;
  const m = methodOf(method);
  return !ADMIN_USERS_OPEN.some(
    (r) => (r.method === m || (r.method === 'GET' && m === 'HEAD')) && seg[1] === r.segment && seg.length === r.length && seg.every(Boolean)
  );
};

export const PERSONAL_WRITABLE = new Set(['calendarOrder', 'services', 'bookingPriority']);

export const deniedPersonalWrite = (path: string, method: string, role: string, body: unknown): boolean => {
  const seg = segmentsOf(path);
  if (seg[0] !== 'personals') return false;
  const m = methodOf(method);
  if (READ_METHODS.has(m)) return false;
  if (role === 'master') return true;
  if (m !== 'PUT' || seg.length !== 2 || !seg[1]) return true;
  if (!isPlain(body)) return true;
  const top = Object.keys(body as Record<string, unknown>);
  if (top.length !== 1 || top[0] !== 'data') return true;
  const data = (body as Record<string, unknown>).data;
  if (!isPlain(data)) return true;
  const keys = Object.keys(data as Record<string, unknown>);
  return keys.length === 0 || keys.some((k) => !PERSONAL_WRITABLE.has(k));
};

const denyStaffData = (ctx: any) => {
  ctx.status = 403;
  ctx.body = {
    error: {
      status: 403,
      code: 'staff_data_closed',
      message: 'Účty a karty zaměstnanců se mění jen v administraci Strapi',
    },
  };
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
  let collections: Set<string> | null = null;
  const contentCollections = () => (collections ||= contentCollectionsOf(strapi?.contentTypes));
  return async (ctx: any, next: () => Promise<void>) => {
    const path: string = ctx?.request?.path || ctx?.path || '';
    // регистр — см. segmentsOf: `/API/engine/...` роутер тоже принимает
    if (!path.toLowerCase().startsWith('/api/')) {
      await next();
      return;
    }
    const raw = tokenFromCtx(ctx);
    if (raw) {
      const session = verifySession(raw);
      if (session && STAFF_ROLES.has(session.role)) {
        // s223: учётка отключена / роль или логин сменились — сессия больше не годится,
        // на ЛЮБОМ /api/** (коллекции, ручки движка, кабинеты). См. utils/admin-account.
        let account;
        try {
          account = await loadAdminAccount(strapi, session.id);
        } catch (err: any) {
          strapi.log.error(`admin-session: учётка ${session.id} не прочиталась: ${err?.message || err}`);
          ctx.status = 503;
          ctx.body = {
            error: { status: 503, code: 'session_check_failed', message: 'Nepodařilo se ověřit přihlášení, zkuste to znovu' },
          };
          return;
        }
        const mismatch = sessionMismatch(session, account);
        if (mismatch) {
          ctx.status = 401;
          ctx.body = {
            error: {
              status: 401,
              code: 'session_revoked',
              reason: mismatch,
              message: 'Přihlášení už neplatí, přihlaste se znovu',
            },
          };
          return;
        }
        // сохраняем ДО подмены — иначе гейты собственных ручек ослепнут
        ctx.state.adminJwt = raw;
        ctx.state.adminSession = session;
        // s229 (§5а.1): связь учётки с карточкой — из базы, не из токена (см. sessionFromCtx)
        ctx.state.adminPersonalDocId = account?.personalDocId || null;
        const isMaster = session.role === 'master';
        const isPersonals = collectionOf(path) === 'personals';
        if (isMaster && deniedForMaster(path, contentCollections())) {
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
        if (session.role === 'administrator' && deniedForAdministrator(path)) {
          ctx.status = 403;
          ctx.body = {
            error: { status: 403, code: 'forbidden_for_administrator', message: 'Tato data jsou dostupná jen vedení salonu' },
          };
          return;
        }
        if (deniedJournalWrite(path, ctx.request?.method || ctx.method, session.role)) {
          ctx.status = 403;
          ctx.body = {
            error: { status: 403, code: 'engine_only', message: 'Deník zapisuje jen systém, mazat záznamy může jen majitel' },
          };
          return;
        }
        if (deniedCostWrite(path, ctx.request?.method || ctx.method)) {
          ctx.status = 403;
          ctx.body = {
            error: { status: 403, code: 'engine_only', message: 'Náklady se mění jen v administraci (modul Náklady)' },
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
        if (
          deniedAdminUsers(path, ctx.request?.method || ctx.method) ||
          deniedPersonalWrite(path, ctx.request?.method || ctx.method, session.role, ctx.request?.body)
        ) {
          denyStaffData(ctx);
          return;
        }
        // после проверки oficial (s221) — у неё свой код ошибки
        if (isMaster && isPersonals && deniedMasterPersonalsQuery(ctx.request?.querystring || ctx.querystring || '')) {
          ctx.status = 403;
          ctx.body = {
            error: { status: 403, code: 'forbidden_for_master', message: 'Tato data jsou dostupná jen přes kalendář' },
          };
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
        if (isMaster && isPersonals) {
          projectPersonalsForMaster(ctx.body, { docId: ctx.state.adminPersonalDocId || '', username: session.username || '' });
        }
        return;
      }
    }
    await next();
  };
};
