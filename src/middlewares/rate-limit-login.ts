/**
 * In-memory per-IP + per-username rate limiter for /admin-users/login.
 *
 * No Redis dependency — a single PM2 Strapi process is enough to blunt
 * brute-force / credential stuffing. Two independent buckets so a brute-force
 * against one account is throttled (username bucket) and broad spraying is
 * caught (IP bucket), while legitimate staff never lock each other out.
 */
const WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_PER_USERNAME = 10
const MAX_PER_IP = 30

interface Bucket {
  count: number
  resetAt: number
}

const userBuckets = new Map<string, Bucket>()
const ipBuckets = new Map<string, Bucket>()

let lastSweep = 0
const sweep = (now: number) => {
  if (now - lastSweep < WINDOW_MS) return
  lastSweep = now
  for (const map of [userBuckets, ipBuckets]) {
    for (const [key, b] of map) {
      if (b.resetAt <= now) map.delete(key)
    }
  }
}

const hit = (map: Map<string, Bucket>, key: string, now: number): number => {
  let bucket = map.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS }
    map.set(key, bucket)
  }
  bucket.count += 1
  return bucket.count
}

export default (_config: unknown, { strapi }: { strapi: any }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const now = Date.now()
    sweep(now)

    const ip =
      ctx.request.ip ||
      String(ctx.request.header['x-forwarded-for'] || '').split(',')[0].trim() ||
      'unknown'
    const username = String(ctx.request.body?.username || '').toLowerCase().trim() || '?'

    const userCount = hit(userBuckets, username, now)
    const ipCount = hit(ipBuckets, ip, now)

    if (userCount > MAX_PER_USERNAME || ipCount > MAX_PER_IP) {
      const userBucket = userBuckets.get(username)
      const ipBucket = ipBuckets.get(ip)
      const resetAt = Math.max(userBucket?.resetAt ?? now, ipBucket?.resetAt ?? now)
      ctx.set('Retry-After', String(Math.ceil((resetAt - now) / 1000)))
      strapi?.log?.warn?.(
        `[rate-limit-login] blocked ip=${ip} user=${username} (u=${userCount} ip=${ipCount})`,
      )
      ctx.status = 429
      ctx.body = {
        error: {
          status: 429,
          name: 'TooManyRequests',
          message: 'Příliš mnoho pokusů o přihlášení. Zkuste to prosím později.',
        },
      }
      return
    }

    await next()
  }
}
