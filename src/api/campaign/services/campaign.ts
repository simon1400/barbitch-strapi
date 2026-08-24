// @ts-nocheck
// Отправка маркетинговых кампаний (win-back, birthday, window cross-sell).
//
// ЗАЧЕМ ЭТОТ СЛОЙ (s175). Раньше админка ходила напрямую в client-роут
// POST /api/send-bulk-email, который был открыт в интернет без авторизации:
// кто угодно мог слать до 100 писем за запрос от имени info@barbitch.cz на
// произвольные адреса. Спам с нашего верифицированного домена убивает
// доставляемость ВСЕХ писем салона — включая подтверждения броней.
// Плюс ни один из трёх путей отправки не проверял отписку: клиент, ответивший
// NEZASÍLAT, всё равно получал письмо со скидкой.
//
// Схема теперь: админка → ЭТА ручка (JWT владельца) → client-роут (серверный
// секрет CAMPAIGN_SEND_SECRET, в браузер он не попадает) → Resend.
// Фильтрация живёт ЗДЕСЬ, а не в UI: обойти её из браузера нельзя.
//
// Правовая модель (Чехия/ЕС, ZoEK §7): существующим клиентам можно писать про
// похожие услуги без предварительного согласия, если адрес получен в связи с
// оказанием услуги и в каждом письме есть простой отказ. Поэтому по умолчанию
// действует opt-out: режем reminderOptOut / blacklisted. Строгий режим
// (только явное marketingConsent) включается env CAMPAIGN_REQUIRE_CONSENT=true —
// сейчас согласие отметили 3 клиента из 1908, так что строгий режим означал бы
// фактическую остановку рассылок; выбор осознанно оставлен владельцу.

const CLIENT_UID = 'api::client.client';

// Белый список шаблонов = имена файлов в client/src/app/api/email-templates/.
// Нужен не только для порядка: client-роут подставляет имя в path.join, т.е.
// без списка «шаблон» вида ../../../secret читал бы посторонние .html с диска.
const TEMPLATES = new Set([
  'win-back',
  'birthday-discount',
  'window-cross-sell',
  'window-cross-sell-junior',
]);

const MAX_RECIPIENTS = 1000;

// Тот же критерий валидности адреса, что в review-request: «есть собака» мало,
// в базе лежат заглушки и опечатки с пробелом, а bounce бьёт по репутации домена.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

const CLIENT_URL = process.env.PUBLIC_SITE_URL || 'https://barbitch.cz';

export class CampaignError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// Все клиенты с почтой одной выборкой → карта lower(email) → флаги.
// Полный проход (≈1900 строк, 4 поля) вместо фильтра $in намеренно: $in в
// Postgres регистрозависим, а в базе адреса записаны вперемешку («Lenka.S@…»),
// и точечный запрос молча не нашёл бы часть клиентов — то есть пропустил бы
// отписавшихся. Кампании отправляются штучно, лишний запрос тут не жалко.
const loadClientFlags = async () => {
  const map = new Map();
  const PAGE = 500;
  for (let start = 0; ; start += PAGE) {
    const rows = await strapi.documents(CLIENT_UID).findMany({
      fields: ['name', 'email', 'blacklisted', 'reminderOptOut', 'marketingConsent'],
      start,
      limit: PAGE,
    });
    for (const c of rows) {
      const key = String(c.email || '').trim().toLowerCase();
      if (!key) continue;
      const prev = map.get(key);
      // одна почта может быть у нескольких карточек (дубли клиентов) —
      // берём СТРОГИЙ вариант: любой запрет по любой карточке запрещает
      map.set(key, {
        name: prev?.name || c.name || '',
        blacklisted: Boolean(prev?.blacklisted) || Boolean(c.blacklisted),
        reminderOptOut: Boolean(prev?.reminderOptOut) || Boolean(c.reminderOptOut),
        marketingConsent: Boolean(prev?.marketingConsent) || Boolean(c.marketingConsent),
      });
    }
    if (rows.length < PAGE) break;
  }
  return map;
};

export default {
  // recipients: [{ email, variables? }]; session — проверенная сессия владельца
  async send({ template, subject, recipients, source = 'admin' }, session) {
    if (!TEMPLATES.has(String(template || ''))) {
      throw new CampaignError(400, 'unknown_template', `Neznámá šablona: ${template}`);
    }
    if (!subject || typeof subject !== 'string') {
      throw new CampaignError(400, 'no_subject', 'Chybí předmět e-mailu');
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new CampaignError(400, 'no_recipients', 'Chybí příjemci');
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw new CampaignError(400, 'too_many', `Najednou lze odeslat max. ${MAX_RECIPIENTS} e-mailů`);
    }

    const secret = process.env.CAMPAIGN_SEND_SECRET;
    if (!secret) {
      throw new CampaignError(503, 'not_configured', 'CAMPAIGN_SEND_SECRET není nastaven');
    }

    const requireConsent = process.env.CAMPAIGN_REQUIRE_CONSENT === 'true';
    const flags = await loadClientFlags();

    const skipped = { invalid: 0, duplicate: 0, optOut: 0, blacklisted: 0, noConsent: 0 };
    // почему конкретный адрес не получил письмо — показываем владельцу в UI
    const skippedDetail = [];
    const seen = new Set();
    const accepted = [];

    for (const r of recipients) {
      const email = String(r?.email || '').trim();
      const key = email.toLowerCase();
      if (!EMAIL_RE.test(email)) { skipped.invalid += 1; skippedDetail.push({ email, reason: 'invalid' }); continue; }
      if (seen.has(key)) { skipped.duplicate += 1; continue; }
      seen.add(key);

      const f = flags.get(key);
      if (f?.blacklisted) { skipped.blacklisted += 1; skippedDetail.push({ email, reason: 'blacklisted' }); continue; }
      if (f?.reminderOptOut) { skipped.optOut += 1; skippedDetail.push({ email, reason: 'optOut' }); continue; }
      // строгий режим: нужен явный marketingConsent (адрес не из базы — тоже мимо)
      if (requireConsent && !f?.marketingConsent) {
        skipped.noConsent += 1;
        skippedDetail.push({ email, reason: 'noConsent' });
        continue;
      }
      accepted.push({ email, variables: r?.variables || {} });
    }

    if (accepted.length === 0) {
      return {
        total: recipients.length,
        successful: 0,
        failed: 0,
        skipped,
        skippedDetail,
        acceptedEmails: [],
        requireConsent,
      };
    }

    const res = await fetch(`${CLIENT_URL}/api/send-bulk-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-campaign-secret': secret },
      body: JSON.stringify({ template, subject, recipients: accepted }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new CampaignError(res.status === 403 ? 500 : res.status || 500,
        'send_failed', data?.error || `Odeslání selhalo (${res.status})`);
    }

    strapi.log.info(
      `campaign send by ${session?.username || '?'}: ${template} → ${data.successful ?? 0}/${accepted.length} sent, ` +
      `skipped ${JSON.stringify(skipped)} (source ${source})`
    );

    return {
      total: recipients.length,
      successful: data.successful ?? 0,
      failed: data.failed ?? 0,
      skipped,
      skippedDetail,
      acceptedEmails: accepted.map((a) => a.email),
      requireConsent,
    };
  },
};
