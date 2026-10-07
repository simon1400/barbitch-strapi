// @ts-nocheck
/**
 * Офлайн-конверсии в Google Ads (s243, план OFFLINE_CONVERSIONS_NEXT_SESSION_PROMPT.md):
 * состоявшийся визит → действие «Návštěva – uskutečněná (server-side)» с суммой.
 *
 * Кого шлём (все условия сразу): бронь `checkedOut`, не интерная, есть атрибуция
 * с согласием на cookies (`attribution.consent === true`, у дозаписи унаследовано),
 * цена > 0 (бесплатная коррекция — не конверсия), визит не раньше начала атрибуции
 * (19.09.2026) и в окне клика. gclid не обязателен — без него Google матчит по хешам
 * e-mail/телефона, как у формы «Lead». Отменённые и неявки не шлются никогда → отзыв
 * в Google не нужен.
 *
 * Сумма — `total_price` брони, та же цифра, что выручка в отчёте «Источники броней».
 *
 * Журнал — JSON `booking.adsConversion`:
 *   отправлено  { sentAt, actionId, transactionId, valueKc, validateOnly, requestId?, attempts }
 *   ошибка 400  { error, status, attempts, lastTryAt, validateOnly, actionId } — повтор до 3 раз
 *   нечем матчить { skipped: 'no_identifiers', checkedAt }
 *   откат закрытия после отправки → + revertedAt (в Google ничего не меняем, Фаза 2)
 * Записи пробного режима (`GOOGLE_DM_VALIDATE_ONLY=true`, validateOnly: true) при
 * переключении на боевой режим отправляются заново сами — ручная чистка не нужна.
 *
 * Сбой авторизации, 5xx и сеть ничего не пишут: прогон бросает ошибку, следующий
 * час повторит. Отказ всей пачки с 400 → те же события по одному, чтобы одна плохая
 * запись не держала остальные.
 */
import { MAX_EVENTS_PER_REQUEST, buildVisitEvent, dmConfig, getAccessToken, ingest } from '../../../utils/google-ads-dm';

/** Начало атрибуции броней (s200): раньше `attribution` нет. */
export const ATTRIBUTION_START = '2026-09-19';
/** Не старше стольки дней от сегодня: окно клика у действия 90 дней, с запасом. */
export const WINDOW_DAYS = 80;
export const MAX_ATTEMPTS = 3;
const DEFAULT_LIMIT = 200;
const ERR_MAX = 300;

const pragueDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
const shiftDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const jsonObj = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Причина, по которой бронь не конверсия; null — конверсия. Зеркало условий SQL. */
export function ineligibleReason(row) {
  if (row.status !== 'checkedOut') return 'not_checked_out';
  if (row.internal === true) return 'internal';
  if (!row.attribution) return 'no_attribution';
  if (row.attribution.consent !== true) return 'no_consent';
  if (!(Number(row.price) > 0)) return 'zero_price';
  if (!row.date || row.date < ATTRIBUTION_START) return 'before_attribution';
  return null;
}

/** Нужна ли (повторная) отправка при текущем режиме. Зеркало условий SQL. */
export function needsSend(ac, validateOnly) {
  if (!ac) return true;
  if (ac.skipped) return false;
  if (ac.sentAt) return ac.validateOnly === true && !validateOnly;
  if (Boolean(ac.validateOnly) !== validateOnly) return true;
  return (Number(ac.attempts) || 0) < MAX_ATTEMPTS;
}

const errText = (status, body) => {
  const msg = body?.error?.message || JSON.stringify(body || {});
  return `${status}: ${msg}`.slice(0, ERR_MAX);
};

const CANDIDATES_SQL = `
  select b.id, b.document_id, b.status, b.internal, b.starts_at,
    to_char(b.date, 'YYYY-MM-DD') as date,
    coalesce(b.total_price, 0)::float as price,
    b.attribution, b.ads_conversion, cl.email, cl.phone
  from bookings b
  left join lateral (
    select c.email, c.phone from bookings_client_lnk bc join clients c on c.id = bc.client_id
    where bc.booking_id = b.id limit 1
  ) cl on true
  where b.status = 'checkedOut'
    and coalesce(b.internal, false) = false
    and b.date between ?::date and ?::date
    and b.attribution->>'consent' = 'true'
    and coalesce(b.total_price, 0) > 0
    and (
      b.ads_conversion is null
      or (b.ads_conversion->>'skipped' is null and (
        (b.ads_conversion->>'sentAt' is null and (
          coalesce(b.ads_conversion->>'validateOnly', 'false') <> ?::text
          or coalesce((b.ads_conversion->>'attempts')::int, 0) < ?::int
        ))
        or (b.ads_conversion->>'sentAt' is not null and b.ads_conversion->>'validateOnly' = 'true' and ?::text = 'false')
      ))
    )
  order by b.date, b.id
  limit ?
`;

// отправленные боевые конверсии, чья бронь ушла из checkedOut («Vrátit uzavření», смена статуса)
const REVERTED_SQL = `
  select id, document_id, ads_conversion from bookings
  where ads_conversion->>'sentAt' is not null
    and ads_conversion->>'revertedAt' is null
    and coalesce(ads_conversion->>'validateOnly', 'false') = 'false'
    and status <> 'checkedOut'
`;

export default {
  /**
   * Один прогон крона. Возвращает сводку; бросает при сбое авторизации/сети/5xx.
   * `env`/`fetchImpl` — для тестов.
   */
  async run({ now = new Date(), limit = DEFAULT_LIMIT, env = process.env, fetchImpl = fetch } = {}) {
    const cfg = dmConfig(env);
    const actionId = env.GOOGLE_DM_CONVERSION_ACTION_VISIT;
    if (!cfg || !actionId) return { skipped: 'not_configured' };

    const knex = strapi.db.connection;
    const write = (id, obj) =>
      knex.raw('update bookings set ads_conversion = ?::jsonb where id = ?', [JSON.stringify(obj), id]);
    const nowIso = now.toISOString();
    const mode = String(cfg.validateOnly);

    // 1) откаты закрытия после отправки — только пометка
    const rev = await knex.raw(REVERTED_SQL);
    for (const r of rev.rows) {
      await write(r.id, { ...jsonObj(r.ads_conversion), revertedAt: nowIso });
      strapi.log.warn(`ads-conversions: visit ${r.document_id} left checkedOut after the conversion was sent (not retracted in Google)`);
    }

    // 2) кандидаты
    const today = pragueDate(now);
    const floor = shiftDays(today, -WINDOW_DAYS);
    const from = floor > ATTRIBUTION_START ? floor : ATTRIBUTION_START;
    const res = await knex.raw(CANDIDATES_SQL, [from, today, mode, MAX_ATTEMPTS, mode, Math.min(limit, MAX_EVENTS_PER_REQUEST)]);

    const items = [];
    let skipped = 0;
    for (const r of res.rows) {
      const row = {
        id: r.id,
        documentId: r.document_id,
        status: r.status,
        internal: r.internal,
        startsAt: r.starts_at,
        date: r.date,
        price: Number(r.price) || 0,
        attribution: jsonObj(r.attribution),
        email: r.email,
        phone: r.phone,
      };
      const ac = jsonObj(r.ads_conversion);
      if (ineligibleReason(row) || !needsSend(ac, cfg.validateOnly)) continue;
      const event = buildVisitEvent(row, now);
      if (!event) {
        await write(row.id, { skipped: 'no_identifiers', checkedAt: nowIso });
        skipped += 1;
        continue;
      }
      // попытки считаются в пределах режима: после пробного прогона боевой начинает с нуля
      const prevAttempts = ac && !ac.sentAt && Boolean(ac.validateOnly) === cfg.validateOnly ? Number(ac.attempts) || 0 : 0;
      items.push({ row, event, attempts: prevAttempts + 1 });
    }

    const summary = { candidates: items.length, sent: 0, failed: 0, skipped, reverted: rev.rows.length, validateOnly: cfg.validateOnly };
    if (!items.length) return summary;

    const token = await getAccessToken(cfg, fetchImpl);
    const markSent = (it, body) =>
      write(it.row.id, {
        sentAt: nowIso,
        actionId,
        transactionId: it.row.documentId,
        valueKc: it.event.conversionValue,
        validateOnly: cfg.validateOnly,
        ...(body?.requestId && { requestId: String(body.requestId) }),
        attempts: it.attempts,
      });
    const markFailed = (it, status, body) =>
      write(it.row.id, { error: errText(status, body), status, attempts: it.attempts, lastTryAt: nowIso, validateOnly: cfg.validateOnly, actionId });
    const hardFail = (status, body) => new Error(`Data Manager API error ${errText(status, body)}`);

    const batch = await ingest(cfg, token, actionId, items.map((it) => it.event), fetchImpl);
    if (batch.ok) {
      for (const it of items) await markSent(it, batch.body);
      summary.sent = items.length;
      if (batch.body?.fieldWarnings?.length) strapi.log.warn(`ads-conversions: field warnings ${JSON.stringify(batch.body.fieldWarnings).slice(0, 1000)}`);
      return summary;
    }
    if (batch.status !== 400) throw hardFail(batch.status, batch.body);

    // пачку отвергли целиком из-за данных — по одному
    if (items.length === 1) {
      await markFailed(items[0], batch.status, batch.body);
      summary.failed = 1;
      strapi.log.error(`ads-conversions: ${items[0].row.documentId} rejected ${errText(batch.status, batch.body)}`);
      return summary;
    }
    for (const it of items) {
      const one = await ingest(cfg, token, actionId, [it.event], fetchImpl);
      if (one.ok) {
        await markSent(it, one.body);
        summary.sent += 1;
      } else if (one.status === 400) {
        await markFailed(it, one.status, one.body);
        summary.failed += 1;
        strapi.log.error(`ads-conversions: ${it.row.documentId} rejected ${errText(one.status, one.body)}`);
      } else {
        throw hardFail(one.status, one.body);
      }
    }
    return summary;
  },
};
