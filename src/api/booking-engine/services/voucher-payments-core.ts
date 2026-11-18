// Čistá logika plateb voucherů kartou přes Comgate (s275, bez Strapi a sítě).
// Služba: voucher-payments.ts; testy: tests/voucher-payments-core.test.mjs.
//
// Comgate REST API v2.0 (apidoc.comgate.cz, ověřeno 24.10.2026): JSON, Basic auth
// merchant:secret, částka v haléřích, label 1–16 znaků, push = POST se `secret`
// v těle, stav se vždy ověřuje dotazem GET /v2.0/payment/transId/{transId}.json.

/** Vouchery na částku — musí sedět s AMOUNT_VOUCHERS v client/src/lib/vouchers.ts (hlídá test). */
export const AMOUNT_VOUCHERS = [500, 1000, 1500, 2000] as const;

export const FOR_NAME_MAX = 18;
export const FROM_NAME_MAX = 24;
export const EMAIL_MAX = 120;
/** Neuhrazená objednávka: platba v Comgate i záznam u nás žije 24 h (rozhodnutí majitele 24.10). */
export const PAYMENT_EXPIRATION_HOURS = 24;
/** Comgate: label 1–16 znaků. */
export const PAYMENT_LABEL = 'Dárkový voucher';

export const PAYMENT_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

export interface CatalogItem {
  /** `castka-1000` | `sluzba-<documentId služby>` — stejné id jako na webu. */
  id: string;
  kind: 'castka' | 'sluzba';
  price: number;
  /** Název služby (voucher na službu) — tiskne se do PDF a ukládá do `voucher.serviceName`. */
  serviceName: string | null;
}

/** Katalog = vouchery na službu ze Strapi (už s cenou) + částky. */
export const buildCatalog = (serviceVouchers: { id: string; name: string; price: number }[] | null | undefined): CatalogItem[] => [
  ...(serviceVouchers ?? []).map((s) => ({ id: s.id, kind: 'sluzba' as const, price: Number(s.price), serviceName: s.name })),
  ...AMOUNT_VOUCHERS.map((a) => ({ id: `castka-${a}`, kind: 'castka' as const, price: a, serviceName: null })),
];

const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export type CheckoutCheck =
  | { ok: true; data: { item: CatalogItem; forName: string; fromName: string; email: string; phone: string | null } }
  | { ok: false; field: 'voucherId' | 'forName' | 'fromName' | 'email' | 'consent' };

/** Formulář objednávky z webu. Cenu bere z katalogu, nikdy z prohlížeče. Pořadí chyb = pořadí formuláře. */
export const checkCheckout = (body: any, catalog: CatalogItem[]): CheckoutCheck => {
  const b = body && typeof body === 'object' ? body : {};
  const item = catalog.find((i) => i.id === String(b.voucherId ?? ''));
  if (!item || !(item.price > 0)) return { ok: false, field: 'voucherId' };
  const forName = text(b.forName, FOR_NAME_MAX);
  if (forName.length < 2) return { ok: false, field: 'forName' };
  const fromName = text(b.fromName, FROM_NAME_MAX);
  if (fromName.length < 2) return { ok: false, field: 'fromName' };
  const email = String(b.email ?? '').trim();
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return { ok: false, field: 'email' };
  if (b.consent !== true && b.consent !== 'true') return { ok: false, field: 'consent' };
  const phone = text(b.phone, 30) || null;
  return { ok: true, data: { item, forName, fromName, email, phone } };
};

export interface ComgateConfig {
  merchant: string;
  secret: string;
  test: boolean;
  apiUrl: string;
}

/** Env → konfigurace; bez merchant/secret = platby vypnuté (null). */
export const comgateConfig = (env: Record<string, string | undefined>): ComgateConfig | null => {
  const merchant = String(env.COMGATE_MERCHANT || '').trim();
  const secret = String(env.COMGATE_SECRET || '').trim();
  if (!merchant || !secret) return null;
  return {
    merchant,
    secret,
    // Bezpečné výchozí: dokud není COMGATE_TEST=false výslovně, jsou platby testovací.
    test: String(env.COMGATE_TEST ?? 'true').trim().toLowerCase() !== 'false',
    apiUrl: String(env.COMGATE_API_URL || 'https://payments.comgate.cz').replace(/\/+$/, ''),
  };
};

export const basicAuth = (cfg: Pick<ComgateConfig, 'merchant' | 'secret'>) =>
  `Basic ${Buffer.from(`${cfg.merchant}:${cfg.secret}`).toString('base64')}`;

/** Tělo POST /v2.0/payment.json. `returnUrl` = stránka výsledku s naším tokenem. */
export const createPaymentBody = (p: {
  cfg: ComgateConfig;
  price: number;
  idVoucher: string;
  catalogId: string;
  email: string;
  fullName: string;
  returnUrl: string;
}) => ({
  price: Math.round(p.price * 100),
  curr: 'CZK',
  label: PAYMENT_LABEL,
  refId: p.idVoucher,
  method: 'ALL',
  email: p.email,
  fullName: p.fullName,
  test: p.cfg.test,
  country: 'CZ',
  lang: 'cs',
  expirationTime: `${PAYMENT_EXPIRATION_HOURS}h`,
  delivery: 'ELECTRONIC_DELIVERY',
  category: 'OTHER',
  name: p.catalogId.slice(0, 64),
  url_paid: p.returnUrl,
  url_cancelled: p.returnUrl,
  url_pending: p.returnUrl,
});

/** Odpověď na založení platby → {transId, redirect} nebo null. Adresa jen https (nebo na `apiUrl` — stend). */
export const parseCreateResponse = (res: any, apiUrl = ''): { transId: string; redirect: string } | null => {
  if (!res || Number(res.code) !== 0) return null;
  const transId = String(res.transId || '').trim();
  const redirect = String(res.redirect || '').trim();
  const allowed = /^https:\/\//.test(redirect) || (apiUrl !== '' && redirect.startsWith(`${apiUrl}/`));
  if (!transId || !allowed) return null;
  return { transId, redirect };
};

export interface StoredPayment {
  transId: string;
  idVoucher: string;
  price: number;
  /** Ne `status`: ve Strapi 5 je to vyhrazené jméno stavu dokumentu a panel pole neukáže. */
  paymentStatus: PaymentStatus;
  test: boolean;
}

export type StatusVerdict =
  | { action: 'paid'; method: string | null }
  | { action: 'cancelled'; reason: string | null }
  | { action: 'pending' }
  | { action: 'mismatch'; reason: string };

/**
 * Odpověď Comgate na dotaz stavu → co udělat. Push samotnému se nevěří: rozhoduje
 * jen tato odpověď a musí sedět transakce, refId, částka, měna i testovací režim.
 */
export const statusVerdict = (res: any, payment: StoredPayment): StatusVerdict => {
  if (!res || Number(res.code) !== 0) return { action: 'mismatch', reason: `code ${res?.code ?? '?'}` };
  if (String(res.transId) !== payment.transId) return { action: 'mismatch', reason: 'transId' };
  if (String(res.refId) !== payment.idVoucher) return { action: 'mismatch', reason: 'refId' };
  if (String(res.curr) !== 'CZK') return { action: 'mismatch', reason: 'curr' };
  if (Number(res.price) !== Math.round(payment.price * 100)) return { action: 'mismatch', reason: 'price' };
  const resTest = res.test === true || String(res.test) === 'true';
  if (resTest !== payment.test) return { action: 'mismatch', reason: 'test' };
  const status = String(res.status || '').toUpperCase();
  if (status === 'PAID') return { action: 'paid', method: res.method ? String(res.method) : null };
  if (status === 'CANCELLED') return { action: 'cancelled', reason: res.paymentErrorReason ? String(res.paymentErrorReason) : null };
  // PENDING; AUTHORIZED nepoužíváme (bez předautorizace) — čeká se dál
  return { action: 'pending' };
};

/**
 * Přechod stavu u nás. `paid` vyhrává i nad naším `cancelled` (pozdní platba po
 * vypršení — peníze odešly, voucher platí). `refunded` je konečný.
 */
export const nextStatus = (current: PaymentStatus, verdict: StatusVerdict): PaymentStatus | null => {
  if (current === 'refunded' || current === 'paid') return null;
  if (verdict.action === 'paid') return 'paid';
  if (verdict.action === 'cancelled' && current === 'pending') return 'cancelled';
  return null;
};

/** Stav, ze kterého je přechod povolen (podmínka podmíněného UPDATE). */
export const fromStatusesFor = (to: PaymentStatus): PaymentStatus[] =>
  to === 'paid' ? ['pending', 'cancelled'] : to === 'cancelled' ? ['pending'] : to === 'refunded' ? ['paid'] : [];

const safeEqual = (a: string, b: string) => {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
};

/** Push od Comgate: náš merchant + náš secret (porovnání v konstantním čase) + transId. */
export const checkPush = (body: any, cfg: ComgateConfig): { ok: true; transId: string } | { ok: false; reason: string } => {
  const b = body && typeof body === 'object' ? body : {};
  if (String(b.merchant ?? '') !== cfg.merchant) return { ok: false, reason: 'merchant' };
  if (!safeEqual(String(b.secret ?? ''), cfg.secret)) return { ok: false, reason: 'secret' };
  const transId = String(b.transId ?? '').trim();
  if (!transId || transId.length > 64) return { ok: false, reason: 'transId' };
  return { ok: true, transId };
};

/** Vypršelá neuhrazená objednávka (cron): pending a starší než 24 h + 15 min rezerva. */
export const isExpired = (payment: { paymentStatus: PaymentStatus; createdAt: string | Date }, now: Date) =>
  payment.paymentStatus === 'pending' &&
  now.getTime() - new Date(payment.createdAt).getTime() > PAYMENT_EXPIRATION_HOURS * 3600_000 + 15 * 60_000;

/** Vrácení peněz z adminu: jen zaplacená platba a voucher ještě nevyužitý. */
export const refundBlock = (payment: { paymentStatus: PaymentStatus }, voucher: { dateRealized?: string | null } | null) => {
  if (payment.paymentStatus === 'refunded') return 'already_refunded';
  if (payment.paymentStatus !== 'paid') return 'not_paid';
  if (voucher?.dateRealized) return 'voucher_used';
  return null;
};

/** Tělo POST /v2.0/refund.json (celá částka). */
export const refundBody = (payment: StoredPayment) => ({
  transId: payment.transId,
  amount: Math.round(payment.price * 100),
  test: payment.test,
  refId: payment.idVoucher,
});

/** Platnost voucheru „dd.MM.yyyy“ — 6 měsíců od dne platby (stejně jako PDF na webu). */
export const VOUCHER_VALID_MONTHS = 6;
export const validUntilOf = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + VOUCHER_VALID_MONTHS, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(day).padStart(2, '0')}.${String(target.getUTCMonth() + 1).padStart(2, '0')}.${target.getUTCFullYear()}`;
};

/** Co vidí stránka výsledku (bez osobních údajů kromě zamaskovaného e-mailu). */
export const publicStatus = (p: { paymentStatus: PaymentStatus; price: number; catalogId: string }, maskedEmail: string) => ({
  status: p.paymentStatus,
  price: p.price,
  voucherId: p.catalogId,
  email: p.paymentStatus === 'paid' ? maskedEmail : null,
});
