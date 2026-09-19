// Источник брони (s200): чистое ядро без БД — чистка того, что прислал браузер,
// и классификация касания в канал для отчёта владельца.
//
// Касание (touch) = один заход на сайт извне: метки из URL + referrer + страница входа.
// Браузер держит два касания: first (самый первый заход, 90 дней) и last (последний
// НЕ прямой заход — прямой не перетирает платный источник). Оба приходят с бронью.

export const TOUCH_PARAM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'gad_source',
  'gad_campaignid',
  'fbclid',
  'sznclid',
  'msclkid',
] as const

type TouchParam = (typeof TOUCH_PARAM_KEYS)[number];

export type Touch = Partial<Record<TouchParam, string>> & {
  ts?: string;
  landing?: string;
  referrer?: string;
};

export interface Attribution {
  first?: Touch;
  last?: Touch;
  /** было ли согласие на cookies в момент брони (для справки, на хранение не влияет) */
  consent?: boolean;
  /** дозапись с thank-you: источник унаследован от этой брони */
  inheritedFrom?: string;
}

const MAX_LEN = 300;

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, MAX_LEN);
  return s || undefined;
};

const cleanTouch = (raw: unknown): Touch | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const t: Touch = {};
  for (const k of TOUCH_PARAM_KEYS) {
    const v = str(r[k]);
    if (v) t[k] = v;
  }
  const ts = str(r.ts);
  if (ts && !Number.isNaN(Date.parse(ts))) t.ts = new Date(ts).toISOString();
  const landing = str(r.landing);
  if (landing) t.landing = landing;
  const referrer = str(r.referrer);
  if (referrer) t.referrer = referrer;
  return Object.keys(t).length ? t : undefined;
};

/** Чистка того, что прислал браузер: только известные ключи, строки ≤300 символов. */
export function sanitizeAttribution(raw: unknown): Attribution | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const first = cleanTouch(r.first);
  const last = cleanTouch(r.last);
  if (!first && !last) return null;
  const out: Attribution = {};
  if (first) out.first = first;
  if (last) out.last = last;
  if (typeof r.consent === 'boolean') out.consent = r.consent;
  return out;
}

// ── каналы ──

export type ChannelKey =
  | 'google_ads'
  | 'meta_ads'
  | 'meta_click'
  | 'meta_organic'
  | 'sklik'
  | 'google_organic'
  | 'seznam_organic'
  | 'other_search'
  | 'email'
  | 'utm_other'
  | 'referral'
  | 'direct'
  | 'admin'
  | 'noona'
  | 'no_data';

export const CHANNEL_LABEL: Record<ChannelKey, string> = {
  google_ads: 'Google Ads',
  meta_ads: 'Meta — реклама (по UTM)',
  meta_click: 'Facebook / Instagram — клик (fbclid)',
  meta_organic: 'Facebook / Instagram — без метки',
  sklik: 'Sklik (реклама Seznam)',
  google_organic: 'Google — поиск и карты без рекламы',
  seznam_organic: 'Seznam — поиск без рекламы',
  other_search: 'Другие поисковики',
  email: 'E-mail рассылки',
  utm_other: 'Другие UTM-метки',
  referral: 'Другие сайты',
  direct: 'Прямой заход',
  admin: 'Записал администратор',
  noona: 'Noona',
  no_data: 'Сайт — источник не записан',
};

const META_SOURCES = ['facebook', 'fb', 'instagram', 'ig', 'meta', 'an', 'msg', 'threads'];
const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'paid-social', 'ads', 'ad', 'cpm', 'display', 'social_paid'];

const hostOf = (url?: string): string => {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const low = (v?: string) => (v || '').toLowerCase();

/** Канал одного касания. Порядок проверок важен: рекламные клики раньше органики. */
export function classifyTouch(t: Touch | undefined | null): ChannelKey {
  if (!t) return 'direct';
  const src = low(t.utm_source);
  const med = low(t.utm_medium);
  const paid = PAID_MEDIUMS.includes(med);
  const host = hostOf(t.referrer);

  if (t.gclid || t.gbraid || t.wbraid || t.gad_source || t.gad_campaignid) return 'google_ads';
  if (src === 'google' && paid) return 'google_ads';
  if (t.sznclid || src === 'sklik' || (src === 'seznam' && paid)) return 'sklik';
  if (META_SOURCES.includes(src) && paid) return 'meta_ads';
  if (t.fbclid) return 'meta_click';
  if (med === 'email' || med === 'e-mail' || src === 'newsletter' || src === 'email') return 'email';
  if (META_SOURCES.includes(src)) return 'meta_organic';
  if (src) return 'utm_other';

  if (/(^|\.)google\.[a-z.]+$/.test(host) || host === 'maps.app.goo.gl' || host.endsWith('.googleusercontent.com')) return 'google_organic';
  if (host === 'seznam.cz' || host.endsWith('.seznam.cz')) return 'seznam_organic';
  if (/(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|yandex\.[a-z]+)$/.test(host)) return 'other_search';
  if (/(^|\.)(facebook\.com|instagram\.com|fb\.com|fb\.me|messenger\.com|threads\.net)$/.test(host)) return 'meta_organic';
  if (host) return 'referral';
  return 'direct';
}

/** Подпись кампании внутри канала (для таблицы «по кампаниям»). */
export function campaignOf(t: Touch | undefined | null): string {
  if (!t) return '';
  if (t.utm_campaign) return t.utm_campaign;
  if (t.gad_campaignid) return `Google кампания #${t.gad_campaignid}`;
  if (t.utm_source) return [t.utm_source, t.utm_medium].filter(Boolean).join(' / ');
  const host = hostOf(t.referrer);
  return host || '';
}

/** Канал брони: админские и Noona-брони — свой канал; сайт — по касанию. */
export function bookingChannel(
  origin: string,
  attribution: Attribution | null | undefined,
  touch: 'first' | 'last'
): ChannelKey {
  if (origin === 'admin' || origin === 'calendar') return 'admin';
  if (origin === 'online' || origin === 'app') return 'noona';
  if (!attribution) return 'no_data';
  const t = touch === 'first' ? attribution.first || attribution.last : attribution.last || attribution.first;
  return classifyTouch(t);
}
