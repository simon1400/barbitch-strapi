/**
 * In-memory per-IP rate limiter для публичных ручек booking-engine
 * (availability/holds/bookings/cancel). Паттерн rate-limit-login (s78):
 * без Redis — один PM2-процесс. Лимит щадящий (календарь дат = много
 * availability-запросов), но режет скрейпинг/перебор.
 */
const WINDOW_MS = 5 * 60 * 1000 // 5 минут
const MAX_PER_IP = 300

interface Bucket {
  count: number
  resetAt: number
}

const ipBuckets = new Map<string, Bucket>()

let lastSweep = 0
const sweep = (now: number) => {
  if (now - lastSweep < WINDOW_MS) return
  lastSweep = now
  for (const [key, b] of ipBuckets) {
    if (b.resetAt <= now) ipBuckets.delete(key)
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

    let bucket = ipBuckets.get(ip)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + WINDOW_MS }
      ipBuckets.set(ip, bucket)
    }
    bucket.count += 1

    if (bucket.count > MAX_PER_IP) {
      ctx.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
      strapi?.log?.warn?.(`[rate-limit-engine] blocked ip=${ip} (${bucket.count})`)
      ctx.status = 429
      ctx.body = {
        error: { status: 429, name: 'TooManyRequests', message: 'Příliš mnoho požadavků. Zkuste to prosím později.' },
      }
      return
    }

    await next()
  }
}
