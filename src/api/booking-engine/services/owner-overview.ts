// @ts-nocheck
/**
 * «Сейчас» на главной владельца (s258): касса и последняя закрытая смена.
 *
 *   • касса — последняя запись «Деньги» (`cash`) по дате: `sum` — остаток в кассе после
 *     смены (lifecycle проверяет, что он сходится с потоком), приход/расход дня — из строк
 *     `flow`; берём ЧЕРНОВИК (он самый свежий: запись текущей, ещё не закрытой смены тоже
 *     видна) и отмечаем, опубликована ли она закрытием смены;
 *   • последняя закрытая смена — из журнала `calendar_logs` (entityType shift_close): самое
 *     свежее `shift_close`, которое не отменено более поздним `shift_revert` того же дня.
 *     Результат смены (до → после, как на странице «Uzavření směny») страница дописывает в
 *     `details` после публикации (`shift-close-log.logResult`) — у закрытий до s258 его нет.
 *
 * Только чтение. Гейт — владелец, в контроллере. Верх файла — чистые функции
 * (tests/owner-overview.test.mjs), ниже — сервис.
 */

const CASH_UID = 'api::cash.cash';
const LOG_UID = 'api::calendar-log.calendar-log';

/** Сколько последних записей журнала смотреть: закрытие и отмена идут парами, 40 с запасом. */
export const LOG_LOOKBACK = 40;

// суммы кассы — текст из панели: бывают «12 350» и «445,5»
const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const asObject = (v: unknown) => {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Последняя закрытая смена по записям журнала, отсортированным от свежих к старым.
 * День считается закрытым, если после его `shift_close` нет `shift_revert` этого же дня.
 */
export const pickLastClosedShift = (rows: any[]) => {
  const reverted = new Set<string>();
  for (const r of rows || []) {
    const date = String(r?.entityDocId || '');
    if (r?.action === 'shift_revert') reverted.add(date);
    else if (r?.action === 'shift_close' && !reverted.has(date)) {
      const d = asObject(r.details) || {};
      const hasResult = Number.isFinite(Number(d.resultBefore)) && Number.isFinite(Number(d.resultAfter));
      return {
        date,
        closedAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        by: r.actorName || '',
        published: Number(d['zveřejněno']) || 0,
        result: hasResult ? { before: Number(d.resultBefore), after: Number(d.resultAfter) } : null,
      };
    }
  }
  return null;
};

/** Касса наружу: остаток, приход и расход дня по строкам потока. */
export const cashView = (doc: any, closed: boolean) => {
  if (!doc) return null;
  let income = 0;
  let outflow = 0;
  for (const f of Array.isArray(doc.flow) ? doc.flow : []) {
    const s = num(f?.sum);
    if (s >= 0) income += s;
    else outflow += s;
  }
  return {
    date: doc.date || null,
    balance: num(doc.sum),
    income,
    outflow,
    name: doc.name || doc.personal?.name || '',
    closed,
  };
};

export default {
  async overview() {
    const [cash, lastShift] = await Promise.all([this.cash(), this.lastShift()]);
    return { cash, lastShift };
  },

  async cash() {
    const doc = await strapi.documents(CASH_UID).findFirst({
      status: 'draft',
      sort: { date: 'desc' },
      fields: ['date', 'sum', 'profit', 'name'],
      populate: { flow: { fields: ['sum'] }, personal: { fields: ['name'] } },
    });
    if (!doc) return null;
    const published = await strapi.documents(CASH_UID).findOne({ documentId: doc.documentId, status: 'published', fields: ['id'] });
    return cashView(doc, !!published);
  },

  async lastShift() {
    const rows = await strapi.db.query(LOG_UID).findMany({
      where: { entityType: 'shift_close', action: { $in: ['shift_close', 'shift_revert'] } },
      select: ['action', 'entityDocId', 'actorName', 'details', 'createdAt'],
      orderBy: { createdAt: 'desc' },
      limit: LOG_LOOKBACK,
    });
    return pickLastClosedShift(rows || []);
  },
};
