/**
 * Сверка сессии сотрудника с его учёткой в базе (s223, план «Карточка сотрудника» §3.6).
 *
 * 🟥 ЗАЧЕМ. Сессия — подписанный JWT на 7 дней, и до s223 сервер верил ему целиком:
 * `verifySession` смотрит только подпись и срок. Отключённая учётка (`isActive=false`)
 * продолжала ходить в API до истечения токена — выход делал лишь опрос `check-status`
 * в браузере, а сохранённый токен из DevTools работал дальше. Так же роль и логин
 * в токене оставались старыми после их смены в базе.
 *
 * КАК. Middleware `admin-session` (он стоит на всех `/api/**`, включая ручки движка)
 * для каждой сессии сверяет учётку: активна, роль и логин те же, что в токене.
 * Иначе — 401, админка на 401 сама зовёт `check-status` и разлогинивает.
 * Смена роли или логина тоже требует перезахода — токен со старой ролью не годится.
 *
 * Кэш в памяти процесса на 30 с по id, чтобы не ходить в базу на каждый запрос;
 * правка учётки (lifecycle `admin-user`, будущая карточка сотрудника) сбрасывает его
 * сразу — отключение действует с первого же запроса, а не через 30 с.
 */

export interface AdminAccount {
  isActive: boolean | null
  role: string | null
  username: string | null
  /** связь учётки с карточкой сотрудника (s229, §5а.1); null — связи нет */
  personalDocId: string | null
}

export const ACCOUNT_CACHE_TTL_MS = 30_000

type Entry = { at: number; account: AdminAccount | null }

const cache = new Map<number, Entry>()
const inflight = new Map<number, Promise<AdminAccount | null>>()
// Поколение кэша: чтение, начатое ДО сброса, не должно положить в кэш устаревший
// ответ (иначе отключение «откатилось» бы на 30 с).
let generation = 0

/** Сбросить кэш учёток (все — без аргумента). Зовётся при любой правке `admin-user`. */
export const invalidateAdminAccount = (id?: number | string | null): void => {
  generation += 1
  if (id === undefined || id === null) {
    cache.clear()
    inflight.clear()
    return
  }
  const n = Number(id)
  cache.delete(n)
  inflight.delete(n)
}

/**
 * Причина, по которой сессия больше не годится, или null — всё сходится.
 * Учётку без `isActive === true` не пускаем: логин тоже требует `isActive: true`.
 */
export const sessionMismatch = (
  session: { role: string; username: string; personalDocId?: unknown },
  account: AdminAccount | null,
): string | null => {
  if (!account) return 'account_missing'
  if (account.isActive !== true) return 'account_disabled'
  if (account.role !== session.role) return 'role_changed'
  if (account.username !== session.username) return 'username_changed'
  // s229: токен со связью, а связь в базе другая или снята — админка показывала бы
  // чужую колонку/кабинет. Токен без поля (выдан до s229 или учётке без связи) —
  // не повод: сервер связь всё равно берёт из базы.
  if (session.personalDocId !== undefined && (account.personalDocId || '') !== String(session.personalDocId || '')) {
    return 'personal_changed'
  }
  return null
}

const readAccount = async (strapi: any, id: number): Promise<AdminAccount | null> => {
  const row = await strapi.db.query('api::admin-user.admin-user').findOne({
    where: { id },
    select: ['id', 'isActive', 'role', 'username', 'personalDocId'],
  })
  if (!row) return null
  const personalDocId = typeof row.personalDocId === 'string' && row.personalDocId.trim() ? row.personalDocId.trim() : null
  return { isActive: row.isActive ?? null, role: row.role ?? null, username: row.username ?? null, personalDocId }
}

/** Учётка по id (с кэшем). Ошибка базы пробрасывается и в кэш не попадает. */
export const loadAdminAccount = async (strapi: any, id: number, now = Date.now()): Promise<AdminAccount | null> => {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) return null
  const hit = cache.get(n)
  if (hit && now - hit.at < ACCOUNT_CACHE_TTL_MS) return hit.account
  const pending = inflight.get(n)
  if (pending) return pending
  const gen = generation
  const p = readAccount(strapi, n)
    .then((account) => {
      if (gen === generation) cache.set(n, { at: now, account })
      return account
    })
    .finally(() => {
      if (inflight.get(n) === p) inflight.delete(n)
    })
  inflight.set(n, p)
  return p
}
