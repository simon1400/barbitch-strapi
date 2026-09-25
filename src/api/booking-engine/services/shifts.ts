// @ts-nocheck
/**
 * Редактор смен администраторов (s217, Фаза E плана «Управляющая»).
 * Раньше график недели («Рабочие смены», коллекция `shift`) вёлся только в Strapi CM.
 *
 * Модель прода: 1 документ = 1 неделя, `from` = понедельник, `to` = воскресенье,
 * `week` — подпись для CM, `days` — компонент `content.week` (monday…sunday) со
 * СВОБОДНЫМ текстом («Вика», «Юля», «-», «Ремонт»). Связи с personal нет — строка
 * только показывается (плашка календаря, «Сегодня», отчёт дозаписей), поэтому
 * имена не сопоставляются с карточками, а подсказываются из недавних недель.
 *
 * Календарь читает ЧЕРНОВИК (`status=draft`, матч по `from` = понедельник), CM
 * требует все 7 дней при публикации — сохранение здесь пишет черновик и сразу
 * публикует (как кнопка Publish), так версии не расходятся.
 *
 * Гейт — руководство (owner + manager), в контроллере. Журнал — calendar_logs,
 * entityType `shift`.
 *
 * Верх файла — чистые функции (tests/shifts.test.mjs), ниже — сервис.
 */

export class ShiftError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SHIFT_UID = 'api::shift.shift';

export const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
/** Чешские сокращения дней — для журнала. */
export const DAY_CS = { monday: 'Po', tuesday: 'Út', wednesday: 'St', thursday: 'Čt', friday: 'Pá', saturday: 'So', sunday: 'Ne' };

/** Длина значения дня — имя или «Ремонт», не абзац. */
export const MAX_NAME = 60;
/** Сколько недель отдаёт один запрос списка. */
export const MAX_WEEKS = 12;
/** Неделя вперёд — не дальше года (опечатка в годе). */
export const MAX_FUTURE_DAYS = 366;
/** Раньше этой даты графика в базе нет (первая неделя — 03.02.2025). */
export const MIN_MONDAY = '2025-01-06';
/** Подсказки имён — из стольких недель до конца окна. */
export const NAMES_LOOKBACK_WEEKS = 16;
export const MAX_NAMES = 12;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const isValidYmd = (s: unknown): boolean => {
  const v = String(s ?? '');
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const isMondayYmd = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay() === 1;

/** Понедельник недели: валидная дата, понедельник, не старше графика, не дальше года. */
export const parseMonday = (raw: unknown, today: string): string => {
  const s = String(raw ?? '').trim();
  if (!isValidYmd(s)) throw new ShiftError(400, 'bad_monday', 'Неделя — дата понедельника ГГГГ-ММ-ДД');
  if (!isMondayYmd(s)) throw new ShiftError(400, 'bad_monday', 'Неделя начинается с понедельника');
  if (s < MIN_MONDAY) throw new ShiftError(400, 'date_too_old', 'Такой старой недели в графике нет');
  if (s > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new ShiftError(400, 'date_too_far', 'Неделя слишком далеко в будущем');
  return s;
};

export const parseWeeks = (raw: unknown): number => {
  if (raw == null || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WEEKS) {
    throw new ShiftError(400, 'bad_weeks', `Недель в запросе — от 1 до ${MAX_WEEKS}`);
  }
  return n;
};

/** «28.09-04.10» — подпись недели для списка в CM (как вносили руками). */
export const weekLabel = (monday: string): string => {
  const f = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
  return `${f(monday)}-${f(addDaysYmd(monday, 6))}`;
};

/** Значение дня: пробелы схлопнуты и обрезаны (на проде есть «Кристина » с хвостом). */
export const cleanName = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Все 7 дней обязательны (так требует схема при публикации). */
export const normalizeDays = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ShiftError(400, 'bad_days', 'Нет дней недели');
  }
  const out = {} as Record<(typeof DAY_KEYS)[number], string>;
  for (const key of DAY_KEYS) {
    const v = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : '';
    if (v != null && typeof v !== 'string') throw new ShiftError(400, 'bad_days', 'День — строка с именем');
    const name = cleanName(v);
    if (!name) throw new ShiftError(400, 'day_required', `Заполните день: ${DAY_CS[key]}`);
    if (name.length > MAX_NAME) throw new ShiftError(400, 'name_too_long', `${DAY_CS[key]}: не длиннее ${MAX_NAME} символов`);
    out[key] = name;
  }
  return out;
};

/** Дни документа → чистый объект (null, если компонента нет). */
export const pickDays = (days: any) => {
  if (!days || typeof days !== 'object') return null;
  const out = {} as Record<(typeof DAY_KEYS)[number], string>;
  for (const key of DAY_KEYS) out[key] = cleanName(days[key]);
  return out;
};

/** Что поменялось по дням: [{ day, from, to }]. `before` null — недели не было. */
export const diffDays = (before: any, after: any) =>
  DAY_KEYS.filter((k) => cleanName(before?.[k]) !== cleanName(after?.[k])).map((k) => ({
    day: k,
    from: cleanName(before?.[k]),
    to: cleanName(after?.[k]),
  }));

const fmtDay = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
const fmtShort = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

export const weekRange = (monday: string) => `${fmtShort(monday)}–${fmtDay(addDaysYmd(monday, 6))}`;

const listDays = (days: any) => DAY_KEYS.map((k) => `${DAY_CS[k]} ${cleanName(days?.[k]) || '—'}`).join(' · ');

/**
 * Строка журнала. Формат «Действие: неделя · дни» — журнал календаря (parseSummary)
 * берёт текст после «: » и делит по « · », первый кусок становится заголовком.
 */
export const logSummary = (verb: 'create' | 'update' | 'delete', monday: string, days: any, changes: any[] = []) => {
  const range = weekRange(monday);
  if (verb === 'create') return `Nový rozpis směn: ${range} · ${listDays(days)}`;
  if (verb === 'delete') return `Smazán rozpis směn: ${range} · ${listDays(days)}`;
  // дни те же — запись опубликована или поправлена дата конца недели
  if (!changes.length) return `Rozpis směn uložen: ${range} · beze změny dnů`;
  const what = changes.map((c) => `${DAY_CS[c.day]} ${c.from || '—'} → ${c.to || '—'}`).join(' · ');
  return `Změna rozpisu směn: ${range} · ${what}`;
};

/** Подсказки имён: частые сверху, пустые и «-» без смысла не предлагаются. */
export const suggestNames = (weeksDays: any[]): string[] => {
  const count = new Map<string, number>();
  for (const days of weeksDays) {
    for (const key of DAY_KEYS) {
      const name = cleanName(days?.[key]);
      if (!name || /^[-–—.]+$/.test(name)) continue;
      count.set(name, (count.get(name) || 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .slice(0, MAX_NAMES)
    .map(([name]) => name);
};

const sameInstant = (a: unknown, b: unknown): boolean => {
  if (a == null || a === '' || b == null || b === '') return (a == null || a === '') && (b == null || b === '');
  const ta = new Date(String(a)).getTime();
  const tb = new Date(String(b)).getTime();
  return Number.isFinite(ta) && ta === tb;
};

/**
 * Защита от одновременной правки: клиент присылает `base` — updatedAt той версии,
 * которую редактировал (null — недели не было). `undefined` — проверку не делать.
 */
export const assertBase = (base: unknown, current: any) => {
  if (base === undefined) return;
  if (!sameInstant(base, current?.updatedAt ?? null)) {
    throw new ShiftError(
      409,
      'shift_changed',
      'График этой недели только что изменили в другом окне — обновите страницу'
    );
  }
};

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const WEEK_FIELDS = ['week', 'from', 'to', 'updatedAt'];

const toWeek = (monday: string, doc: any, published: boolean) => ({
  monday,
  sunday: addDaysYmd(monday, 6),
  documentId: doc?.documentId ?? null,
  days: doc ? pickDays(doc.days) : null,
  published: Boolean(doc && published),
  updatedAt: doc?.updatedAt ?? null,
});

export default {
  _log(action: string, session: any, monday: string, documentId: string, days: any, changes: any[] = []) {
    const verb = action === 'shift_create' ? 'create' : action === 'shift_delete' ? 'delete' : 'update';
    const details: Record<string, string> = { týden: weekRange(monday) };
    for (const key of DAY_KEYS) {
      const c = changes.find((x) => x.day === key);
      details[DAY_CS[key]] = c && verb === 'update' ? `${c.from || '—'} → ${c.to || '—'}` : cleanName(days?.[key]) || '—';
    }
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'shift',
        actorName: session?.username || '',
        entityDocId: documentId,
        summary: logSummary(verb, monday, days, changes),
        details,
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /** Черновики недели (как читает календарь). На проде по одному документу на понедельник. */
  async _draftsOf(monday: string) {
    return strapi.documents(SHIFT_UID).findMany({
      status: 'draft',
      filters: { from: { $eq: monday } },
      fields: WEEK_FIELDS,
      populate: { days: true },
      limit: 5,
    });
  },

  /** Окно недель `weeks` штук с понедельника `from` + подсказки имён. */
  async list({ from, weeks, now = new Date() }: { from: unknown; weeks?: unknown; now?: Date }) {
    const today = PRAGUE_DAY.format(now);
    const first = parseMonday(from, today);
    const n = parseWeeks(weeks);
    const last = addDaysYmd(first, 7 * (n - 1));
    const namesFrom = addDaysYmd(last, -7 * NAMES_LOOKBACK_WEEKS);

    const [drafts, pubs] = await Promise.all([
      strapi.documents(SHIFT_UID).findMany({
        status: 'draft',
        filters: { from: { $gte: namesFrom < first ? namesFrom : first, $lte: last } },
        fields: WEEK_FIELDS,
        populate: { days: true },
        sort: 'from:asc',
        limit: 200,
      }),
      strapi.documents(SHIFT_UID).findMany({
        status: 'published',
        filters: { from: { $gte: first, $lte: last } },
        fields: ['from'],
        limit: 200,
      }),
    ]);

    const published = new Set(pubs.map((d) => d.documentId));
    const byMonday = new Map();
    for (const d of drafts) {
      const key = String(d.from).slice(0, 10);
      if (!byMonday.has(key)) byMonday.set(key, []);
      byMonday.get(key).push(d);
    }

    const out = [];
    for (let i = 0; i < n; i++) {
      const monday = addDaysYmd(first, 7 * i);
      const docs = byMonday.get(monday) || [];
      out.push({ ...toWeek(monday, docs[0], published.has(docs[0]?.documentId)), duplicate: docs.length > 1 });
    }
    const names = suggestNames(drafts.filter((d) => String(d.from).slice(0, 10) >= namesFrom).map((d) => d.days));
    return { from: first, weeks: out, names };
  },

  /** Сохранить график недели: создать или обновить черновик и опубликовать. */
  async save({ session, monday, body, now = new Date() }: { session: any; monday: unknown; body: any; now?: Date }) {
    const m = parseMonday(monday, PRAGUE_DAY.format(now));
    const days = normalizeDays(body?.days);
    const sunday = addDaysYmd(m, 6);

    const existing = await this._draftsOf(m);
    if (existing.length > 1) {
      throw new ShiftError(409, 'shift_duplicate', 'На эту неделю в базе две записи графика — исправьте в Strapi');
    }
    const cur = existing[0] || null;
    assertBase(body?.base, cur);

    const before = cur ? pickDays(cur.days) : null;
    const changes = diffDays(before, days);

    let documentId;
    if (!cur) {
      const doc = await strapi.documents(SHIFT_UID).create({
        status: 'published',
        data: { week: weekLabel(m), from: m, to: sunday, days },
      });
      documentId = doc.documentId;
    } else {
      documentId = cur.documentId;
      const pub = await strapi.documents(SHIFT_UID).findOne({ documentId, status: 'published', fields: ['from'] });
      const tidy = String(cur.to ?? '').slice(0, 10) === sunday && cur.week === weekLabel(m);
      if (!changes.length && pub && tidy) {
        return { week: toWeek(m, cur, true), unchanged: true };
      }
      await strapi.documents(SHIFT_UID).update({
        documentId,
        data: { week: weekLabel(m), to: sunday, days },
      });
      await strapi.documents(SHIFT_UID).publish({ documentId });
    }

    const saved = await strapi.documents(SHIFT_UID).findOne({
      documentId,
      status: 'draft',
      fields: WEEK_FIELDS,
      populate: { days: true },
    });
    this._log(cur ? 'shift_update' : 'shift_create', session, m, documentId, days, changes);
    return { week: toWeek(m, saved, true), unchanged: false };
  },

  /** Удалить график недели целиком (черновик и публикацию). */
  async remove({ session, monday, base, now = new Date() }: { session: any; monday: unknown; base?: unknown; now?: Date }) {
    const m = parseMonday(monday, PRAGUE_DAY.format(now));
    const existing = await this._draftsOf(m);
    if (!existing.length) throw new ShiftError(404, 'shift_not_found', 'Графика на эту неделю уже нет');
    if (existing.length > 1) {
      throw new ShiftError(409, 'shift_duplicate', 'На эту неделю в базе две записи графика — исправьте в Strapi');
    }
    const cur = existing[0];
    assertBase(base, cur);
    await strapi.documents(SHIFT_UID).delete({ documentId: cur.documentId });
    this._log('shift_delete', session, m, cur.documentId, pickDays(cur.days));
    return { deleted: m };
  },
};
