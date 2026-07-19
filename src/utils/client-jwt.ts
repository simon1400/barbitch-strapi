/**
 * Lightweight HS256 JWT for the client cabinet auth flow (magic-link login).
 *
 * Копия admin-jwt.ts (node:crypto, timing-safe), но секрет = ТОЛЬКО env
 * CLIENT_JWT_SECRET — БЕЗ фолбэка на APP_KEYS, чтобы клиентские и админские
 * токены жили в разных ключевых пространствах. Нет env → кабинет выключен
 * (cabinetEnabled() = false, ручки отвечают 503) — деплой безопасен до настройки.
 */
import crypto from 'crypto'

export interface ClientSession {
  clientDocId: string
  email: string
}

export interface VerifiedClientSession extends ClientSession {
  iat: number
  exp: number
}

// Скользящая сессия (решение владельца К2): TTL 30 дней, визит в кабинет продлевает
// срок (/me переподписывает токен старше 7 дней) → пока клиентка заходит хотя бы
// раз в месяц, magic-link письмо ей больше не нужно.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 дней
const RENEW_AFTER_SECONDS = 60 * 60 * 24 * 7 // токен старше 7 дней → переподписать

const getSecret = (): string | null => {
  const secret = process.env.CLIENT_JWT_SECRET
  return secret && secret.length > 0 ? secret : null
}

/** Кабинет включён только при заданном CLIENT_JWT_SECRET. */
export const cabinetEnabled = (): boolean => getSecret() !== null

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url')

export const signClientSession = (payload: ClientSession): string => {
  const secret = getSecret()
  if (!secret) throw new Error('CLIENT_JWT_SECRET is not set')
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + SESSION_TTL_SECONDS }))
  const data = `${header}.${body}`
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${sig}`
}

export const verifyClientSession = (token: string | null | undefined): VerifiedClientSession | null => {
  const secret = getSecret()
  if (!secret) return null
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const data = `${header}.${body}`
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url')

  // Timing-safe signature compare (lengths must match before timingSafeEqual).
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length) return null
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null

  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof decoded.exp !== 'number' || decoded.exp < Math.floor(Date.now() / 1000)) return null
    if (typeof decoded.clientDocId !== 'string' || !decoded.clientDocId) return null
    return decoded as VerifiedClientSession
  } catch {
    return null
  }
}

/** Скользящее продление: пора ли переподписать валидный токен свежим exp. */
export const shouldRenewSession = (session: VerifiedClientSession): boolean =>
  typeof session.iat === 'number' &&
  Math.floor(Date.now() / 1000) - session.iat > RENEW_AFTER_SECONDS

/** Pull the Bearer token out of a Koa/Strapi request context. */
export const clientTokenFromCtx = (ctx: any): string | null => {
  const auth: unknown = ctx?.request?.header?.authorization ?? ctx?.request?.headers?.authorization
  if (!auth || typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}
