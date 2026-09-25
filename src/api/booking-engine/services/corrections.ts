// @ts-nocheck
/**
 * Корректировки зарплат из админки (s215, Фаза C плана «Управляющая»):
 * штрафы, доп. заработок, списания, авансы, выплаты и налоги. Раньше — только Strapi CM.
 *
 * Пишет ОПУБЛИКОВАННУЮ запись (как кнопка Publish в CM): зарплаты и итоги
 * месяца читают только published. Связь `personal` document service сам
 * раскладывает на обе версии: черновик → черновик карточки, публикация →
 * опубликованная карточка.
 *
 * 🟥 Записи с `source` (upsell / internal / korekce) ведёт движок — здесь они
 * только показываются, удалить нельзя (409): их жизнь привязана к брони.
 *
 * Гейт — руководство (owner + manager), в контроллере. Журнал — calendar_logs,
 * entityType `correction`.
 *
 * Верх файла — чистые функции (tests/corrections.test.mjs), ниже — сервис.
 */

export class CorrectionError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Типы корректировок. `text` — поле описания (у доп. заработка это обязательный
 * `title`, у остальных `comment`), `hasSource` — есть ли в схеме поле `source`,
 * `textRequired` — без причины запись не принимается (за что штраф/премия/списание).
 */
export const CORRECTION_KINDS = {
  penalty: { uid: 'api::penalty.penalty', text: 'comment', hasSource: false, textRequired: true, cs: 'Pokuta' },
  'add-money': { uid: 'api::add-money.add-money', text: 'title', hasSource: true, textRequired: true, cs: 'Příplatek' },
  payroll: { uid: 'api::payroll.payroll', text: 'comment', hasSource: true, textRequired: true, cs: 'Odpis ze mzdy' },
  avans: { uid: 'api::avans.avans', text: 'comment', hasSource: false, textRequired: false, cs: 'Záloha' },
  salary: { uid: 'api::salary.salary', text: 'comment', hasSource: false, textRequired: false, cs: 'Výplata' },
  // налоги за сотрудника (s215): у схемы обязательный enum `type`
  tax: { uid: 'api::tax.tax', text: 'comment', hasSource: false, textRequired: false, cs: 'Daně' },
} as const;

export const KIND_KEYS = Object.keys(CORRECTION_KINDS);

/** Вид налога — enum `tax.type` схемы. */
export const TAX_TYPES = { all: 'vše', social: 'sociální', health: 'zdravotní', income: 'daň z příjmu' } as const;

/** Потолок суммы одной записи — защита от лишнего нуля (месячная зарплата ~30–60 тыс.). */
export const MAX_SUM_KC = 300000;
export const MAX_TEXT = 500;
/** Дата вперёд — не дальше этого числа дней (опечатка в годе). */
export const MAX_FUTURE_DAYS = 45;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;

export const isValidYmd = (s: unknown): boolean => {
  const v = String(s ?? '');
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** YYYY-MM → первый и последний день месяца включительно. */
export const monthRange = (raw: unknown): { from: string; to: string } => {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw new CorrectionError(400, 'bad_month', 'Месяц в формате ГГГГ-ММ');
  const last = new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate();
  return { from: `${s}-01`, to: `${s}-${String(last).padStart(2, '0')}` };
};

export const kindMeta = (kind: unknown) => {
  const meta = CORRECTION_KINDS[String(kind ?? '')];
  if (!meta || !Object.prototype.hasOwnProperty.call(CORRECTION_KINDS, String(kind))) {
    throw new CorrectionError(400, 'bad_kind', 'Неизвестный тип корректировки');
  }
  return meta;
};

/**
 * Проверка формы. Сумма — целые кроны > 0 (у штрафа/списания/аванса/выплаты
 * колонка biginteger, знак задаёт тип, а не число). `today` — пражская дата.
 */
export const normalizeCorrectionInput = (body: any, today: string) => {
  const b = body || {};
  const kind = String(b.kind ?? '');
  const meta = kindMeta(kind);

  const personal = String(b.personal ?? '').trim();
  if (!personal) throw new CorrectionError(400, 'personal_required', 'Выберите сотрудника');
  if (!DOC_ID.test(personal)) throw new CorrectionError(400, 'personal_not_found', 'Сотрудник не найден');

  const date = String(b.date ?? '').trim();
  if (!isValidYmd(date)) throw new CorrectionError(400, 'bad_date', 'Дата в формате ГГГГ-ММ-ДД');
  if (date > addDaysYmd(today, MAX_FUTURE_DAYS)) {
    throw new CorrectionError(400, 'date_too_far', 'Дата слишком далеко в будущем');
  }

  const rawSum = typeof b.sum === 'number' ? b.sum : Number(String(b.sum ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(rawSum) || rawSum <= 0) throw new CorrectionError(400, 'bad_sum', 'Сумма — положительное число');
  if (!Number.isInteger(rawSum)) throw new CorrectionError(400, 'bad_sum', 'Сумма — целые кроны');
  if (rawSum > MAX_SUM_KC) throw new CorrectionError(400, 'sum_too_big', `Сумма больше ${MAX_SUM_KC} Kč`);

  const text = String(b.text ?? '').trim();
  if (text.length > MAX_TEXT) throw new CorrectionError(400, 'text_too_long', `Комментарий длиннее ${MAX_TEXT} символов`);
  if (meta.textRequired && !text) throw new CorrectionError(400, 'text_required', 'Напишите, за что');

  if (kind !== 'tax') return { kind, personal, date, sum: rawSum, text };
  const taxType = String(b.taxType ?? '');
  if (!Object.prototype.hasOwnProperty.call(TAX_TYPES, taxType)) {
    throw new CorrectionError(400, 'bad_tax_type', 'Выберите вид налога');
  }
  return { kind, personal, date, sum: rawSum, text, taxType };
};

/** Запись, которую ведёт движок (дозапись / интерная услуга / коррекция). */
export const isEngineOwned = (doc: any): boolean => Boolean(String(doc?.source ?? '').trim());

const toKc = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Строка ответа списка. `draft` — у документа нет опубликованной версии. */
export const toRow = (kind: string, doc: any, draft: boolean) => {
  const meta = CORRECTION_KINDS[kind];
  const source = meta.hasSource ? String(doc?.source ?? '').trim() || null : null;
  return {
    kind,
    documentId: doc.documentId,
    date: doc.date ?? null,
    sum: toKc(doc.sum),
    text: String(doc?.[meta.text] ?? '').trim(),
    taxType: kind === 'tax' ? doc?.type ?? null : null,
    personal: doc.personal ? { documentId: doc.personal.documentId, name: String(doc.personal.name ?? '').trim() } : null,
    source,
    draft,
    readOnly: Boolean(source),
    createdAt: doc.createdAt ?? null,
  };
};

/** Свежие сверху: дата, затем время создания. */
export const sortRows = (rows: any[]) =>
  rows.sort(
    (a, b) =>
      String(b.date ?? '').localeCompare(String(a.date ?? '')) ||
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  );

const fmtDay = (ymd: string) => {
  const [y, m, d] = String(ymd).split('-');
  return `${d}.${m}.${y}`;
};

const fmtKc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ').replace(/ /g, ' ')} Kč`;

/** Строка журнала: «Pokuta: Yana −500 Kč · 25.09.2026 · pozdní příchod». */
export const logSummary = (verb: 'create' | 'delete', row: any): string => {
  const meta = CORRECTION_KINDS[row.kind];
  const head = verb === 'create' ? meta.cs : `Smazáno — ${meta.cs.toLowerCase()}`;
  const who = row.personal?.name || '—';
  const tail = row.text ? ` · ${row.text.slice(0, 80)}` : '';
  return `${head}: ${who} ${fmtKc(row.sum)} · ${fmtDay(row.date)}${tail}`;
};

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const fieldsOf = (meta: any) => [
  'date',
  'sum',
  meta.text,
  ...(meta.hasSource ? ['source'] : []),
  ...(meta === CORRECTION_KINDS.tax ? ['type'] : []),
  'createdAt',
];

export default {
  _log(action: string, session: any, row: any) {
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'correction',
        actorName: session?.username || '',
        entityDocId: row.documentId,
        employeeName: row.personal?.name || '',
        summary: logSummary(action === 'correction_create' ? 'create' : 'delete', row),
        details: {
          typ: row.taxType ? `${CORRECTION_KINDS[row.kind].cs} (${TAX_TYPES[row.taxType] || row.taxType})` : CORRECTION_KINDS[row.kind].cs,
          zaměstnanec: row.personal?.name || '—',
          datum: fmtDay(row.date),
          částka: fmtKc(row.sum),
          popis: row.text || '—',
        },
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /** Все корректировки месяца (опубликованные + черновики без публикации). */
  async list({ month, personal }: { month: unknown; personal?: unknown }) {
    const { from, to } = monthRange(month);
    const who = String(personal ?? '').trim();
    if (who && !DOC_ID.test(who)) throw new CorrectionError(400, 'personal_not_found', 'Сотрудник не найден');
    const filters: any = { date: { $gte: from, $lte: to } };
    if (who) filters.personal = { documentId: { $eq: who } };

    const perKind = await Promise.all(
      KIND_KEYS.map(async (kind) => {
        const meta = CORRECTION_KINDS[kind];
        const q = { filters, fields: fieldsOf(meta), populate: { personal: { fields: ['name'] } }, limit: 1000 };
        const [pub, drafts] = await Promise.all([
          strapi.documents(meta.uid).findMany({ ...q, status: 'published' }),
          strapi.documents(meta.uid).findMany({ ...q, status: 'draft' }),
        ]);
        const published = new Set(pub.map((d) => d.documentId));
        return [
          ...pub.map((d) => toRow(kind, d, false)),
          ...drafts.filter((d) => !published.has(d.documentId)).map((d) => toRow(kind, d, true)),
        ];
      })
    );
    return { month: from.slice(0, 7), rows: sortRows(perKind.flat()) };
  },

  async create({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const input = normalizeCorrectionInput(body, PRAGUE_DAY.format(now));
    const meta = CORRECTION_KINDS[input.kind];

    const person = await strapi.documents('api::personal.personal').findOne({
      documentId: input.personal,
      status: 'published',
      fields: ['name'],
    });
    if (!person) throw new CorrectionError(404, 'personal_not_found', 'Сотрудник не найден');

    const doc = await strapi.documents(meta.uid).create({
      status: 'published',
      data: {
        date: input.date,
        sum: String(input.sum),
        [meta.text]: input.text || null,
        personal: { documentId: input.personal },
        ...(input.kind === 'tax' ? { type: input.taxType } : {}),
      },
      fields: fieldsOf(meta),
      populate: { personal: { fields: ['name'] } },
    });
    const row = toRow(input.kind, { ...doc, personal: doc.personal || person }, false);
    this._log('correction_create', session, row);
    return { row };
  },

  async remove({ session, kind, documentId }: { session: any; kind: unknown; documentId: unknown }) {
    const meta = kindMeta(kind);
    const id = String(documentId ?? '').trim();
    if (!DOC_ID.test(id)) throw new CorrectionError(404, 'correction_not_found', 'Запись не найдена');

    const q = { documentId: id, fields: fieldsOf(meta), populate: { personal: { fields: ['name'] } } };
    const doc =
      (await strapi.documents(meta.uid).findOne({ ...q, status: 'published' })) ||
      (await strapi.documents(meta.uid).findOne({ ...q, status: 'draft' }));
    if (!doc) throw new CorrectionError(404, 'correction_not_found', 'Запись не найдена');
    if (meta.hasSource && isEngineOwned(doc)) {
      throw new CorrectionError(
        409,
        'correction_engine_owned',
        'Эту запись ведёт календарь (дозапись, интерная услуга или коррекция) — правится там'
      );
    }

    // удаляет документ целиком: и черновик, и опубликованную версию
    await strapi.documents(meta.uid).delete({ documentId: id });
    const row = toRow(String(kind), doc, false);
    this._log('correction_delete', session, row);
    return { deleted: id };
  },
};
