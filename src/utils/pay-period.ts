/**
 * «За какой месяц» (s285): у аванса, выплаты зарплаты и налога за сотрудника есть
 * поле `period` (YYYY-MM) — месяц, в зарплаты которого запись попадает. `date` —
 * реальный день выплаты (владелец платит в следующем месяце за прошлый).
 *
 * Запись без периода (панель Strapi, старый REST, строки до s285) получает
 * `period` = месяц даты — ровно то, как эти записи считались раньше.
 * Читатели (админка, список корректировок) на всякий случай ещё и откатываются
 * на месяц даты, если `period` пуст (окно между деплоем и бэкфиллом).
 */

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isValidYm = (s: unknown): boolean => YM.test(String(s ?? ''));

/** 'YYYY-MM-DD' (или ISO) → 'YYYY-MM'; мусор → null. */
export const periodOfDate = (date: unknown): string | null => {
  const m = /^(\d{4}-(?:0[1-9]|1[0-2]))-\d{2}/.exec(String(date ?? ''));
  return m ? m[1] : null;
};

/** 'YYYY-MM' ± n месяцев. */
export const addMonthsYm = (ym: string, n: number): string => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Умолчание в данных записи. Создание: пустой период → месяц даты. Обновление:
 * трогаем только если период прислали пустым (в панели очистили поле) — если
 * ключа нет вовсе (частичное обновление), сохранённый период остаётся.
 */
export const applyPeriodDefault = (data: any, mode: 'create' | 'update') => {
  if (!data || typeof data !== 'object') return;
  const raw = typeof data.period === 'string' ? data.period.trim() : data.period;
  if (raw) {
    data.period = raw;
    return;
  }
  if (mode === 'update' && !('period' in data)) return;
  const p = periodOfDate(data.date);
  if (p) data.period = p;
};

/** Общий lifecycle для коллекций с периодом (avans, salary, tax). */
export const periodLifecycles = {
  beforeCreate(event: any) {
    applyPeriodDefault(event?.params?.data, 'create');
  },
  beforeUpdate(event: any) {
    applyPeriodDefault(event?.params?.data, 'update');
  },
};
