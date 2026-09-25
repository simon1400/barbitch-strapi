// @ts-nocheck
/**
 * Отпуска / больничные из админки + автоблоки в календаре (s216, Фаза D плана
 * «Управляющая»). Раньше записи `time-off` велись только в Strapi CM, а мастеру
 * на время отсутствия руками ставили серию блоков (у Марии — 125 штук).
 *
 * Запись отсутствия МАСТЕРА (position master, активна, есть noonaEmployeeId —
 * по нему календарь раскладывает блоки по колонкам) материализуется серией
 * own-блоков: по блоку на каждый день периода С СЕГОДНЯШНЕГО (пражского) дня
 * (решение владельца s216: прошлое не трогаем — ни календарь, ни загрузку
 * задним числом; блоки прошлых дней серии правка не удаляет, не переименовывает
 * и не переносит, их убирает только удаление записи), на часы салона этой даты
 * (строки `salon_hours` есть только на ~90 дней вперёд — дальше окно по
 * умолчанию 10:00–19:00, как ставил владелец). Блоки руководства — approved
 * сразу. Серия делит один `noonaKey` (`own|<uuid>`), он же хранится в
 * `time-off.blockSeriesKey` — по нему правка отсутствия доводит серию
 * (лишние дни удаляет, недостающие создаёт, остальные не трогает — ручные
 * правки блока в календаре сохраняются), удаление — убирает её.
 *
 * У администратора / управляющей колонки в календаре нет — блоков нет,
 * запись только учётная.
 *
 * Брони на эти дни блок НЕ отменяет: ручка `conflicts` показывает их в форме,
 * ответ create/update возвращает их же — переносит администратор.
 *
 * Гейт — руководство (owner + manager), в контроллере. Журнал — calendar_logs,
 * entityType `timeoff`.
 *
 * Верх файла — чистые функции (tests/time-offs.test.mjs), ниже — сервис.
 */

import crypto from 'crypto';
import { minToHHMM, pragueDateOf, pragueMinOf, pragueMinToUtcIso } from './slots-core';

const TIME_OFF_UID = 'api::time-off.time-off';
const TIME_BLOCK_UID = 'api::time-block.time-block';
const SALON_HOUR_UID = 'api::salon-hour.salon-hour';
const BOOKING_UID = 'api::booking.booking';
const PERSONAL_UID = 'api::personal.personal';

export class TimeOffError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Типы — enum схемы `time-off.type`. `block` — название блока в календаре. */
export const TIME_OFF_TYPES = {
  sick: { cs: 'Nemoc', block: 'Nemoc' },
  vacation: { cs: 'Dovolená', block: 'Dovolená' },
  personal: { cs: 'Volno', block: 'Volno' },
} as const;

/** Названия блоков, которые правка типа может переименовать (ручное название не трогаем). */
const AUTO_BLOCK_TITLES = new Set(Object.values(TIME_OFF_TYPES).map((t) => t.block));

/** Префикс own-блоков движка (как OWN_BLOCK_PREFIX в booking-engine): серия удаляется/одобряется по noonaKey. */
export const OWN_BLOCK_PREFIX = 'own|';

/** Окно блока, если часов салона на дату ещё нет (Noona-синк держит ~90 дней вперёд). */
export const DEFAULT_OPEN_MIN = 600;
export const DEFAULT_CLOSE_MIN = 1140;

/** Одна запись — не длиннее квартала (опечатка в годе дала бы сотни блоков). */
export const MAX_SPAN_DAYS = 92;
/** Начало — не дальше года вперёд. */
export const MAX_FUTURE_DAYS = 366;
export const MAX_COMMENT = 500;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;

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

/** Все даты периода, обе границы включительно. */
export const datesBetween = (from: string, to: string): string[] => {
  const out = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
};

/** Число дней периода включительно. */
export const spanDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Проверка формы. `base` — текущая запись при правке: отсутствующие в body поля
 * берутся из неё. `today` — пражская дата.
 */
export const normalizeTimeOffInput = (body: any, today: string, base: any = null) => {
  const b = body || {};
  const pick = (k: string) => (hasOwn(b, k) ? b[k] : base ? base[k] : undefined);

  const personal = String(pick('personal') ?? '').trim();
  if (!personal) throw new TimeOffError(400, 'personal_required', 'Выберите сотрудника');
  if (!DOC_ID.test(personal)) throw new TimeOffError(400, 'personal_not_found', 'Сотрудник не найден');

  const type = String(pick('type') ?? '');
  if (!hasOwn(TIME_OFF_TYPES, type)) throw new TimeOffError(400, 'bad_type', 'Неизвестный тип отсутствия');

  const startDate = String(pick('startDate') ?? '').trim();
  const endDate = String(pick('endDate') ?? '').trim();
  if (!isValidYmd(startDate) || !isValidYmd(endDate)) {
    throw new TimeOffError(400, 'bad_date', 'Даты в формате ГГГГ-ММ-ДД');
  }
  if (endDate < startDate) throw new TimeOffError(400, 'bad_range', 'Конец раньше начала');
  if (spanDays(startDate, endDate) > MAX_SPAN_DAYS) {
    throw new TimeOffError(400, 'range_too_long', `Одна запись — не больше ${MAX_SPAN_DAYS} дней`);
  }
  if (startDate > addDaysYmd(today, MAX_FUTURE_DAYS)) {
    throw new TimeOffError(400, 'date_too_far', 'Дата слишком далеко в будущем');
  }

  const rawPaid = pick('paid');
  const paid = rawPaid == null ? true : rawPaid === true || rawPaid === 'true';
  if (rawPaid != null && typeof rawPaid !== 'boolean' && rawPaid !== 'true' && rawPaid !== 'false') {
    throw new TimeOffError(400, 'bad_paid', 'Оплачиваемость — да/нет');
  }

  const comment = String(pick('comment') ?? '').trim();
  if (comment.length > MAX_COMMENT) {
    throw new TimeOffError(400, 'comment_too_long', `Комментарий длиннее ${MAX_COMMENT} символов`);
  }

  return { personal, type, startDate, endDate, paid, comment };
};

/** Мастер с колонкой в календаре — ему нужны блоки. */
export const needsBlocks = (person: any): boolean =>
  Boolean(person) &&
  person.position === 'master' &&
  person.isActive !== false &&
  Boolean(String(person.noonaEmployeeId ?? '').trim());

/** Окно блока на дату: часы салона, а без строки (или закрыто) — окно по умолчанию. */
export const blockWindow = (hour: any): { startMin: number; endMin: number } => {
  const o = Number(hour?.openMin);
  const c = Number(hour?.closeMin);
  if (hour && hour.openMin != null && hour.closeMin != null && Number.isFinite(o) && Number.isFinite(c) && c > o) {
    return { startMin: o, endMin: c };
  }
  return { startMin: DEFAULT_OPEN_MIN, endMin: DEFAULT_CLOSE_MIN };
};

/** Даты, на которые нужны блоки: период, но не раньше сегодняшнего дня. */
export const blockDates = (startDate: string, endDate: string, today: string): string[] =>
  endDate < today ? [] : datesBetween(startDate > today ? startDate : today, endDate);

/**
 * Довести серию до периода: какие блоки удалить (дата вне периода или дубль
 * даты), какие даты создать. Блоки внутри периода не трогаются.
 */
export const planBlockSync = (existing: Array<{ documentId: string; date: string }>, dates: string[]) => {
  const want = new Set(dates);
  const seen = new Set();
  const toDelete = [];
  for (const b of existing) {
    const d = String(b.date);
    if (!want.has(d) || seen.has(d)) toDelete.push(b);
    else seen.add(d);
  }
  const toCreate = dates.filter((d) => !seen.has(d));
  return { toDelete, toCreate, kept: seen.size };
};

const fmtDay = (ymd: string) => {
  const [y, m, d] = String(ymd).split('-');
  return `${d}.${m}.${y}`;
};

export const periodLabel = (from: string, to: string) =>
  from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;

/** Строка журнала: «Dovolená: Yana 01.10.2026 – 07.10.2026 (7 dní) · 7 bloků». */
export const logSummary = (verb: 'create' | 'update' | 'delete', row: any, blocks: number): string => {
  const t = TIME_OFF_TYPES[row.type]?.cs || row.type;
  const head = verb === 'create' ? t : verb === 'update' ? `Upraveno — ${t.toLowerCase()}` : `Smazáno — ${t.toLowerCase()}`;
  const days = spanDays(row.startDate, row.endDate);
  const tail = blocks > 0 ? ` · ${blocks} ${blocks === 1 ? 'blok' : blocks <= 4 ? 'bloky' : 'bloků'}` : '';
  return `${head}: ${row.personal?.name || '—'} ${periodLabel(row.startDate, row.endDate)} (${days} ${days === 1 ? 'den' : days <= 4 ? 'dny' : 'dní'})${tail}`;
};

/** Строка ответа. */
export const toRow = (doc: any) => ({
  documentId: doc.documentId,
  type: doc.type,
  startDate: doc.startDate,
  endDate: doc.endDate,
  paid: doc.paid !== false,
  comment: String(doc.comment ?? '').trim() || null,
  personal: doc.personal ? { documentId: doc.personal.documentId, name: String(doc.personal.name ?? '').trim() } : null,
  blockSeriesKey: doc.blockSeriesKey || null,
});

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PERSON_FIELDS = ['name', 'position', 'isActive', 'noonaEmployeeId'];
const ROW_FIELDS = ['type', 'startDate', 'endDate', 'paid', 'comment', 'blockSeriesKey'];

export default {
  async _person(documentId: string) {
    const p = await strapi.documents(PERSONAL_UID).findOne({ documentId, status: 'published', fields: PERSON_FIELDS });
    if (!p) throw new TimeOffError(404, 'personal_not_found', 'Сотрудник не найден');
    return p;
  },

  async _find(documentId: unknown) {
    const id = String(documentId ?? '').trim();
    if (!DOC_ID.test(id)) throw new TimeOffError(404, 'timeoff_not_found', 'Запись не найдена');
    const doc = await strapi.documents(TIME_OFF_UID).findOne({
      documentId: id,
      fields: ROW_FIELDS,
      populate: { personal: { fields: ['name'] } },
    });
    if (!doc) throw new TimeOffError(404, 'timeoff_not_found', 'Запись не найдена');
    return doc;
  },

  /** Другое отсутствие того же сотрудника, пересекающее период (дни посчитались бы дважды). */
  async _assertNoOverlap(input, excludeDocId = null) {
    const found = await strapi.documents(TIME_OFF_UID).findMany({
      filters: {
        personal: { documentId: { $eq: input.personal } },
        startDate: { $lte: input.endDate },
        endDate: { $gte: input.startDate },
      },
      fields: ['type', 'startDate', 'endDate'],
      limit: 50,
    });
    const other = found.find((d) => d.documentId !== excludeDocId);
    if (other) {
      throw new TimeOffError(
        409,
        'timeoff_overlap',
        `У сотрудника уже есть запись на эти дни: ${periodLabel(other.startDate, other.endDate)}`
      );
    }
  },

  /**
   * Активные брони мастера на дни периода, ещё не начавшиеся. Блок их не
   * отменяет — их надо перенести. Администратору / управляющей — пусто.
   */
  async conflicts({ personal, startDate, endDate, now = new Date() }) {
    const pid = String(personal ?? '').trim();
    if (!DOC_ID.test(pid)) throw new TimeOffError(400, 'personal_not_found', 'Сотрудник не найден');
    if (!isValidYmd(startDate) || !isValidYmd(endDate) || endDate < startDate) {
      throw new TimeOffError(400, 'bad_date', 'Даты в формате ГГГГ-ММ-ДД');
    }
    if (spanDays(startDate, endDate) > MAX_SPAN_DAYS) {
      throw new TimeOffError(400, 'range_too_long', `Одна запись — не больше ${MAX_SPAN_DAYS} дней`);
    }
    const person = await this._person(pid);
    if (!needsBlocks(person)) return { rows: [] };
    const today = PRAGUE_DAY.format(now);
    const from = startDate > today ? startDate : today;
    if (from > endDate) return { rows: [] };
    const found = await strapi.documents(BOOKING_UID).findMany({
      filters: {
        status: 'active',
        date: { $gte: from, $lte: endDate },
        $or: [
          { employee: { documentId: { $eq: pid } } },
          { engineEmployeeId: { $eq: pid } },
          { noonaEmployeeId: { $eq: person.noonaEmployeeId } },
        ],
      },
      fields: ['date', 'startsAt', 'clientNameRaw', 'internal'],
      sort: ['startsAt:asc'],
      limit: 500,
    });
    const nowMs = now.getTime();
    const rows = found
      .filter((b) => !b.startsAt || new Date(b.startsAt).getTime() > nowMs)
      .map((b) => ({
        documentId: b.documentId,
        date: String(b.date),
        time: b.startsAt && pragueDateOf(b.startsAt) === String(b.date) ? minToHHMM(pragueMinOf(b.startsAt)) : null,
        client: String(b.clientNameRaw ?? '').trim() || null,
        internal: b.internal === true,
      }));
    return { rows };
  },

  /**
   * Довести серию блоков до записи. Возвращает ключ серии (null — блоков нет)
   * и число блоков после синхронизации.
   */
  async _syncBlocks({ key, person, personDocId, type, startDate, endDate, session, today }) {
    const all = key
      ? await strapi.documents(TIME_BLOCK_UID).findMany({
          filters: { noonaKey: { $eq: key } },
          fields: ['date', 'title'],
          populate: { employee: { fields: ['name'] } },
          limit: 1000,
        })
      : [];
    // прошлые дни серии не трогаем никогда — только сегодня и дальше
    const past = all.filter((b) => String(b.date) < today);
    const existing = all.filter((b) => String(b.date) >= today);

    if (!needsBlocks(person)) {
      for (const b of existing) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
      return { key: past.length ? key : null, count: past.length, created: 0, deleted: existing.length };
    }

    // серия чужого сотрудника (в записи сменили человека) — снести целиком
    const foreign = existing.filter((b) => b.employee && b.employee.documentId !== personDocId);
    for (const b of foreign) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
    const own = existing.filter((b) => !foreign.includes(b));

    const seriesKey = key || `${OWN_BLOCK_PREFIX}${crypto.randomUUID()}`;
    const plan = planBlockSync(own, blockDates(startDate, endDate, today));
    for (const b of plan.toDelete) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });

    const title = TIME_OFF_TYPES[type].block;
    // смена типа: автоназвания переименовать, ручные — оставить
    for (const b of own) {
      if (plan.toDelete.includes(b)) continue;
      if (b.title !== title && AUTO_BLOCK_TITLES.has(b.title)) {
        await strapi.documents(TIME_BLOCK_UID).update({ documentId: b.documentId, data: { title } });
      }
    }

    if (plan.toCreate.length) {
      const hours = await strapi.documents(SALON_HOUR_UID).findMany({
        filters: { date: { $gte: plan.toCreate[0], $lte: plan.toCreate[plan.toCreate.length - 1] } },
        fields: ['date', 'openMin', 'closeMin'],
        limit: 1000,
      });
      const hoursByDate = new Map(hours.map((h) => [String(h.date), h]));
      const approvedAt = new Date().toISOString();
      for (const d of plan.toCreate) {
        const w = blockWindow(hoursByDate.get(d));
        await strapi.documents(TIME_BLOCK_UID).create({
          data: {
            noonaKey: seriesKey,
            noonaBlockedId: '',
            noonaEmployeeId: person.noonaEmployeeId,
            // связь объектом — documentId с ведущей цифрой Strapi принял бы за id
            employee: { documentId: personDocId },
            employeeNameRaw: person.name,
            date: d,
            startsAt: pragueMinToUtcIso(d, w.startMin),
            endsAt: pragueMinToUtcIso(d, w.endMin),
            title,
            theme: '',
            createdByName: session?.username || '',
            // ручка только для руководства — блок действует сразу
            approvalStatus: 'approved',
            approvedByName: session?.username || '',
            approvedAt,
          },
        });
      }
    }
    const count = past.length + plan.kept + plan.toCreate.length;
    return {
      key: count > 0 ? seriesKey : null,
      count,
      created: plan.toCreate.length,
      deleted: plan.toDelete.length + foreign.length,
    };
  },

  /** Удалить все блоки серии; возвращает, сколько удалено. */
  async _dropSeries(key: string) {
    const blocks = await strapi.documents(TIME_BLOCK_UID).findMany({
      filters: { noonaKey: { $eq: key } },
      fields: ['date'],
      limit: 1000,
    });
    for (const b of blocks) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
    return blocks.length;
  },

  _log(action: string, session: any, row: any, blocks: number, extra: Record<string, unknown> = {}) {
    const verb = action === 'timeoff_create' ? 'create' : action === 'timeoff_update' ? 'update' : 'delete';
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'timeoff',
        actorName: session?.username || '',
        entityDocId: row.documentId,
        employeeName: row.personal?.name || '',
        summary: logSummary(verb, row, blocks),
        details: {
          typ: TIME_OFF_TYPES[row.type]?.cs || row.type,
          zaměstnanec: row.personal?.name || '—',
          od: fmtDay(row.startDate),
          do: fmtDay(row.endDate),
          placené: row.paid ? 'ano' : 'ne',
          poznámka: row.comment || null,
          bloky: blocks > 0 ? String(blocks) : null,
          ...extra,
        },
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  async create({ session, body, now = new Date() }) {
    const today = PRAGUE_DAY.format(now);
    const input = normalizeTimeOffInput(body, today);
    const person = await this._person(input.personal);
    if (person.isActive === false) throw new TimeOffError(404, 'personal_not_found', 'Сотрудник не найден');
    await this._assertNoOverlap(input);

    // ключ серии заводим заранее — при сбое посередине по нему удаляются и уже созданные блоки
    const newKey =
      needsBlocks(person) && blockDates(input.startDate, input.endDate, today).length
        ? `${OWN_BLOCK_PREFIX}${crypto.randomUUID()}`
        : null;

    const doc = await strapi.documents(TIME_OFF_UID).create({
      data: {
        personal: { documentId: input.personal },
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        paid: input.paid,
        comment: input.comment || null,
        blockSeriesKey: newKey,
      },
      fields: ROW_FIELDS,
    });

    let sync;
    try {
      sync = await this._syncBlocks({
        key: newKey,
        person,
        personDocId: input.personal,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        session,
        today,
      });
    } catch (e) {
      // без блоков запись не оставляем — иначе мастер «в отпуске», а сайт его продаёт
      strapi.log.error(`time-off blocks failed, rolling back ${doc.documentId}: ${e.message}`);
      await strapi.documents(TIME_OFF_UID).delete({ documentId: doc.documentId }).catch(() => undefined);
      if (newKey) await this._dropSeries(newKey).catch(() => undefined);
      throw e;
    }
    const row = toRow({ ...doc, ...input, comment: input.comment, blockSeriesKey: sync.key, personal: { documentId: input.personal, name: person.name } });
    this._log('timeoff_create', session, row, sync.count);
    const { rows: conflicts } = await this.conflicts({ ...input, now });
    return { row, blocks: sync.count, conflicts };
  },

  async update({ session, documentId, body, now = new Date() }) {
    const doc = await this._find(documentId);
    const base = {
      personal: doc.personal?.documentId || '',
      type: doc.type,
      startDate: doc.startDate,
      endDate: doc.endDate,
      paid: doc.paid,
      comment: doc.comment,
    };
    const today = PRAGUE_DAY.format(now);
    const input = normalizeTimeOffInput(body, today, base);
    const person = await this._person(input.personal);
    if (input.personal !== base.personal && person.isActive === false) {
      throw new TimeOffError(404, 'personal_not_found', 'Сотрудник не найден');
    }
    await this._assertNoOverlap(input, doc.documentId);

    await strapi.documents(TIME_OFF_UID).update({
      documentId: doc.documentId,
      data: {
        ...(input.personal !== base.personal ? { personal: { documentId: input.personal } } : {}),
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        paid: input.paid,
        comment: input.comment || null,
      },
    });
    const sync = await this._syncBlocks({
      key: doc.blockSeriesKey || null,
      person,
      personDocId: input.personal,
      type: input.type,
      startDate: input.startDate,
      endDate: input.endDate,
      session,
      today,
    });
    if ((sync.key || null) !== (doc.blockSeriesKey || null)) {
      await strapi.documents(TIME_OFF_UID).update({ documentId: doc.documentId, data: { blockSeriesKey: sync.key } });
    }

    const row = toRow({ documentId: doc.documentId, ...input, blockSeriesKey: sync.key, personal: { documentId: input.personal, name: person.name } });
    const changes = [];
    if (base.personal !== input.personal) changes.push(`zaměstnanec: ${doc.personal?.name || '—'} → ${person.name}`);
    if (base.type !== input.type) changes.push(`typ: ${TIME_OFF_TYPES[base.type]?.cs || base.type} → ${TIME_OFF_TYPES[input.type].cs}`);
    if (base.startDate !== input.startDate || base.endDate !== input.endDate) {
      changes.push(`období: ${periodLabel(base.startDate, base.endDate)} → ${periodLabel(input.startDate, input.endDate)}`);
    }
    this._log('timeoff_update', session, row, sync.count, {
      změny: changes.length ? changes.join('; ') : null,
      'bloky přidáno': sync.created ? String(sync.created) : null,
      'bloky smazáno': sync.deleted ? String(sync.deleted) : null,
    });
    const { rows: conflicts } = await this.conflicts({ ...input, now });
    return { row, blocks: sync.count, conflicts };
  },

  async remove({ session, documentId }) {
    const doc = await this._find(documentId);
    const deletedBlocks = doc.blockSeriesKey ? await this._dropSeries(doc.blockSeriesKey) : 0;
    await strapi.documents(TIME_OFF_UID).delete({ documentId: doc.documentId });
    this._log('timeoff_delete', session, toRow(doc), deletedBlocks);
    return { deleted: doc.documentId, blocks: deletedBlocks };
  },
};
