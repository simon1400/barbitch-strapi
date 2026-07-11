/**
 * Чистые функции движка бронирования (booking-engine): интервальная математика,
 * расчёт свободных слотов, конверсия времени Прага↔UTC (DST-safe через Intl),
 * прайсинг (base + variant + modifiers, junior −20%), балансировка «any».
 *
 * ВАЖНО: модуль самодостаточен (ни одного импорта) — юнит-тесты транспилируют
 * его в изоляции без БД/Strapi (strapi/tests/slots-core.test.mjs).
 * Семантика интервалов везде полуоткрытая [startMin, endMin).
 */

// ── константы движка ──
export const STEP_MIN = 15; // шаг сетки слотов
export const HOLD_TTL_MIN = 5; // жизнь холда (как таймер Noona-флоу)
export const MIN_LEAD_MIN = 30; // минимальный зазор от «сейчас» до слота сегодня
export const CANCEL_MIN_HOURS = 3; // клиент может отменить не позже чем за N часов
// Junior −20% к ИТОГОВОЙ цене (синхронно с client/src/lib/junior.ts и admin/src/constants/junior.ts)
export const JUNIOR_DISCOUNT_PERCENT = 20;
// Балансировка «Kdokoliv» — порт selectMaster (client/src/app/book/fetch/masterPriority.ts, s75)
export const PRIORITY_BOOST_WEIGHT = 2;
export const LOAD_WINDOW_RADIUS_DAYS = 3;

export interface Interval {
  startMin: number;
  endMin: number;
}

// ── интервальная математика ──

/** Слить пересекающиеся/смежные интервалы; мусор (end<=start) отбрасывается. */
export const mergeIntervals = (intervals: Interval[]): Interval[] => {
  const clean = intervals
    .filter((i) => i && i.endMin > i.startMin)
    .slice()
    .sort((a, b) => a.startMin - b.startMin);
  const out: Interval[] = [];
  for (const cur of clean) {
    const last = out[out.length - 1];
    if (last && cur.startMin <= last.endMin) {
      if (cur.endMin > last.endMin) last.endMin = cur.endMin;
    } else {
      out.push({ startMin: cur.startMin, endMin: cur.endMin });
    }
  }
  return out;
};

/** window − busy → свободные интервалы (busy может быть несортированным/пересекающимся). */
export const subtractIntervals = (window: Interval, busy: Interval[]): Interval[] => {
  if (!window || window.endMin <= window.startMin) return [];
  const merged = mergeIntervals(busy);
  const out: Interval[] = [];
  let cursor = window.startMin;
  for (const b of merged) {
    if (b.endMin <= window.startMin || b.startMin >= window.endMin) continue;
    if (b.startMin > cursor) out.push({ startMin: cursor, endMin: Math.min(b.startMin, window.endMin) });
    cursor = Math.max(cursor, b.endMin);
    if (cursor >= window.endMin) break;
  }
  if (cursor < window.endMin) out.push({ startMin: cursor, endMin: window.endMin });
  return out;
};

/**
 * Старты слотов: сетка кратна stepMin (от полуночи), слот целиком влезает в
 * свободный интервал, старт не раньше minStartMin (лид «сегодня»).
 */
export const slotStarts = (
  free: Interval[],
  durationMin: number,
  stepMin: number = STEP_MIN,
  minStartMin = 0
): number[] => {
  if (!durationMin || durationMin <= 0) return [];
  const out: number[] = [];
  for (const f of free) {
    const from = Math.max(f.startMin, minStartMin);
    let start = Math.ceil(from / stepMin) * stepMin;
    while (start + durationMin <= f.endMin) {
      out.push(start);
      start += stepMin;
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
};

// ── время: Прага ↔ UTC (DST-safe, сервер может быть в UTC) ──

const PRAGUE_TZ = 'Europe/Prague';

const partsInPrague = (utcMs: number) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: PRAGUE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // Intl может отдать hour=24 для полуночи
  if (map.hour === 24) map.hour = 0;
  return map as { year: number; month: number; day: number; hour: number; minute: number; second: number };
};

/** Смещение Праги от UTC для данного момента (мс): +1ч зимой, +2ч летом. */
export const pragueOffsetMs = (utcMs: number): number => {
  const p = partsInPrague(utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
};

/** 'YYYY-MM-DD' пражской даты момента. */
export const pragueDateOf = (iso: string | Date): string => {
  const p = partsInPrague(new Date(iso).getTime());
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** Минуты от пражской полуночи для момента (в его пражских сутках). */
export const pragueMinOf = (iso: string | Date): number => {
  const p = partsInPrague(new Date(iso).getTime());
  return p.hour * 60 + p.minute;
};

/**
 * Момент → минуты пражских суток dateStr, с клампом: раньше этих суток → 0,
 * позже → 1440 (для busy-интервалов, цепляющих полночь).
 */
export const utcToPragueMinClamped = (iso: string | Date, dateStr: string): number => {
  const d = pragueDateOf(iso);
  if (d < dateStr) return 0;
  if (d > dateStr) return 1440;
  return pragueMinOf(iso);
};

/**
 * Пражские сутки + минуты → UTC ISO. Двухпроходная сходимость покрывает DST
 * (в ночь перехода несуществующее локальное время отображается по фактическому
 * смещению после скачка — слоты в это окно салон всё равно не открывает).
 */
export const pragueMinToUtcIso = (dateStr: string, min: number): string => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const wallUtc = Date.UTC(y, mo - 1, d, Math.floor(min / 60), min % 60);
  let guess = wallUtc - pragueOffsetMs(wallUtc);
  guess = wallUtc - pragueOffsetMs(guess);
  return new Date(guess).toISOString();
};

export const minToHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const hhmmToMin = (s: string): number => {
  const [h, m] = (s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

// ── прайсинг ──

export const calcJuniorPrice = (seniorPrice: number): number =>
  Math.round(seniorPrice * (1 - JUNIOR_DISCOUNT_PERCENT / 100));

export interface PricingInput {
  basePrice: number;
  baseDurationMin: number;
  variant?: { priceDiff?: number; durationDiff?: number } | null;
  modifiers?: Array<{ priceDiff?: number; durationDiff?: number }>;
  tier?: 'senior' | 'junior';
}

export interface PricingResult {
  price: number; // итог с учётом junior-скидки
  seniorPrice: number; // цена без junior-скидки (для зачёркнутой цены в UI)
  durationMin: number; // junior-длительность = senior (решение s95)
}

/** Цена/длительность = base + variant + Σ modifiers; junior → −20% от итога. */
export const computePricing = (input: PricingInput): PricingResult => {
  const mods = input.modifiers || [];
  const seniorPrice =
    (input.basePrice || 0) +
    (input.variant?.priceDiff || 0) +
    mods.reduce((s, m) => s + (m.priceDiff || 0), 0);
  const durationMin =
    (input.baseDurationMin || 0) +
    (input.variant?.durationDiff || 0) +
    mods.reduce((s, m) => s + (m.durationDiff || 0), 0);
  const price = input.tier === 'junior' ? calcJuniorPrice(seniorPrice) : seniorPrice;
  return { price, seniorPrice, durationMin };
};

/**
 * Название комбинации для снимка в брони — то же правило, что buildTitle
 * в admin noonaServices (s54): части, начинающиеся с «+», клеятся пробелом,
 * остальные — через « + ».
 */
export const buildComboTitle = (baseTitle: string, parts: string[]): string =>
  parts.filter(Boolean).reduce((acc, p) => (p.trim().startsWith('+') ? `${acc} ${p.trim()}` : `${acc} + ${p.trim()}`), baseTitle);

// ── балансировка «Kdokoliv» (порт selectMaster s75) ──

export interface EmployeeCandidate {
  id: string;
  load: number; // брони в окне ±LOAD_WINDOW_RADIUS_DAYS
  boost: number; // bookingPriority из personal
}

/**
 * score = load − boost×PRIORITY_BOOST_WEIGHT; берём минимальный, среди равных —
 * rand (инжектится в тестах для детерминизма).
 */
export const selectEmployee = (
  candidates: EmployeeCandidate[],
  rand: () => number = Math.random
): string | null => {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].id;
  const scored = candidates.map((c) => ({ id: c.id, score: c.load - c.boost * PRIORITY_BOOST_WEIGHT }));
  const min = Math.min(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === min).map((s) => s.id);
  return top[Math.floor(rand() * top.length)];
};

// ── композиция: свободные старты одного мастера на один день ──

export interface DayAvailabilityInput {
  openMin: number | null; // часы салона (null → закрыто)
  closeMin: number | null;
  busy: Interval[]; // блоки + активные брони + живые холды (минуты пражских суток)
  durationMin: number;
  stepMin?: number;
  minStartMin?: number; // для «сегодня» = nowPragueMin + MIN_LEAD_MIN
}

export const dayAvailability = (input: DayAvailabilityInput): number[] => {
  if (input.openMin == null || input.closeMin == null || input.closeMin <= input.openMin) return [];
  const free = subtractIntervals({ startMin: input.openMin, endMin: input.closeMin }, input.busy);
  return slotStarts(free, input.durationMin, input.stepMin ?? STEP_MIN, input.minStartMin ?? 0);
};
