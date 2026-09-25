// @ts-nocheck
/**
 * Дашборд «Сегодня» (s214, Фаза B плана «Управляющая»): что в салоне требует
 * внимания руководства. Здесь — только то, что админка не может собрать сама
 * без десятка запросов: связь брони с записью об услуге, черновики без
 * публикации, ожидающие переносы корекций, ваучеры. Блоки «Ke schválení»,
 * дозаписи без результата и «кто сегодня работает» админка берёт из уже
 * существующих ручек.
 *
 * Всё — чтение, ничего не пишет. Гейт — руководство (owner + manager), в контроллере.
 *
 * Верх файла — чистые функции (tests/today.test.mjs), ниже — сервис.
 */

import { pragueDateOf } from './slots-core';

const SP_UID = 'api::service-provided.service-provided';

/** Незакрытые визиты ищем за неделю: смену закрывают вечером, хвосты — за пару дней. */
export const UNCLOSED_VISIT_DAYS = 7;
/** Незакрытые смены — за две недели до вчерашнего дня включительно. */
export const OPEN_SHIFT_DAYS = 14;
/** Ваучеры: оплаченные за 7 дней (кому отправить potvrzení) и неоплаченные заказы за 30. */
export const VOUCHER_PAID_DAYS = 7;
export const VOUCHER_UNPAID_DAYS = 30;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** Дата запроса: валидная YYYY-MM-DD или пражское «сегодня». */
export const resolveDate = (raw: unknown, now: Date): string => {
  const s = String(raw ?? '').trim();
  if (YMD.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return s;
  return pragueDateOf(now);
};

/** Окна дат дашборда (все границы включительно). */
export const todayRanges = (date: string) => ({
  visits: { from: addDaysYmd(date, -(UNCLOSED_VISIT_DAYS - 1)), to: date },
  shifts: { from: addDaysYmd(date, -OPEN_SHIFT_DAYS), to: addDaysYmd(date, -1) },
  vouchersPaidFrom: addDaysYmd(date, -(VOUCHER_PAID_DAYS - 1)),
  vouchersUnpaidFrom: addDaysYmd(date, -(VOUCHER_UNPAID_DAYS - 1)),
});

const titlesOf = (services: unknown): string[] => {
  let list = services;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((s) => String(s?.title || '').trim()).filter(Boolean);
};

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.'));
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
 * Визит без записи об услуге. `active` — время вышло, а визит не закрыт (или клиент
 * не пришёл и неявку не отметили); `checkedOut` без записи — закрыт мимо формы.
 */
export const mapUnclosedVisit = (r: any) => ({
  documentId: r.documentId,
  date: r.date,
  startsAt: r.startsAt ? new Date(r.startsAt).toISOString() : null,
  status: r.status,
  reason: r.status === 'checkedOut' ? 'checked_out_no_record' : 'not_closed',
  arrived: r.arrived === true,
  internal: r.internal === true,
  korekce: r.korekce === true,
  client: r.client || '',
  master: r.master || '',
  services: titlesOf(r.services),
});

/** Строки черновиков по дням → [{ date, services, hours }] по возрастанию даты. */
export const mergeOpenShifts = (spRows: any[], wtRows: any[]) => {
  const byDate = new Map<string, { date: string; services: number; hours: number }>();
  const at = (d: string) => {
    if (!byDate.has(d)) byDate.set(d, { date: d, services: 0, hours: 0 });
    return byDate.get(d);
  };
  for (const r of spRows || []) at(r.date).services += Number(r.n) || 0;
  for (const r of wtRows || []) at(r.date).hours += Number(r.n) || 0;
  return [...byDate.values()].filter((x) => x.services + x.hours > 0).sort((a, b) => a.date.localeCompare(b.date));
};

/**
 * Ожидающие переносы корекций. У документа две строки (draft + published) с одним
 * json — берём по одной, предпочитая черновик (его правит движок первым).
 */
export const mapKorekcePending = (rows: any[]) => {
  const byDoc = new Map();
  for (const r of rows || []) {
    if (!byDoc.has(r.document_id) || r.published_at == null) byDoc.set(r.document_id, r);
  }
  const out = [];
  for (const r of byDoc.values()) {
    const j = asObject(r.korekce);
    if (!j || j.mode !== 'record' || j.pending !== true) continue;
    out.push({
      spDocId: r.document_id,
      clientName: j.clientName || '',
      korekceDate: j.korekceDate || null,
      korekceBookingDocId: j.korekceBookingDocId || null,
      master: j.master || '',
      originalDate: j.originalDate || null,
      originalBookingDocId: j.originalBookingDocId || null,
      originalMaster: j.originalMaster || '',
      staffInKc: num(j.staffInKc),
      staffOutKc: num(j.staffOutKc),
    });
  }
  return out.sort((a, b) => String(a.originalDate).localeCompare(String(b.originalDate)));
};

export const mapVoucher = (r: any) => ({
  documentId: r.documentId,
  idVoucher: r.idVoucher || '',
  name: r.name || '',
  for: r.forName || '',
  sum: num(r.sum),
  dateOrder: r.dateOrder || null,
  datePay: r.datePay || null,
});

// Имя join-таблицы — из метаданных Strapi, не хардкодом (длинные имена укорачиваются с хэшем, s204)
const joinTableOf = (uid: string, attrName: string) => {
  const jt = strapi.db.metadata.get(uid)?.attributes?.[attrName]?.joinTable;
  if (!jt?.name || !jt?.joinColumn?.name || !jt?.inverseJoinColumn?.name) return null;
  return { table: jt.name, sourceCol: jt.joinColumn.name, targetCol: jt.inverseJoinColumn.name };
};

// ── сервис ───────────────────────────────────────────────────────────────────

export default {
  async overview({ date: rawDate, now = new Date() }: { date?: unknown; now?: Date } = {}) {
    const date = resolveDate(rawDate, now);
    const r = todayRanges(date);
    const [unclosedVisits, openShifts, korekcePending, vouchers] = await Promise.all([
      this.unclosedVisits(r.visits, now),
      this.openShifts(r.shifts),
      this.korekcePending(),
      this.vouchers(r),
    ]);
    return { date, now: now.toISOString(), unclosedVisits, openShifts, korekcePending, vouchers };
  },

  async unclosedVisits(range: { from: string; to: string }, now: Date) {
    const knex = strapi.db.connection;
    const jt = joinTableOf(SP_UID, 'booking');
    // 🟥 starts_at/ends_at — `timestamp without time zone`, хранят UTC. Драйвер pg читает
    // такую колонку по часовому поясу ПРОЦЕССА, а Date в параметре пишет с локальным
    // смещением, которое Postgres для этого типа молча отбрасывает. На сервере (UTC)
    // совпадает случайно, на машине в Праге — сдвиг на 2 ч (поймано проверкой в
    // браузере s214). Поэтому и туда, и обратно — только строка UTC.
    const nowUtc = now.toISOString();
    if (!jt) throw new Error('today: join table services_provided.booking not found');
    const rows = await knex('bookings as b')
      .where('b.date', '>=', range.from)
      .where('b.date', '<=', range.to)
      .where((w) => {
        w.where((a) => a.where('b.status', 'active').where('b.ends_at', '<', nowUtc)).orWhere('b.status', 'checkedOut');
      })
      .whereNotExists(knex.select(1).from(`${jt.table} as l`).whereRaw(`l.${jt.targetCol} = b.id`))
      .select(
        'b.document_id as documentId',
        knex.raw("to_char(b.date,'YYYY-MM-DD') as date"),
        knex.raw(`to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt"`),
        'b.status',
        'b.arrived',
        'b.internal',
        'b.korekce',
        'b.client_name_raw as client',
        'b.employee_name_raw as master',
        'b.services',
      )
      .orderBy('b.starts_at', 'asc')
      .limit(100);
    return rows.map(mapUnclosedVisit);
  },

  async openShifts(range: { from: string; to: string }) {
    const knex = strapi.db.connection;
    // документ без опубликованной версии = черновик дня, который смена ещё не забрала
    const draftsByDay = (table: string) =>
      knex(`${table} as t`)
        .where('t.date', '>=', range.from)
        .where('t.date', '<=', range.to)
        .whereNotExists(
          knex.select(1).from(`${table} as p`).whereRaw('p.document_id = t.document_id').whereNotNull('p.published_at'),
        )
        .select(knex.raw("to_char(t.date,'YYYY-MM-DD') as date"), knex.raw('count(distinct t.document_id) as n'))
        .groupByRaw("to_char(t.date,'YYYY-MM-DD')");
    const [sp, wt] = await Promise.all([draftsByDay('services_provided'), draftsByDay('work_times')]);
    return mergeOpenShifts(sp, wt);
  },

  async korekcePending() {
    const rows = await strapi.db
      .connection('services_provided')
      .select('document_id', 'korekce', 'published_at')
      .whereRaw("korekce->>'pending' = 'true'");
    return mapKorekcePending(rows);
  },

  async vouchers(r: ReturnType<typeof todayRanges>) {
    const knex = strapi.db.connection;
    const base = () =>
      knex('vouchers')
        .whereNotNull('published_at')
        .whereNull('date_realized')
        .select(
          'document_id as documentId',
          'id_voucher as idVoucher',
          'name',
          'for as forName',
          'sum',
          knex.raw("to_char(date_order,'YYYY-MM-DD') as \"dateOrder\""),
          knex.raw("to_char(date_pay,'YYYY-MM-DD') as \"datePay\""),
        )
        .limit(50);
    const [paid, unpaid] = await Promise.all([
      base().where('date_pay', '>=', r.vouchersPaidFrom).where('date_pay', '<=', r.visits.to).orderBy('date_pay', 'desc'),
      base()
        .whereNull('date_pay')
        .where('date_order', '>=', r.vouchersUnpaidFrom)
        .where('date_order', '<=', r.visits.to)
        .orderBy('date_order', 'desc'),
    ]);
    return { paidRecent: paid.map(mapVoucher), unpaid: unpaid.map(mapVoucher) };
  },
};
