/**
 * In-memory rate limiter для ручек личного кабинета клиента (/api/cabinet/*).
 * Паттерн rate-limit-login (s78) + rate-limit-engine: без Redis — один
 * PM2-процесс. Два режима по роуту:
 *  - POST /api/cabinet/login — строгий: per-email 5/15мин + per-IP 20/15мин
 *    (magic-link рассылает письма → режем спам/перебор email-ов);
 *  - остальные ручки кабинета — щадящий per-IP 300/5мин.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000 // 15 минут
const MAX_LOGIN_PER_EMAIL = 5
const MAX_LOGIN_PER_IP = 20

const GENERAL_WINDOW_MS = 5 * 60 * 1000 // 5 минут
const MAX_GENERAL_PER_IP = 300

interface Bucket {
  count: number
  resetAt: number
}

const emailBuckets = new Map<string, Bucket>()
const loginIpBuckets = new Map<string, Bucket>()
const generalIpBuckets = new Map<string, Bucket>()

let lastSweep = 0
const sweep = (now: number) => {
  if (now - lastSweep < GENERAL_WINDOW_MS) return
  lastSweep = now
  for (const map of [emailBuckets, loginIpBuckets, generalIpBuckets]) {
    for (const [key, b] of map) {
      if (b.resetAt <= now) map.delete(key)
    }
  }
}

const hit = (map: Map<string, Bucket>, key: string, now: number, windowMs: number): Bucket => {
  let bucket = map.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    map.set(key, bucket)
  }
  bucket.count += 1
  return bucket
}

const tooMany = (ctx: any, strapi: any, resetAt: number, now: number, detail: string) => {
  ctx.set('Retry-After', String(Math.ceil((resetAt - now) / 1000)))
  strapi?.log?.warn?.(`[rate-limit-cabinet] blocked ${detail}`)
  ctx.status = 429
  ctx.body = {
    error: {
      status: 429,
      name: 'TooManyRequests',
      message: 'Příliš mnoho požadavků. Zkuste to prosím později.',
    },
  }
}

export default (_config: unknown, { strapi }: { strapi: any }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const now = Date.now()
    sweep(now)

    const ip =
      ctx.request.ip ||
      String(ctx.request.header['x-forwarded-for'] || '').split(',')[0].trim() ||
      'unknown'

    const isLogin =
      ctx.request.method === 'POST' && String(ctx.request.path || '').endsWith('/cabinet/login')

    if (isLogin) {
      const email = String(ctx.request.body?.email || '').toLowerCase().trim() || '?'
      const emailBucket = hit(emailBuckets, email, now, LOGIN_WINDOW_MS)
      const ipBucket = hit(loginIpBuckets, ip, now, LOGIN_WINDOW_MS)
      if (emailBucket.count > MAX_LOGIN_PER_EMAIL || ipBucket.count > MAX_LOGIN_PER_IP) {
        const resetAt = Math.max(emailBucket.resetAt, ipBucket.resetAt)
        tooMany(ctx, strapi, resetAt, now, `login ip=${ip} email=${email} (e=${emailBucket.count} ip=${ipBucket.count})`)
        return
      }
    } else {
      const bucket = hit(generalIpBuckets, ip, now, GENERAL_WINDOW_MS)
      if (bucket.count > MAX_GENERAL_PER_IP) {
        tooMany(ctx, strapi, bucket.resetAt, now, `ip=${ip} (${bucket.count})`)
        return
      }
    }

    await next()
  }
}
