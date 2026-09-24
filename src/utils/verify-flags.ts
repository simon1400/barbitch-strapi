// Verify-флаги записи «Оказанная услуга» (service-provided) — единый источник расчёта
// для двух путей записи:
//   • legacy CM-путь: полная цена = связанный `offer.price` (lifecycles.ts);
//   • booking-путь (вариант D2, чекаут из календаря): цена и системные скидки берутся
//     из самой брони (visit-close.ts — движок считает флаги САМ, потому что lifecycle
//     при plain-REST create не получает relations в CM-формате и даёт null, гоча s129).
//
// Семантика флагов (зеркалится в admin/src/pages/global/fetch/shiftClose.ts):
//   ok          🟩 всё сходится с правилом
//   sleva       🟦 визит со скидкой: ручной (поле sale) или — на booking-пути —
//               системной (bitchcard-redemption / дозапись −15 %). Информационный.
//   ztrata      🟥 салон получил меньше правила без скидки → утечка денег
//   salon_up    🟪 салон получил больше правила (подозрительно)
//   mistr_up    🟨↑ мастер получил больше правила
//   mistr_down  🟨↓ мастер получил меньше правила
//   internal    🤝 внутренняя услуга мастер↔мастеру: прибыль салона 0 — норма,
//               проверяется только процент мастера
//   sleva_bez_karty 🎟 информационный: у записи есть скидка, но у клиента нет
//               погашенной награды bitchcard → скидка дана мимо программы
//               (ставится вызывающим кодом, здесь не вычисляется — нужен async-lookup)
//   cena_rucne  💰 (s203) цена визита изменена РУКАМИ: (оплачено + известные системные
//               скидки) ≠ Σ каталожных цен снапшота брони. Дельта хранится в
//               service-provided.manualDeltaKc (< 0 занизили, > 0 завысили)
//   korekce     🔁 (s210) бесплатная коррекция — доля мастера перенесена исправителю.
//               Информационный, ставится на ОБЕИХ записях: у исходной правило
//               «мастер/салон» сдвинуто аккумуляторами переноса, у записи коррекции
//               норма = доля исправителя (staffInKc) и салон 0.

export type VerifyFlag =
  | 'ok'
  | 'sleva'
  | 'ztrata'
  | 'salon_up'
  | 'mistr_up'
  | 'mistr_down'
  | 'internal'
  | 'sleva_bez_karty'
  | 'cena_rucne'
  | 'korekce';

export const FLAG_EMOJI: Record<VerifyFlag, string> = {
  ok: '🟩',
  sleva: '🟦',
  ztrata: '🟥',
  salon_up: '🟪',
  mistr_up: '🟨',
  mistr_down: '🟨',
  internal: '🤝',
  sleva_bez_karty: '🎟',
  cena_rucne: '💰',
  korekce: '🔁',
};

// Приоритет для легаси-поля `verify` (одна доминирующая эмодзи), highest first
export const FLAG_PRIORITY: VerifyFlag[] = [
  'ztrata',
  'salon_up',
  'mistr_down',
  'mistr_up',
  'cena_rucne',
  'korekce',
  'internal',
  'sleva_bez_karty',
  'sleva',
  'ok',
];

export const dominantEmoji = (flags: VerifyFlag[]): string => {
  for (const f of FLAG_PRIORITY) if (flags.includes(f)) return FLAG_EMOJI[f];
  return FLAG_EMOJI.ok;
};

/** Деньги хранятся строкой; юниор-цены исторически бывают с запятой («237,6»). */
export const parseMoney = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Скидка → доля 0..1 от полной цены.
 * Принимает процент («20%», «20», «0.2») или абсолютную сумму в кронах («400»):
 * процент не может быть больше 100, поэтому значения >100 трактуются как кроны.
 * Значения 1..100 остаются процентами («50» = 50 %, не 50 Kč) — гоча s81.
 */
/**
 * Введена ли РУЧНАЯ скидка в поле `sale` (любой формат: «20%», «0.2», «400»).
 * Отдельно от parseSaleRate: не зависит от fullPrice (кроны >100 при неизвестной
 * полной цене всё равно означают «скидка есть»). Используется гейтом 🎟
 * sleva_bez_karty — тот должен реагировать ТОЛЬКО на ручную скидку, а не на
 * системную (иначе легитимное bitchcard-погашение выглядело бы «мимо программы»).
 */
export const hasManualSale = (raw: unknown): boolean => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0;
  if (typeof raw === 'string') {
    const m = raw.match(/(-?\d+(?:[.,]\d+)?)/);
    return m ? parseFloat(m[1].replace(',', '.')) > 0 : false;
  }
  return false;
};

export const parseSaleRate = (raw: unknown, fullPrice: number): number => {
  let n = 0;
  if (typeof raw === 'number') n = Number.isFinite(raw) ? raw : 0;
  else if (typeof raw === 'string') {
    const m = raw.match(/(-?\d+(?:[.,]\d+)?)/);
    n = m ? parseFloat(m[1].replace(',', '.')) : 0;
  }
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return fullPrice > 0 ? Math.min(n / fullPrice, 1) : 0;
};

/**
 * Перенос доли при бесплатной коррекции (s210) — как он меняет норму записи.
 *   • запись КОРРЕКЦИИ (staffInKc задан): мастеру-исправителю норма = staffInKc
 *     (base × его %), салону 0 — клиент за коррекцию не платит;
 *   • ИСХОДНАЯ запись (аккумуляторы переноса): норма мастера − staffOutKc,
 *     норма салона + salonAdjKc (base × (rA − rB), отрицательна, когда
 *     исправитель дороже).
 * Оба сдвига складываются: запись коррекции тоже может быть чьей-то исходной.
 */
export type KorekceFlagInput = {
  staffInKc?: number | null;
  staffOutKc?: number | null;
  salonAdjKc?: number | null;
};

/** JSON-поле из Strapi приходит объектом, из сырого SQL иногда строкой. */
export const asKorekceObject = (v: unknown): Record<string, any> | null => {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string' && v.trim()) {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }
  return null;
};

export const KOREKCE_TRANSFER_MODES = ['record', 'payroll', 'same_master'];

/**
 * Вход для флагов из записи «Оказанная услуга»: json `korekce` (запись коррекции)
 * + аккумуляторы `korekceStaffOutKc` / `korekceSalonAdjKc` (исходная запись).
 * null — переноса нет, правило записи обычное.
 */
export const korekceFlagInput = (
  rec: { korekce?: unknown; korekceStaffOutKc?: unknown; korekceSalonAdjKc?: unknown } | null | undefined,
): KorekceFlagInput | null => {
  const j = asKorekceObject(rec?.korekce);
  const correction = !!j && KOREKCE_TRANSFER_MODES.includes(String(j.mode));
  const staffOutKc = parseMoney(rec?.korekceStaffOutKc);
  const salonAdjKc = parseMoney(rec?.korekceSalonAdjKc);
  if (!correction && !staffOutKc && !salonAdjKc) return null;
  return {
    staffInKc: correction ? (j!.mode === 'same_master' ? 0 : parseMoney(j!.staffInKc)) : null,
    staffOutKc,
    salonAdjKc,
  };
};

/**
 * Ядро сравнения. Правило (s47): мастер ВСЕГДА получает свой процент от ПОЛНОЙ цены —
 * скидку съедает салон. Салон сравнивается с фактически ожидаемой оплатой.
 */
export const computeFlagsCore = ({
  fullPrice,
  paidExpected,
  ratePercent,
  staffSalaries,
  salonSalaries,
  internal,
  hasSale,
  manualDeltaKc = 0,
  korekce = null,
}: {
  fullPrice: number;
  paidExpected: number;
  ratePercent: number;
  staffSalaries: number;
  salonSalaries: number;
  internal: boolean;
  hasSale: boolean;
  /** (оплачено + системные скидки) − каталожная цена брони; ≠ 0 → 💰 cena_rucne */
  manualDeltaKc?: number;
  /** перенос доли при бесплатной коррекции (s210), см. korekceFlagInput */
  korekce?: KorekceFlagInput | null;
}): VerifyFlag[] => {
  // Округление до копеек ПЕРЕД сравнением: иначе float-шум (1112 * 0.3 =
  // 333.59999999999997) делает точные 333.6 «больше» → ложные mistr_up + ztrata (s66).
  const r = (n: number) => Math.round(n * 100) / 100;

  // Запись коррекции: цена брони 0 Kč по смыслу, поэтому ни 🟦, ни 💰 здесь не про неё.
  const isCorrection = korekce?.staffInKc != null;
  const staffOut = parseMoney(korekce?.staffOutKc);
  const salonAdj = parseMoney(korekce?.salonAdjKc);
  const hasKorekce = isCorrection || r(staffOut) !== 0 || r(salonAdj) !== 0;

  const mustStaffBase = isCorrection ? parseMoney(korekce!.staffInKc) : fullPrice * (ratePercent / 100);
  const mustStaff = mustStaffBase - staffOut;
  const mustSalon = (isCorrection ? 0 : paidExpected - mustStaffBase) + salonAdj;
  const priceFlag = !isCorrection && Math.round(manualDeltaKc) !== 0;

  const rStaff = r(staffSalaries);
  const rMustStaff = r(mustStaff);

  // Внутренняя услуга: салон не зарабатывает — проверяем только процент мастера.
  if (internal) {
    const flags: VerifyFlag[] = ['internal'];
    if (rStaff > rMustStaff) flags.push('mistr_up');
    if (rStaff < rMustStaff) flags.push('mistr_down');
    if (priceFlag) flags.push('cena_rucne');
    if (hasKorekce) flags.push('korekce');
    return flags;
  }

  const rSalon = r(salonSalaries);
  const rMustSalon = r(mustSalon);

  const flags: VerifyFlag[] = [];
  if (rStaff > rMustStaff) flags.push('mistr_up');
  if (rStaff < rMustStaff) flags.push('mistr_down');
  if (rSalon > rMustSalon) flags.push('salon_up');
  if (rSalon < rMustSalon) flags.push('ztrata');
  if (hasSale && !isCorrection) flags.push('sleva');
  if (priceFlag) flags.push('cena_rucne');
  if (hasKorekce) flags.push('korekce');

  if (flags.length === 0) flags.push('ok');
  return flags;
};

/** Легаси-путь: полная цена = offer.price, скидка вычитается из неё же. */
export const computeOfferFlags = (
  offerPrice: number,
  ratePercent: number,
  staffSalaries: number,
  salonSalaries: number,
  sale: unknown,
  internal: boolean,
  korekce: KorekceFlagInput | null = null,
): VerifyFlag[] => {
  const discountRate = parseSaleRate(sale, offerPrice);
  return computeFlagsCore({
    fullPrice: offerPrice,
    paidExpected: offerPrice * (1 - discountRate),
    ratePercent,
    staffSalaries,
    salonSalaries,
    internal,
    hasSale: discountRate > 0,
    korekce,
  });
};

export type BookingLike = {
  services?: unknown;
  totalPrice?: unknown;
  priceOverride?: unknown;
  discount?: unknown;
};

/** Скидка за дозапись (rebook, s133) прямо из booking.discount — синхронно, без lookup. */
export const rebookDiscountKc = (booking: BookingLike | null | undefined): number => {
  const d: any = booking?.discount;
  if (d && d.type === 'rebook' && d.applied) return Math.max(0, parseMoney(d.discountKc));
  return 0;
};

/**
 * Цены визита из брони:
 *   fullPrice     = цена, от которой мастер получает свой процент (юниор-цена у юниора);
 *   paidExpected  = booking.totalPrice (уже с СИСТЕМНЫМИ скидками: rebook applied /
 *                   bitchcard redemption) минус ручная скидка `sale`, если админ её ввёл.
 *
 * 🟥 priceOverride НЕ означает «цену задал админ» (баг s152): этот флаг взводят и
 * СИСТЕМНЫЕ скидки — bitchcard-redemption (loyalty.ts) и дозапись −15 % (rebook.ts)
 * снижают total_price + ставят price_override, оставляя в снапшоте полные цены услуг.
 *
 * s203 (решение владельца, вариант «а»): полная цена = Σ снапшота ВСЕГДА (у юниора
 * это уже юниор-цена); ручная цена НЕ меняет базу процента мастера — разницу ест
 * салон (правило s47). Ручное изменение = manualDeltaKc = (total + известные
 * системные скидки) − Σ снапшота: < 0 занизили, > 0 завысили → флаг 💰 cena_rucne.
 * Системные скидки: rebook — из booking.discount синхронно; bitchcard `redemptionKc`
 * передаёт вызывающий (async-lookup). priceOverride на расчёт больше не влияет.
 * До s203 при override база была total + systemKc (договорная цена — мастер делил её).
 * Снапшот без цен (легаси) → полная цена = total + systemKc, дельта 0.
 */
export const bookingPricing = (
  booking: BookingLike | null | undefined,
  sale?: unknown,
  opts?: { redemptionKc?: number },
) => {
  let list: any[] = [];
  const raw = booking?.services;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }
  const total = parseMoney(booking?.totalPrice);
  const sum = list.reduce((acc, s) => acc + parseMoney(s?.price), 0);
  const systemKc = rebookDiscountKc(booking) + Math.max(0, opts?.redemptionKc || 0);
  const fullPrice = sum > 0 ? sum : total + systemKc;
  const manualDeltaKc = sum > 0 ? Math.round(total + systemKc - sum) : 0;

  const discountRate = parseSaleRate(sale, fullPrice);
  const saleKc = fullPrice * discountRate;
  return {
    fullPrice,
    catalogPrice: sum,
    paidExpected: Math.max(0, total - saleKc),
    saleKc,
    hasSale: discountRate > 0,
    // только ИЗВЕСТНЫЕ системные скидки (rebook + bitchcard); ручная разница — отдельно
    systemDiscountKc: systemKc,
    manualDeltaKc,
  };
};

/** Booking-путь: цена/скидки из брони, ручной `sale` применяется поверх. */
export const computeBookingFlags = ({
  booking,
  ratePercent,
  staffSalaries,
  salonSalaries,
  sale,
  internal,
  redemptionKc,
  korekce = null,
}: {
  booking: BookingLike | null | undefined;
  ratePercent: number;
  staffSalaries: number;
  salonSalaries: number;
  sale?: unknown;
  internal: boolean;
  /** Σ discountKc погашенных bitchcard-наград этой брони (async-lookup вызывающего). */
  redemptionKc?: number;
  /** перенос доли при бесплатной коррекции (s210) */
  korekce?: KorekceFlagInput | null;
}): VerifyFlag[] => {
  const { fullPrice, paidExpected, hasSale, systemDiscountKc, manualDeltaKc } = bookingPricing(booking, sale, {
    redemptionKc,
  });
  return computeFlagsCore({
    fullPrice,
    paidExpected,
    ratePercent,
    staffSalaries,
    salonSalaries,
    internal,
    // 🟦 и для системных скидок (bitchcard/rebook уже в totalPrice брони) — иначе
    // визит со скидкой по программе выглядел бы как обычный 🟩 без пометки.
    // Гейт 🎟 у вызывающих завязан на hasManualSale(sale), НЕ на этот флаг.
    hasSale: hasSale || systemDiscountKc > 0,
    manualDeltaKc,
    korekce,
  });
};
