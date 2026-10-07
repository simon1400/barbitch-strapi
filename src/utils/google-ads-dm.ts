// Google Ads через Data Manager API (s243): отправка офлайн-конверсий из Strapi.
// Порт клиентского роута client/src/app/api/google-ads-conversion/route.ts — те же
// env-имена GOOGLE_DM_*, те же нормализация и хеши (между репо не импортируем, копия).
// Справка: https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest
//
// Модуль без Strapi и без БД: сборка события — чистая функция, сеть — через переданный
// fetch (в тестах заглушка). Env читается в момент вызова, не при импорте.

import crypto from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const INGEST_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';

/** Лимит API — 2000 событий на запрос. */
export const MAX_EVENTS_PER_REQUEST = 2000;

export interface DmConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  operatingAccountId: string;
  loginAccountId: string;
  validateOnly: boolean;
}

/** Конфиг из env; null — не настроено (тогда прогон тихо пропускается). */
export function dmConfig(env: Record<string, string | undefined> = process.env): DmConfig | null {
  const clientId = env.GOOGLE_DM_CLIENT_ID;
  const clientSecret = env.GOOGLE_DM_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_DM_REFRESH_TOKEN;
  const operatingAccountId = env.GOOGLE_DM_OPERATING_ACCOUNT_ID;
  if (!clientId || !clientSecret || !refreshToken || !operatingAccountId) return null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    operatingAccountId,
    loginAccountId: env.GOOGLE_DM_LOGIN_ACCOUNT_ID || operatingAccountId,
    validateOnly: env.GOOGLE_DM_VALIDATE_ONLY === 'true',
  };
}

export function hashHex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// E-mail: trim + lower (остальное Google нормализует сам).
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Телефон: E.164. Убираем оформление; без кода страны — чешский +420.
export function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s\-()]/g, '');
  if (!p.startsWith('+')) {
    p = `+420${p.replace(/^0+/, '')}`;
  }
  return p;
}

type Touch = { gclid?: string; gbraid?: string; wbraid?: string } | null | undefined;

/** Строка брони для сборки события (как её отдаёт выборка сервиса). */
export interface VisitRow {
  documentId: string;
  startsAt: string | Date | null;
  date: string;
  price: number;
  attribution: { first?: Touch; last?: Touch } | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Идентификаторы клика: из последнего касания, иначе из первого. Касание берётся
 * целиком (gclid одного захода с wbraid другого не смешиваем).
 */
export function clickIds(attribution: VisitRow['attribution']): Record<string, string> {
  const pick = (t: Touch) => {
    const out: Record<string, string> = {};
    for (const k of ['gclid', 'gbraid', 'wbraid'] as const) if (t?.[k]) out[k] = String(t[k]);
    return out;
  };
  const last = pick(attribution?.last);
  return Object.keys(last).length ? last : pick(attribution?.first);
}

/**
 * Событие «uskutečněná návštěva». null — нечем сопоставить (нет ни клика, ни контактов).
 * Время конверсии — начало визита (не время крона), но не позже `now`.
 */
export function buildVisitEvent(row: VisitRow, now: Date = new Date()): Record<string, unknown> | null {
  const userIdentifiers: Record<string, string>[] = [];
  const email = String(row.email || '').trim();
  const phone = String(row.phone || '').trim();
  if (email) userIdentifiers.push({ emailAddress: hashHex(normalizeEmail(email)) });
  if (phone) userIdentifiers.push({ phoneNumber: hashHex(normalizePhone(phone)) });
  const adIdentifiers = clickIds(row.attribution);
  if (!userIdentifiers.length && !Object.keys(adIdentifiers).length) return null;

  const startMs = row.startsAt ? new Date(row.startsAt).getTime() : NaN;
  const ts = Number.isFinite(startMs) ? Math.min(startMs, now.getTime()) : now.getTime();

  return {
    destinationReferences: ['google-ads'],
    transactionId: row.documentId,
    eventTimestamp: new Date(ts).toISOString(),
    eventSource: 'WEB',
    conversionValue: Math.round(Number(row.price) * 100) / 100,
    currency: 'CZK',
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
    ...(userIdentifiers.length > 0 && { userData: { userIdentifiers } }),
    ...(Object.keys(adIdentifiers).length > 0 && { adIdentifiers }),
  };
}

/** Тело запроса ingest для одного действия конверсии. */
export function ingestPayload(cfg: DmConfig, actionId: string, events: Record<string, unknown>[]) {
  return {
    destinations: [
      {
        reference: 'google-ads',
        loginAccount: { accountType: 'GOOGLE_ADS', accountId: cfg.loginAccountId },
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: cfg.operatingAccountId },
        productDestinationId: actionId,
      },
    ],
    events,
    encoding: 'HEX',
    validateOnly: cfg.validateOnly,
  };
}

type FetchLike = typeof fetch;

export async function getAccessToken(cfg: DmConfig, fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !json.access_token) throw new Error(`OAuth token error ${res.status}: ${JSON.stringify(json)}`);
  return String(json.access_token);
}

export interface IngestResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/** Один запрос ingest. Сетевую ошибку пробрасывает, HTTP-ошибку возвращает. */
export async function ingest(
  cfg: DmConfig,
  accessToken: string,
  actionId: string,
  events: Record<string, unknown>[],
  fetchImpl: FetchLike = fetch
): Promise<IngestResult> {
  const res = await fetchImpl(INGEST_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(ingestPayload(cfg, actionId, events)),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}
