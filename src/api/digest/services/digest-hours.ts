// Часы дня для дайджеста (s245, запрос управляющей): три интервала на сегодня —
//   • салон — мин. старт и макс. конец окон `salon-hour`;
//   • «відкрито для запису» — по активным мастерам: окна салона минус действующие блоки
//     мастера → свободные куски; от самого раннего начала до самого позднего конца
//     по всем мастерам (блок на весь день у одного мастера общий интервал не сужает);
//   • «фактично» — от первой до последней брони дня (без отменённых; интерные в выборку
//     дайджеста не попадают). Не режется окном салона: бронь вне часов — тоже факт.
// Чистые функции, без strapi; минуты от полуночи по Праге. Тест — tests/digest-hours.test.mjs.

export interface Interval {
  start: number;
  end: number;
}

/** Окно салона в форме зеркала Noona: 'HH:MM'. */
export interface HHMMWindow {
  starts_at?: string | null;
  ends_at?: string | null;
}

export const hhmmToMin = (s: string | null | undefined): number => {
  const [h, m] = (s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const minToHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

/** Вычитание занятых интервалов из окна → свободные куски (все положительной длины). */
export const subtractBusy = (winStart: number, winEnd: number, busy: Interval[]): Interval[] => {
  const sorted = busy.filter((b) => b.end > winStart && b.start < winEnd).sort((a, b) => a.start - b.start);
  const free: Interval[] = [];
  let cursor = winStart;
  for (const b of sorted) {
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, winEnd) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= winEnd) break;
  }
  if (cursor < winEnd) free.push({ start: cursor, end: winEnd });
  return free;
};

const extent = (ivs: Interval[]): Interval | null =>
  ivs.length ? { start: Math.min(...ivs.map((i) => i.start)), end: Math.max(...ivs.map((i) => i.end)) } : null;

export interface DayExtents {
  salon: Interval | null;
  open: Interval | null;
  actual: Interval | null;
}

export const dayExtents = ({
  windows,
  blocksByEmp,
  bookingsByEmp,
  activeIds,
}: {
  windows: HHMMWindow[];
  /** действующие блоки сегодня по мастеру (pending/rejected — не блоки) */
  blocksByEmp: Map<string, Interval[]>;
  /** брони сегодня по мастеру, без отменённых */
  bookingsByEmp: Map<string, Interval[]>;
  activeIds: Iterable<string>;
}): DayExtents => {
  const wins = (windows || [])
    .filter((w) => w.starts_at && w.ends_at)
    .map((w) => ({ start: hhmmToMin(w.starts_at), end: hhmmToMin(w.ends_at) }))
    .filter((w) => w.end > w.start);
  const salon = extent(wins);
  const free: Interval[] = [];
  if (salon) {
    for (const empId of activeIds) {
      const busy = blocksByEmp.get(empId) || [];
      for (const w of wins) free.push(...subtractBusy(w.start, w.end, busy));
    }
  }
  const booked: Interval[] = [];
  for (const ivs of bookingsByEmp.values()) for (const b of ivs) if (b.end > b.start) booked.push(b);
  return { salon, open: extent(free), actual: extent(booked) };
};

const fmt = (iv: Interval | null): string => (iv ? `${minToHHMM(iv.start)}–${minToHHMM(iv.end)}` : '—');

/** Строка дайджеста (украинский, как весь дайджест). */
export const formatWorkdayLine = (ext: DayExtents): string =>
  ext.salon
    ? `🕐 Робочий день: ${fmt(ext.salon)} · відкрито для запису ${fmt(ext.open)} · фактично ${fmt(ext.actual)}`
    : '🕐 Сьогодні немає робочих годин салону';
