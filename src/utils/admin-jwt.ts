/**
 * Lightweight HS256 JWT for the custom admin-user auth flow.
 *
 * Self-contained (Node `crypto`, no dependency, no new env var): the signing
 * secret falls back to the first APP_KEY, which is always configured in prod
 * (Strapi refuses to boot without APP_KEYS). Set ADMIN_JWT_SECRET to override.
 */
import crypto from 'crypto'

export interface AdminSession {
  id: number
  username: string
  role: 'owner' | 'administrator' | 'master'
}

export interface VerifiedSession extends AdminSession {
  iat: number
  exp: number
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

const getSecret = (): string => {
  const explicit = process.env.ADMIN_JWT_SECRET
  if (explicit && explicit.length > 0) return explicit
  const appKeys = (process.env.APP_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
  if (appKeys.length > 0) return appKeys[0]
  // Last-resort dev fallback so a local boot without env still works.
  return 'barbitch-admin-dev-secret-change-me'
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url')

export const signSession = (payload: AdminSession): string => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + SESSION_TTL_SECONDS }))
  const data = `${header}.${body}`
  const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

export const verifySession = (token: string | null | undefined): VerifiedSession | null => {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const data = `${header}.${body}`
  const expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url')

  // Timing-safe signature compare (lengths must match before timingSafeEqual).
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length) return null
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null

  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof decoded.exp !== 'number' || decoded.exp < Math.floor(Date.now() / 1000)) return null
    return decoded as VerifiedSession
  } catch {
    return null
  }
}

/**
 * Pull the Bearer token out of a Koa/Strapi request context.
 *
 * The `admin-session` global middleware swaps a valid admin session for the
 * server-side API token before routing (so core content routes authorise
 * without shipping that token to the browser). It stashes the original session
 * in `ctx.state.adminJwt` first — read that here, otherwise every custom
 * handler that gates on the session (engine, campaign, …) would stop seeing it.
 */
export const tokenFromCtx = (ctx: any): string | null => {
  const stashed: unknown = ctx?.state?.adminJwt
  if (typeof stashed === 'string' && stashed.length > 0) return stashed
  const auth: unknown = ctx?.request?.header?.authorization ?? ctx?.request?.headers?.authorization
  if (!auth || typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}
