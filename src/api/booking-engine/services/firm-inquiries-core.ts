// Firemní poptávky voucherů (s274) — čistá část bez Strapi: kontrola formuláře,
// stavy, tvar řádku pro admin a HTML e-mailů. Odděleno kvůli testům
// (tests/firm-inquiries-core.test.mjs).

export const FIRM_MIN_COUNT = 10;
export const FIRM_MAX_COUNT = 100000;
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/** Stavy poptávky v pořadí práce s ní. */
export const STATUSES = ['new', 'contacted', 'offer', 'won', 'lost'] as const;
export type InquiryStatus = (typeof STATUSES)[number];
export const OPEN_STATUSES: InquiryStatus[] = ['new', 'contacted', 'offer'];

export const STATUS_LABEL: Record<InquiryStatus, string> = {
  new: 'Nová',
  contacted: 'Kontaktováno',
  offer: 'Nabídka odeslána',
  won: 'Objednáno',
  lost: 'Zrušeno',
};

const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

// Limity polí (znaky). `note` a `adminNote` — volný text.
const LIMITS = {
  company: 200,
  ico: 20,
  value: 200,
  person: 200,
  phone: 60,
  email: 200,
  note: 4000,
  adminNote: 4000,
} as const;

const clip = (value: unknown, max: number): string =>
  String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);

export interface InquiryInput {
  company: string;
  ico: string;
  count: number;
  value: string;
  person: string;
  phone: string;
  email: string;
  note: string;
}

export type InquiryCheck = { ok: true; data: InquiryInput } | { ok: false; field: string };

/**
 * Kontrola formuláře z webu (multipart → řetězce). Vrací první chybné pole —
 * web má vlastní kontrolu, tohle je pojistka proti obejití prohlížeče.
 */
export const checkInquiry = (body: Record<string, unknown> | null | undefined): InquiryCheck => {
  const b = body || {};
  const data: InquiryInput = {
    company: clip(b.company, LIMITS.company),
    ico: clip(b.ico, LIMITS.ico),
    count: Number(clip(b.count, 10)),
    value: clip(b.value, LIMITS.value),
    person: clip(b.person, LIMITS.person),
    phone: clip(b.phone, LIMITS.phone),
    email: clip(b.email, LIMITS.email),
    note: clip(b.note, LIMITS.note),
  };
  if (data.company.length < 2) return { ok: false, field: 'company' };
  if (!Number.isInteger(data.count) || data.count < FIRM_MIN_COUNT || data.count > FIRM_MAX_COUNT) {
    return { ok: false, field: 'count' };
  }
  if (data.person.length < 2) return { ok: false, field: 'person' };
  if (!EMAIL_RE.test(data.email)) return { ok: false, field: 'email' };
  if (String(b.consent) !== 'true') return { ok: false, field: 'consent' };
  return { ok: true, data };
};

/**
 * Úprava z adminu: jen stav a interní poznámka. `null` = nic platného ke změně.
 * Admin posílá `status`, v kolekci je atribut `inquiryStatus` (`status` je ve Strapi 5
 * vyhrazené jméno a panel by pole ukazoval prázdné).
 */
export const checkUpdate = (
  body: Record<string, unknown> | null | undefined
): { inquiryStatus?: InquiryStatus; adminNote?: string } | null => {
  const b = body || {};
  const out: { inquiryStatus?: InquiryStatus; adminNote?: string } = {};
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status as InquiryStatus)) return null;
    out.inquiryStatus = b.status as InquiryStatus;
  }
  if (b.adminNote !== undefined) out.adminNote = clip(b.adminNote, LIMITS.adminNote);
  return Object.keys(out).length ? out : null;
};

/** Řádek pro admin — bez storedName (soubor jen přes ručku s kontrolou role). */
export const inquiryRow = (r: any) => ({
  id: r.documentId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  company: r.company || '',
  ico: r.ico || '',
  count: Number(r.count) || 0,
  value: r.value || '',
  person: r.person || '',
  phone: r.phone || '',
  email: r.email || '',
  note: r.note || '',
  status: (STATUSES.includes(r.inquiryStatus) ? r.inquiryStatus : 'new') as InquiryStatus,
  adminNote: r.adminNote || '',
  updatedByName: r.updatedByName || '',
  logo: r.logoName ? { name: r.logoName, mime: r.logoMime || '', size: Number(r.logoSize) || 0 } : null,
});

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const FIELDS: [keyof InquiryInput, string][] = [
  ['company', 'Firma'],
  ['ico', 'IČO'],
  ['count', 'Počet voucherů'],
  ['value', 'Hodnota / služba'],
  ['person', 'Kontaktní osoba'],
  ['phone', 'Telefon'],
  ['email', 'E-mail'],
  ['note', 'Poznámka'],
];

const rowsHtml = (data: InquiryInput) =>
  FIELDS.filter(([key]) => String(data[key] ?? '').trim())
    .map(
      ([key, label]) =>
        `<p style="margin:0 0 8px;"><strong>${label}:</strong> <span style="white-space:pre-wrap;">${escapeHtml(data[key])}</span></p>`
    )
    .join('');

const wrap = (inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#161615;">${inner}</div>`;

/** E-mail salonu o nové poptávce (logo jde přílohou). */
export const salonEmail = (data: InquiryInput, logoName: string | null, adminUrl: string) => ({
  subject: `Firemní vouchery: ${data.company} (${data.count} ks)`,
  html: wrap(`
    <h2 style="margin:0 0 16px;font-size:20px;">Nová poptávka firemních voucherů</h2>
    ${rowsHtml(data)}
    <p style="margin:16px 0 0;"><strong>Logo:</strong> ${logoName ? `${escapeHtml(logoName)} (v příloze)` : 'nepřiloženo'}</p>
    <p style="margin:16px 0 0;"><a href="${escapeHtml(adminUrl)}" style="color:#e71e6e;">Otevřít v administraci</a></p>
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;" />
    <p style="margin:0;color:#888;font-size:13px;">Odesláno z formuláře na barbitch.cz/firemni-vouchery. Odpovědí na tento e-mail napíšete přímo firmě.</p>
  `),
});

/** Potvrzení firmě, že poptávka dorazila. */
export const confirmationEmail = (data: InquiryInput) => ({
  subject: 'Děkujeme za poptávku firemních voucherů',
  html: wrap(`
    <h2 style="margin:0 0 16px;font-size:20px;">Děkujeme, ${escapeHtml(data.person)}!</h2>
    <p style="margin:0 0 16px;">Vaši poptávku jsme přijali. Do jednoho pracovního dne vám pošleme kalkulaci a náhled voucheru.</p>
    ${rowsHtml(data)}
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;" />
    <p style="margin:0;color:#888;font-size:13px;">Bar.Bitch Brno, Křenová 294/16, 602 00 Brno</p>
  `),
});
