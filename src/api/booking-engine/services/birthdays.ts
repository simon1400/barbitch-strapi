// @ts-nocheck
/**
 * Дни рождения сотрудников (s221): у кого из активных сотрудников день рождения
 * в ближайшие 30 дней (никого нет — самый ближайший). Карточка на «Сегодня» и в кабинете администратора.
 *
 * Источник — `personal.oficial.dateBirth`: СВОБОДНАЯ строка внутри компонента с
 * паспортными данными (номер документа, адреса, сканы). Поэтому:
 *   • наружу уходят только имя, должность, день и месяц — год рождения и возраст НЕТ;
 *   • из компонента читается одно поле `dateBirth`, остальное сервер не трогает;
 *   • строка разбирается терпимо, нераспознанные — списком `unknown` только
 *     руководству (поправить в панели Strapi).
 * Браузеру компонент `oficial` закрыт совсем — см. middlewares/admin-session.ts.
 *
 * Всё — чтение. Гейт — owner + manager + administrator, в контроллере.
 *
 * Верх файла — чистые функции (tests/birthdays.test.mjs), ниже — сервис.
 */

const PERSONAL_UID = 'api::personal.personal';

/** Горизонт: дни рождения от сегодня до сегодня + 30 включительно (решение владельца). */
export const HORIZON_DAYS = 30;
/** Год рождения правдоподобен: не раньше 1940 и сотруднику не меньше 14 лет. */
export const MIN_YEAR = 1940;
export const MIN_AGE = 14;

const pragueToday = (now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const isRealDate = (y: number, m: number, d: number): boolean => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// «03.10.1995», «3. 10. 1995», «03/10/1995», «03-10-1995» — день первым, как пишут в Чехии
const DMY = /^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})$/;
// «1995-10-03», «1995-10-03T00:00:00.000Z»
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/;

/** День и месяц из строки даты рождения; null — строка не распознана. */
export const parseBirth = (raw: unknown, todayYear: number): { day: number; month: number } | null => {
  const s = String(raw ?? '').trim();
  let y: number, m: number, d: number;
  let hit = DMY.exec(s);
  if (hit) {
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else {
    hit = ISO.exec(s);
    if (!hit) return null;
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  }
  if (y < MIN_YEAR || y > todayYear - MIN_AGE) return null;
  if (!isRealDate(y, m, d)) return null;
  return { day: d, month: m };
};

const ymdOf = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// 29 февраля в невисокосный год празднуется 28-го
const occurrenceIn = (year: number, day: number, month: number): string =>
  month === 2 && day === 29 && !isLeap(year) ? ymdOf(year, 2, 28) : ymdOf(year, month, day);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** Ближайший день рождения не раньше сегодня: дата и сколько до него дней (0 — сегодня). */
export const nextOccurrence = (day: number, month: number, today: string) => {
  const year = Number(today.slice(0, 4));
  let next = occurrenceIn(year, day, month);
  if (next < today) next = occurrenceIn(year + 1, day, month);
  return { next, daysLeft: daysBetween(today, next) };
};

/**
 * Список для карточки. rows — опубликованные активные карточки {documentId, name,
 * position, dateBirth}. Служебные строки («❌» в имени) не показываются.
 * `unknown` отдаётся только руководству.
 *
 * Если в горизонт не попал никто — отдаётся самый ближайший день рождения
 * (при совпадении даты — все, у кого он в этот день), `nearestOnly: true`.
 */
export const buildBirthdays = (rows: any[], today: string, management: boolean) => {
  const todayYear = Number(today.slice(0, 4));
  const all = [];
  const unknown: string[] = [];
  for (const r of rows || []) {
    const name = String(r?.name ?? '').trim();
    if (!name || name.startsWith('❌')) continue;
    const birth = parseBirth(r.dateBirth, todayYear);
    if (!birth) {
      unknown.push(name);
      continue;
    }
    const { next, daysLeft } = nextOccurrence(birth.day, birth.month, today);
    all.push({
      docId: r.documentId,
      name,
      position: r.position ?? null,
      day: birth.day,
      month: birth.month,
      next,
      daysLeft,
    });
  }
  all.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'cs'));
  unknown.sort((a, b) => a.localeCompare(b, 'cs'));
  let items = all.filter((i) => i.daysLeft <= HORIZON_DAYS);
  const nearestOnly = items.length === 0 && all.length > 0;
  if (nearestOnly) items = all.filter((i) => i.daysLeft === all[0].daysLeft);
  return { today, horizonDays: HORIZON_DAYS, items, nearestOnly, unknown: management ? unknown : [] };
};

export default {
  async list({ session, now = new Date() }: { session: any; now?: Date }) {
    const rows = await strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { isActive: { $eq: true } },
      fields: ['name', 'position'],
      populate: { oficial: { fields: ['dateBirth'] } },
      limit: 200,
    });
    const management = session?.role === 'owner' || session?.role === 'manager';
    return buildBirthdays(
      (rows || []).map((p) => ({
        documentId: p.documentId,
        name: p.name,
        position: p.position,
        dateBirth: p.oficial?.dateBirth,
      })),
      pragueToday(now),
      management
    );
  },
};
