// Verify-флаги записи «Оказанная услуга» (service-provided) — единый источник расчёта
// для двух путей записи:
//   • legacy CM-путь: полная цена = связанный `offer.price` (lifecycles.ts);
//   • booking-путь (вариант D2, чекаут из календаря): цена и системные скидки берутся
//     из самой брони (visit-close.ts — движок считает флаги САМ, потому что lifecycle
//     при plain-REST create не получает relations в CM-формате и даёт null, гоча s129).
//
// Семантика флагов (зеркалится в admin/src/pages/global/fetch/shiftClose.ts):
//   ok          🟩 всё сходится с правилом
//   sleva       🟦 недоплата объясняется явной скидкой (поле sale)
//   ztrata      🟥 салон получил меньше правила без скидки → утечка денег
//   salon_up    🟪 салон получил больше правила (подозрительно)
//   mistr_up    🟨↑ мастер получил больше правила
//   mistr_down  🟨↓ мастер получил меньше правила
//   internal    🤝 внутренняя услуга мастер↔мастеру: прибыль салона 0 — норма,
//               проверяется только процент мастера
//   sleva_bez_karty 🎟 информационный: у записи есть скидка, но у клиента нет
//               погашенной награды bitchcard → скидка дана мимо программы
//               (ставится вызывающим кодом, здесь не вычисляется — нужен async-lookup)

export type VerifyFlag =
  | 'ok'
  | 'sleva'
  | 'ztrata'
  | 'salon_up'
  | 'mistr_up'
  | 'mistr_down'
  | 'internal'
  | 'sleva_bez_karty';

export const FLAG_EMOJI: Record<VerifyFlag, string> = {
  ok: '🟩',
  sleva: '🟦',
  ztrata: '🟥',
  salon_up: '🟪',
  mistr_up: '🟨',
  mistr_down: '🟨',
  internal: '🤝',
  sleva_bez_karty: '🎟',
};

// Приоритет для легаси-поля `verify` (одна доминирующая эмодзи), highest first
export const FLAG_PRIORITY: VerifyFlag[] = [
  'ztrata',
  'salon_up',
  'mistr_down',
  'mistr_up',
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
}: {
  fullPrice: number;
  paidExpected: number;
  ratePercent: number;
  staffSalaries: number;
  salonSalaries: number;
  internal: boolean;
  hasSale: boolean;
}): VerifyFlag[] => {
  const mustStaff = fullPrice * (ratePercent / 100);

  // Округление до копеек ПЕРЕД сравнением: иначе float-шум (1112 * 0.3 =
  // 333.59999999999997) делает точные 333.6 «больше» → ложные mistr_up + ztrata (s66).
  const r = (n: number) => Math.round(n * 100) / 100;
  const rStaff = r(staffSalaries);
  const rMustStaff = r(mustStaff);

  // Внутренняя услуга: салон не зарабатывает — проверяем только процент мастера.
  if (internal) {
    const flags: VerifyFlag[] = ['internal'];
    if (rStaff > rMustStaff) flags.push('mistr_up');
    if (rStaff < rMustStaff) flags.push('mistr_down');
    return flags;
  }

  const rSalon = r(salonSalaries);
  const rMustSalon = r(paidExpected - mustStaff);

  const flags: VerifyFlag[] = [];
  if (rStaff > rMustStaff) flags.push('mistr_up');
  if (rStaff < rMustStaff) flags.push('mistr_down');
  if (rSalon > rMustSalon) flags.push('salon_up');
  if (rSalon < rMustSalon) flags.push('ztrata');
  if (hasSale) flags.push('sleva');

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
  });
};

export type BookingLike = {
  services?: unknown;
  totalPrice?: unknown;
  priceOverride?: unknown;
};

/**
 * Цены визита из брони:
 *   fullPrice     = Σ services[].price (у юниора это уже юниор-цена — эквивалент
 *                   старого оффера «Юниор X»; mustStaff всегда от неё).
 *                   priceOverride=true → админ явно задал цену, она и есть полная.
 *   paidExpected  = booking.totalPrice (уже с СИСТЕМНЫМИ скидками: rebook applied /
 *                   bitchcard redemption) минус ручная скидка `sale`, если админ её ввёл.
 */
export const bookingPricing = (booking: BookingLike | null | undefined, sale?: unknown) => {
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
  // priceOverride — цена задана вручную; снапшот услуг мог остаться от старой услуги
  const fullPrice = booking?.priceOverride ? total : sum > 0 ? sum : total;

  const discountRate = parseSaleRate(sale, fullPrice);
  const saleKc = fullPrice * discountRate;
  return {
    fullPrice,
    paidExpected: Math.max(0, total - saleKc),
    saleKc,
    hasSale: discountRate > 0,
    systemDiscountKc: Math.max(0, fullPrice - total),
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
}: {
  booking: BookingLike | null | undefined;
  ratePercent: number;
  staffSalaries: number;
  salonSalaries: number;
  sale?: unknown;
  internal: boolean;
}): VerifyFlag[] => {
  const { fullPrice, paidExpected, hasSale } = bookingPricing(booking, sale);
  return computeFlagsCore({
    fullPrice,
    paidExpected,
    ratePercent,
    staffSalaries,
    salonSalaries,
    internal,
    hasSale,
  });
};
