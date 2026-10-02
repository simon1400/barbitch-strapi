// @ts-nocheck
/**
 * Журнал «Uzavření směny» (s240, «Výkaz práce» Фаза 2, решение владельца §10.4.2 плана
 * MANAGER_REPORT_NEXT_SESSION_PROMPT.md).
 *
 * Закрытие смены публикует черновики дня сырым REST из браузера (admin
 * pages/global/fetch/shiftClose.ts) — сервер о нём не знал, и в журнал (а значит, и в
 * «Systém zaznamenal» под отчётом управляющей) оно не попадало. Теперь страница после
 * публикации зовёт `POST /engine/admin/shift-close/journal`: автор — из сессии (не из тела),
 * число опубликованных услуг дня сервер считает сам по базе. Отмена закрытия (`/shift-revert`)
 * пишется прямо на сервере. entityType `shift_close`.
 */

import { pragueDateOf } from './slots-core';

export class ShiftLogError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SP_UID = 'api::service-provided.service-provided';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Закрыть можно и задним числом — но не старше этого (защита от мусора в журнале). */
export const SHIFT_LOG_MAX_DAYS = 62;
const MAX_COUNT = 100000;

const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const isValidYmd = (s: string): boolean => YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const fmtDay = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** Тело от страницы: день и счётчики публикации. */
export const normalizeShiftCloseLog = (body: any, today: string) => {
  const date = String(body?.date ?? '');
  if (!isValidYmd(date) || date > today || date < addDaysYmd(today, -SHIFT_LOG_MAX_DAYS)) {
    throw new ShiftLogError(400, 'bad_date', 'Neplatné datum směny');
  }
  const count = (v: unknown) => {
    const n = v == null ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) throw new ShiftLogError(400, 'bad_counts', 'Neplatné počty');
    return n;
  };
  return { date, published: count(body?.published), failures: count(body?.failures), skipped: count(body?.skipped) };
};

export const closeSummary = (e: { date: string; published: number; failures: number }) =>
  `Směna ${fmtDay(e.date)} uzavřena: zveřejněno ${e.published}${e.failures ? ` · chyby ${e.failures}` : ''}`;

export const revertSummary = (date: string, result: any) => {
  const total = Object.values(result?.unpublished || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0);
  const errors = Array.isArray(result?.errors) ? result.errors.length : 0;
  return `Uzavření směny ${fmtDay(date)} zrušeno: vráceno do konceptu ${total}${errors ? ` · chyby ${errors}` : ''}`;
};

export default {
  _write(entry: Record<string, unknown>) {
    return strapi.service('api::calendar-log.calendar-log').write({ entityType: 'shift_close', ...entry });
  },

  /** POST /engine/admin/shift-close/journal {date, published, failures, skipped} — руководство. */
  async logClose({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const e = normalizeShiftCloseLog(body, pragueDateOf(now));
    // сколько услуг дня реально опубликовано — по базе, не со слов браузера
    const services = await strapi.documents(SP_UID).count({ status: 'published', filters: { date: { $eq: e.date } } });
    await this._write({
      action: 'shift_close',
      actorName: session?.username || '',
      entityDocId: e.date,
      summary: closeSummary(e),
      details: { datum: fmtDay(e.date), zveřejněno: e.published, chyby: e.failures, přeskočeno: e.skipped, 'služeb dne v bázi': services },
    });
    return { ok: true };
  },

  /** Отмена закрытия (shift-revert) — пишется после успешного отката. */
  async logRevert({ session, date, result }: { session: any; date: string; result: any }) {
    await this._write({
      action: 'shift_revert',
      actorName: session?.username || '',
      entityDocId: String(date),
      summary: revertSummary(String(date), result),
      details: { datum: fmtDay(String(date)), ...(result?.unpublished || {}) },
    });
  },
};
