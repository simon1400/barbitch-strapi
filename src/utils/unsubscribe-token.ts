/**
 * Отписка от писем по ссылке (s271).
 *
 * Было: в письмах «Čas na další návštěvu», просьбе об отзыве и рассылках отписка
 * только ответом «NEZASÍLAT», флаг `client.reminderOptOut` владелец ставил руками.
 * Стало: в каждом письме ссылка `barbitch.cz/odhlasit/<token>` и заголовки
 * `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058, кнопка «Odhlásit» в Gmail).
 *
 * Токен = `<clientDocId>.<HMAC-SHA256 base64url, 128 бит>`. Срока нет: ссылка из
 * старого письма должна работать всегда. Подделать нельзя без секрета, перебрать —
 * тоже (128 бит). documentId клиента в токене открыт — он ничего не даёт.
 *
 * Секрет: `UNSUBSCRIBE_SECRET`, иначе `CLIENT_JWT_SECRET` (есть на проде). Ключ
 * выводится через HMAC с меткой «barbitch-unsubscribe-v1», поэтому токены отписки
 * не пересекаются с токенами кабинета. Нет ни одного секрета → ссылок нет, письма
 * уходят со старым текстом «NEZASÍLAT» (деплой безопасен).
 */
import crypto from 'crypto'

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://barbitch.cz'
const API_URL = process.env.URL || 'https://strapi.barbitch.cz'

/** Откуда пришёл человек: какое письмо. Пишется в журнал, в токен не входит. */
export const UNSUBSCRIBE_ORIGINS = ['comeback', 'review', 'campaign'] as const
export type UnsubscribeOrigin = (typeof UNSUBSCRIBE_ORIGINS)[number]

/** Причины в опросе после отписки (порядок = порядок на странице). */
export const UNSUBSCRIBE_REASONS = [
  'too_often',
  'not_interested',
  'not_coming',
  'other_salon',
  'never_signed',
  'other',
] as const
export type UnsubscribeReason = (typeof UNSUBSCRIBE_REASONS)[number]

export const UNSUBSCRIBE_COMMENT_MAX = 500

// documentId Strapi 5 — 24 символа [a-z0-9]; берём чуть шире, но без точки и слэша
const DOC_ID_RE = /^[A-Za-z0-9]{10,40}$/
const SIG_LEN = 22 // 16 байт в base64url

const rawSecret = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const s = env.UNSUBSCRIBE_SECRET || env.CLIENT_JWT_SECRET
  return s && s.length > 0 ? s : null
}

const keyOf = (secret: string): Buffer =>
  crypto.createHmac('sha256', secret).update('barbitch-unsubscribe-v1').digest()

const sigOf = (clientDocId: string, secret: string): string =>
  crypto.createHmac('sha256', keyOf(secret)).update(clientDocId).digest('base64url').slice(0, SIG_LEN)

export const unsubscribeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => rawSecret(env) !== null

export const signUnsubscribeToken = (
  clientDocId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const secret = rawSecret(env)
  if (!secret || !DOC_ID_RE.test(String(clientDocId || ''))) return null
  return `${clientDocId}.${sigOf(clientDocId, secret)}`
}

/** Проверенный documentId клиента или null. */
export const verifyUnsubscribeToken = (
  token: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const secret = rawSecret(env)
  if (!secret || typeof token !== 'string' || token.length > 80) return null
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const docId = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!DOC_ID_RE.test(docId) || sig.length !== SIG_LEN) return null
  const expected = Buffer.from(sigOf(docId, secret))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null
  return docId
}

export const originOf = (v: unknown): UnsubscribeOrigin | null =>
  (UNSUBSCRIBE_ORIGINS as readonly string[]).includes(String(v)) ? (v as UnsubscribeOrigin) : null

export const reasonOf = (v: unknown): UnsubscribeReason | null =>
  (UNSUBSCRIBE_REASONS as readonly string[]).includes(String(v)) ? (v as UnsubscribeReason) : null

export interface UnsubscribeLinks {
  /** страница на сайте: кнопка «Odhlásit», потом опрос */
  pageUrl: string
  /** POST-адрес для кнопки почтовика (RFC 8058) */
  oneClickUrl: string
  /** заголовки письма для Resend */
  headers: Record<string, string>
}

export const unsubscribeLinks = (
  clientDocId: string,
  origin: UnsubscribeOrigin,
  env: NodeJS.ProcessEnv = process.env,
): UnsubscribeLinks | null => {
  const token = signUnsubscribeToken(clientDocId, env)
  if (!token) return null
  const site = env.PUBLIC_SITE_URL || SITE_URL
  const api = env.URL || API_URL
  const pageUrl = `${site}/odhlasit/${token}?z=${origin}`
  const oneClickUrl = `${api}/api/unsubscribe/${token}?z=${origin}`
  return {
    pageUrl,
    oneClickUrl,
    headers: {
      'List-Unsubscribe': `<${oneClickUrl}>, <mailto:info@barbitch.cz?subject=NEZASILAT>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

/** «adela.janeskova@seznam.cz» → «ad•••@seznam.cz» — на странице без полного адреса. */
export const maskEmail = (email: unknown): string => {
  const s = String(email || '').trim()
  const at = s.lastIndexOf('@')
  if (at < 1) return ''
  const local = s.slice(0, at)
  const keep = local.length <= 2 ? 1 : 2
  return `${local.slice(0, keep)}•••${s.slice(at)}`
}
