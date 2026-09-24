// @ts-nocheck
/**
 * «Korekce zdarma — převod podílu» (s210): перенос доли мастера при бесплатной
 * коррекции, которую делает ДРУГОЙ мастер.
 *
 * Правила денег — решения владельца s209 (d:/barbitch/KOREKCE_TRANSFER_NEXT_SESSION_PROMPT.md §1):
 *   P  — полная цена исходного визита (bookingPricing: Σ снапшота, s203);
 *   rA — процент первого мастера A, rB — процент исправителя B;
 *   base — «opravená část ceny» (по умолчанию остаток P, частичная коррекция — меньше).
 *
 *   режим `record` (исходный визит в ТОМ ЖЕ месяце):
 *     исходная запись D1:  мастер −base×rA,  салон +base×(rA − rB)
 *     запись коррекции D2: мастер +base×rB,  салон 0
 *     Σ(staff+salon) пары = P — ровно деньги, полученные в D1.
 *   режим `payroll` (исходный визит в ПРЕДЫДУЩЕМ месяце — его зарплата уже посчитана):
 *     исходная запись не трогается; B получает base×rB, салон 0; мастеру A —
 *     черновик «Списывание с зарплаты» (source `korekce`) на ту же сумму датой D2.
 *   `same_master` — исправляет тот же мастер: переноса нет, запись 0/0.
 *
 * Исходная запись правится knex-ом по ОБЕИМ строкам (draft и published) — без
 * publish: Documents API publish пересоздаёт строку и клонирует связи (гоча s90).
 * Суммы считаются ФОРМУЛОЙ, а не берутся из введённых админом полей: набранное
 * сверяют флаги 🔁 (норма записи = формула).
 *
 * Исходный визит ещё не закрыт записью → перенос ОЖИДАЮЩИЙ (`pending`): он лежит в
 * json записи коррекции и применяется при закрытии исходного (подсказка формы там
 * уже с вычетом, аккумуляторы кладутся на новую запись). Закрытие смены перенос не
 * блокирует никогда.
 *
 * Верх файла — чистые функции (tests/korekce-transfer.test.mjs), ниже — сервис.
 * Единственный импорт — utils/verify-flags (сам без импортов).
 */

import {
  asKorekceObject,
  bookingPricing,
  dominantEmoji,
  korekceFlagInput,
  parseMoney,
} from '../../../utils/verify-flags';

const BOOKING_UID = 'api::booking.booking';
const PAYROLL_UID = 'api::payroll.payroll';
const SP_UID = 'api::service-provided.service-provided';

/** Метка черновика «Списывания с зарплаты», заведённого переносом (режим payroll). */
export const KOREKCE_PAYROLL_SOURCE = 'korekce';
/** Окно селекта «po které návštěvě» — визиты клиента за столько дней до коррекции. */
export const KOREKCE_CANDIDATE_DAYS = 14;

/** Ошибка с HTTP-статусом: контроллер движка отдаёт её как {error:{status,code,message}}. */
export class KorekceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
/** Аккумулятор, вернувшийся в ноль, храним как NULL — запись выглядит как до переноса. */
const orNullKc = (n: number): number | null => (Math.abs(n) < 0.005 ? null : n);

// ── чистые функции ───────────────────────────────────────────────────────────

/** Режим переноса: тот же мастер → без переноса; разные YYYY-MM → через payroll. */
export const korekceMode = (originalDate: unknown, korekceDate: unknown, sameMaster: boolean) => {
  if (sameMaster) return 'same_master';
  return String(originalDate || '').slice(0, 7) === String(korekceDate || '').slice(0, 7) ? 'record' : 'payroll';
};

/**
 * Суммы переноса по формуле. salonAdjKc считается как разность уже округлённых
 * долей — так инвариант «Σ пары = P» держится до копейки и при округлении.
 */
export const transferAmounts = ({ baseKc, rateA, rateB }: { baseKc: unknown; rateA: unknown; rateB: unknown }) => {
  const base = parseMoney(baseKc);
  const staffOutKc = r2((base * parseMoney(rateA)) / 100);
  const staffInKc = r2((base * parseMoney(rateB)) / 100);
  return { staffOutKc, staffInKc, salonAdjKc: r2(staffOutKc - staffInKc) };
};

/** «Opravená část ceny» из формы: число > 0 и не больше остатка base исходного визита. */
export const parseBaseKc = (raw: unknown, remainingKc: unknown): number => {
  if (raw == null || String(raw).trim() === '') {
    throw new KorekceError(400, 'korekce_base_required', 'Vyplňte opravenou část ceny');
  }
  const n = Number(String(raw).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n <= 0) {
    throw new KorekceError(400, 'korekce_base_invalid', 'Opravená část ceny musí být kladné číslo');
  }
  const rem = r2(remainingKc);
  if (rem <= 0) {
    throw new KorekceError(409, 'korekce_nothing_left', 'Z původní návštěvy už byl převeden celý podíl');
  }
  if (r2(n) > rem) {
    throw new KorekceError(400, 'korekce_base_too_big', `Opravená část ceny může být nejvýš ${fmtKc(rem)} Kč`);
  }
  return r2(n);
};

const CS_MONTHS = [
  'leden', 'únor', 'březen', 'duben', 'květen', 'červen',
  'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec',
];

/** «2026-09-20» → «20. 9.» */
export const csDay = (ymd: unknown): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? `${Number(m[3])}. ${Number(m[2])}.` : String(ymd || '');
};
/** «2026-08-30» → «srpen» */
export const csMonth = (ymd: unknown): string => {
  const m = /^\d{4}-(\d{2})/.exec(String(ymd || ''));
  return m ? CS_MONTHS[Number(m[1]) - 1] || '' : '';
};

/** Кроны без хвоста «.00»; дробь — через запятую, как пишет салон. */
export const fmtKc = (n: unknown): string => String(r2(n)).replace('.', ',');
const signedKc = (n: number): string => (n > 0 ? `+${fmtKc(n)}` : n < 0 ? `−${fmtKc(-n)}` : '±0');

/** Строка в комментарий ИСХОДНОЙ записи (режим record). По ней же откат её снимает. */
export const originalCommentLine = (t: any): string =>
  `<p>🔁 Korekce ${csDay(t.korekceDate)} · ${t.master}: mistr ${signedKc(-t.staffOutKc)} Kč, salon ${signedKc(
    t.salonAdjKc,
  )} Kč (z ${fmtKc(t.baseKc)} Kč)</p>`;

/** Строка в комментарий записи КОРРЕКЦИИ. */
export const correctionCommentLine = (t: any): string => {
  if (t.mode === 'same_master') return `<p>🔁 Korekce po vlastní návštěvě ${csDay(t.originalDate)} — bez převodu</p>`;
  const head = `<p>🔁 Korekce po návštěvě ${csDay(t.originalDate)} · ${t.originalMaster}: ${fmtKc(t.staffInKc)} Kč (${
    t.ratePercent
  } % z ${fmtKc(t.baseKc)} Kč), salon 0`;
  if (t.mode === 'payroll') {
    return `${head}, odpis ze mzdy ${t.originalMaster} −${t.payrollKc} Kč (návštěva je z měsíce ${csMonth(t.originalDate)})</p>`;
  }
  return `${head}</p>`;
};

/** Описание черновика «Списывания с зарплаты» мастеру A (режим payroll). */
export const payrollComment = (t: any): string =>
  `Korekce u ${t.master} ${csDay(t.korekceDate)} za ${t.originalServices || 'službu'} ${csDay(t.originalDate)}${
    t.clientName ? ` (${t.clientName})` : ''
  }`;

export const appendLine = (html: unknown, line: string): string => `${String(html || '')}${line}`;
/** Снять ровно нашу строку; пустой остаток → null, как у записи без комментария. */
export const removeLine = (html: unknown, line: string): string | null => {
  const out = String(html || '').split(line).join('');
  return out.trim() ? out : null;
};

/**
 * Сдвиг ОДНОЙ строки исходной записи: sign = +1 применить перенос, −1 откатить.
 * Строки draft и published сдвигаются каждая от своих значений: если они вдруг
 * расходятся (правка черновика без публикации), каждая остаётся согласованной.
 */
export const shiftOriginal = (
  row: { staff: unknown; salon: unknown; staffOutKc?: unknown; salonAdjKc?: unknown; baseUsedKc?: unknown },
  t: { staffOutKc: unknown; salonAdjKc: unknown; baseKc: unknown },
  sign: 1 | -1,
) => {
  const out = sign * parseMoney(t.staffOutKc);
  const adj = sign * parseMoney(t.salonAdjKc);
  const base = sign * parseMoney(t.baseKc);
  return {
    staff: r2(parseMoney(row.staff) - out),
    salon: r2(parseMoney(row.salon) + adj),
    staffOutKc: orNullKc(r2(parseMoney(row.staffOutKc) + out)),
    salonAdjKc: orNullKc(r2(parseMoney(row.salonAdjKc) + adj)),
    baseUsedKc: orNullKc(r2(parseMoney(row.baseUsedKc) + base)),
  };
};

/** Σ ожидающих переносов на один исходный визит — аккумуляторы его будущей записи. */
export const sumTransfers = (list: any[]) =>
  (list || []).reduce(
    (a, t) => ({
      staffOutKc: r2(a.staffOutKc + parseMoney(t?.staffOutKc)),
      salonAdjKc: r2(a.salonAdjKc + parseMoney(t?.salonAdjKc)),
      baseUsedKc: r2(a.baseUsedKc + parseMoney(t?.baseKc)),
    }),
    { staffOutKc: 0, salonAdjKc: 0, baseUsedKc: 0 },
  );

/** Снимок переноса для json записи коррекции — по нему откат точен и админка рисует строки. */
export const buildTransfer = (plan: any, baseKc: unknown, meta: { now: string; actor: string }) => {
  const common = {
    mode: plan.mode,
    pending: false,
    korekceBookingDocId: plan.bookingDocId,
    korekceDate: plan.date,
    master: plan.master,
    masterDocId: plan.masterDocId,
    ratePercent: plan.rateB,
    originalBookingDocId: plan.original.bookingDocId,
    originalSpDocId: plan.originalSp?.documentId || null,
    originalDate: plan.original.date,
    originalMaster: plan.original.master,
    originalMasterDocId: plan.original.masterDocId,
    originalRatePercent: plan.rateA,
    originalServices: plan.original.services,
    clientName: plan.original.clientName,
    fullPrice: plan.fullPrice,
    payrollDocId: null,
    appliedAt: meta.now,
    appliedBy: meta.actor,
  };
  if (plan.mode === 'same_master') {
    return { ...common, baseKc: 0, staffOutKc: 0, staffInKc: 0, salonAdjKc: 0, payrollKc: 0 };
  }
  const base = r2(baseKc);
  const a = transferAmounts({ baseKc: base, rateA: plan.rateA, rateB: plan.rateB });
  if (plan.mode === 'payroll') {
    // исходная запись не меняется: разницу процентов несёт мастер A (решение владельца)
    return { ...common, baseKc: base, staffInKc: a.staffInKc, staffOutKc: 0, salonAdjKc: 0, payrollKc: Math.round(a.staffInKc) };
  }
  return { ...common, baseKc: base, ...a, payrollKc: 0 };
};

/** Что форма «Uzavřít návštěvu» показывает у брони-коррекции. */
export const korekceHint = (plan: any, applied: unknown) => ({
  status: plan.status,
  mode: plan.mode ?? null,
  originalClosed: Boolean(plan.originalClosed),
  original: plan.original
    ? {
        bookingDocId: plan.original.bookingDocId,
        date: plan.original.date,
        master: plan.original.master,
        services: plan.original.services,
        status: plan.original.status,
      }
    : null,
  master: plan.master ?? null,
  date: plan.date ?? null,
  rateA: plan.rateA ?? null,
  rateB: plan.rateB ?? null,
  fullPrice: plan.fullPrice ?? null,
  usedBaseKc: plan.usedBaseKc ?? 0,
  remainingBaseKc: plan.remainingBaseKc ?? 0,
  applied: asKorekceObject(applied),
});

const servicesTitles = (raw: unknown): string => {
  let arr: any = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return '';
    }
  }
  return Array.isArray(arr) ? arr.map((s) => String(s?.title || '').trim()).filter(Boolean).join(' + ') : '';
};

const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const rel = (documentId: string | null | undefined) => (documentId ? { documentId } : null);

// Имя join-таблицы — из метаданных Strapi, не хардкодом (длинные имена укорачиваются с хэшем, s204)
const joinTableOf = (uid: string, attrName: string) => {
  const jt = strapi.db.metadata.get(uid)?.attributes?.[attrName]?.joinTable;
  if (!jt?.name || !jt?.joinColumn?.name || !jt?.inverseJoinColumn?.name) return null;
  return { table: jt.name, sourceCol: jt.joinColumn.name, targetCol: jt.inverseJoinColumn.name };
};

// ── сервис ───────────────────────────────────────────────────────────────────

export default {
  _vc() {
    return strapi.service('api::booking-engine.visit-close');
  },

  /** Бронь-коррекция вместе с исходной бронью и процентами обоих мастеров. */
  async _loadKorekceBooking(bookingDocId: string) {
    const pricingFields = ['date', 'status', 'services', 'totalPrice', 'priceOverride', 'discount', 'clientNameRaw', 'employeeNameRaw'];
    return strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      fields: [...pricingFields, 'korekce', 'internal'],
      populate: {
        employee: { fields: ['name', 'ratePercent'] },
        client: { fields: ['name'] },
        korekceOf: {
          fields: pricingFields,
          populate: { employee: { fields: ['name', 'ratePercent'] }, client: { fields: ['name'] } },
        },
      },
    });
  },

  /**
   * Все переносы, привязанные к исходной брони (json записей-коррекций). У документа
   * бывает две строки (draft + published) с одинаковым json — берём по одной.
   */
  async _transfersTo(originalBookingDocId: string, excludeSpDocId: string | null = null) {
    if (!originalBookingDocId) return [];
    const rows = await strapi.db
      .connection('services_provided')
      .select('document_id', 'korekce', 'published_at')
      .whereRaw("korekce->>'originalBookingDocId' = ?", [originalBookingDocId]);
    const byDoc = new Map();
    for (const r of rows) {
      if (!byDoc.has(r.document_id) || r.published_at == null) byDoc.set(r.document_id, r);
    }
    return [...byDoc.values()]
      .filter((r) => r.document_id !== excludeSpDocId)
      .map((r) => ({ spDocId: r.document_id, json: asKorekceObject(r.korekce) }))
      .filter((x) => x.json && ['record', 'payroll'].includes(x.json.mode));
  },

  /**
   * План переноса для брони-коррекции. Статусы:
   *   not_korekce — у брони нет признака; paid — коррекция платная (переноса нет);
   *   no_link — не выбран исходный визит (или он отменён); same_master; ok.
   */
  async plan(bookingDocId: string, { excludeSpDocId = null }: { excludeSpDocId?: string | null } = {}) {
    const b = await this._loadKorekceBooking(bookingDocId);
    if (!b) throw new KorekceError(404, 'booking_not_found', 'Rezervace nenalezena');
    if (b.korekce !== true) return { status: 'not_korekce' };
    const head = {
      bookingDocId,
      date: String(b.date),
      master: b.employee?.name || b.employeeNameRaw || '',
      masterDocId: b.employee?.documentId || null,
      rateB: parseMoney(b.employee?.ratePercent),
    };
    if (parseMoney(b.totalPrice) > 0) return { status: 'paid', ...head };
    const o = b.korekceOf;
    if (!o || ['cancelled', 'noshow'].includes(o.status)) return { status: 'no_link', ...head };

    const original = {
      bookingDocId: o.documentId,
      date: String(o.date),
      status: o.status,
      master: o.employee?.name || o.employeeNameRaw || '',
      masterDocId: o.employee?.documentId || null,
      services: servicesTitles(o.services),
      clientName: o.client?.name || o.clientNameRaw || b.client?.name || b.clientNameRaw || '',
    };
    const sameMaster = !!original.masterDocId && original.masterDocId === head.masterDocId;
    const mode = korekceMode(original.date, head.date, sameMaster);
    const redemptionKc = await this._vc()._redemptionKc(o.documentId);
    const fullPrice = r2(bookingPricing(o, null, { redemptionKc }).fullPrice);
    const rec = await this._vc()._findByBooking(o.documentId);
    const others = await this._transfersTo(o.documentId, excludeSpDocId);
    const usedBaseKc = r2(others.reduce((s, x) => s + parseMoney(x.json.baseKc), 0));
    return {
      status: sameMaster ? 'same_master' : 'ok',
      mode,
      ...head,
      original,
      rateA: parseMoney(o.employee?.ratePercent),
      fullPrice,
      usedBaseKc,
      remainingBaseKc: r2(Math.max(0, fullPrice - usedBaseKc)),
      originalSp: rec ? { documentId: rec.documentId } : null,
      originalClosed: Boolean(rec),
    };
  },

  /**
   * Перед созданием/правкой записи коррекции: план + проверка «opravené části».
   * null — переноса нет (не коррекция или платная).
   */
  async prepare(bookingDocId: string, bodyKorekce: any, session: any, opts: { excludeSpDocId?: string | null } = {}) {
    const p = await this.plan(bookingDocId, opts);
    if (p.status === 'not_korekce' || p.status === 'paid') return null;
    if (p.status === 'no_link') {
      throw new KorekceError(400, 'korekce_no_link', 'Vyberte původní návštěvu v kartě Korekce');
    }
    const meta = { now: new Date().toISOString(), actor: session?.username || '' };
    if (p.status === 'same_master') return buildTransfer(p, 0, meta);
    return buildTransfer(p, parseBaseKc(bodyKorekce?.baseKc, p.remainingBaseKc), meta);
  },

  /**
   * Новые значения строк исходной записи БЕЗ записи в базу (флаги считает
   * visit-close._flagsFor — async lookup bitchcard, вне транзакции).
   */
  async _originalUpdates(origSpDocId: string, t: any, sign: 1 | -1) {
    const vc = this._vc();
    const rows = await strapi.db
      .connection('services_provided')
      .where('document_id', origSpDocId)
      .select(
        'id',
        'staff_salaries',
        'salon_salaries',
        'sale',
        'internal',
        'comment',
        'korekce',
        'korekce_staff_out_kc',
        'korekce_salon_adj_kc',
        'korekce_base_used_kc',
      );
    if (!rows.length) return [];
    const booking = await vc._loadBooking(t.originalBookingDocId);
    const line = originalCommentLine(t);
    const out = [];
    for (const row of rows) {
      const next = shiftOriginal(
        {
          staff: row.staff_salaries,
          salon: row.salon_salaries,
          staffOutKc: row.korekce_staff_out_kc,
          salonAdjKc: row.korekce_salon_adj_kc,
          baseUsedKc: row.korekce_base_used_kc,
        },
        t,
        sign,
      );
      const { flags, manualDeltaKc } = await vc._flagsFor(booking, {
        staffSalaries: next.staff,
        salonSalaries: next.salon,
        sale: row.sale,
        internal: row.internal === true,
        korekce: korekceFlagInput({
          korekce: row.korekce,
          korekceStaffOutKc: next.staffOutKc,
          korekceSalonAdjKc: next.salonAdjKc,
        }),
      });
      out.push([
        row.id,
        {
          staff_salaries: String(next.staff),
          salon_salaries: String(next.salon),
          korekce_staff_out_kc: next.staffOutKc,
          korekce_salon_adj_kc: next.salonAdjKc,
          korekce_base_used_kc: next.baseUsedKc,
          comment: sign > 0 ? appendLine(row.comment, line) : removeLine(row.comment, line),
          verify_flags: JSON.stringify(flags),
          verify: dominantEmoji(flags),
          manual_delta_kc: manualDeltaKc,
          updated_at: new Date(),
        },
      ]);
    }
    return out;
  },

  async _writeRows(trx, updates) {
    for (const [id, u] of updates) await trx('services_provided').where('id', id).update(u);
  },

  async _writeJson(trx, spDocId: string, json: any) {
    await trx('services_provided')
      .where('document_id', spDocId)
      .update({ korekce: json ? JSON.stringify(json) : null, updated_at: new Date() });
  },

  /**
   * Применить перенос после создания записи коррекции. Возвращает итоговый json
   * (pending / originalSpDocId / payrollDocId). Сбой → исключение; вызывающий
   * удаляет только что созданную запись коррекции.
   */
  async apply(spDocId: string, transfer: any) {
    const knex = strapi.db.connection;
    const t = { ...transfer };
    if (t.mode === 'record') {
      const orig = await this._vc()._findByBooking(t.originalBookingDocId);
      if (orig) {
        t.pending = false;
        t.originalSpDocId = orig.documentId;
        const updates = await this._originalUpdates(orig.documentId, t, 1);
        await knex.transaction(async (trx) => {
          await this._writeRows(trx, updates);
          await this._writeJson(trx, spDocId, t);
        });
        return t;
      }
      // исходный визит ещё не закрыт — перенос применится при его закрытии (§1.3)
      t.pending = true;
      t.originalSpDocId = null;
    } else if (t.mode === 'payroll') {
      const row = await strapi.documents(PAYROLL_UID).create({
        status: 'draft',
        data: {
          date: t.korekceDate,
          sum: String(t.payrollKc),
          comment: payrollComment(t),
          personal: rel(t.originalMasterDocId),
          source: KOREKCE_PAYROLL_SOURCE,
          booking: rel(t.korekceBookingDocId),
        },
      });
      t.payrollDocId = row.documentId;
      try {
        await this._writeJson(knex, spDocId, t);
      } catch (e) {
        await strapi.documents(PAYROLL_UID).delete({ documentId: row.documentId }).catch(() => {});
        throw e;
      }
      return t;
    }
    await this._writeJson(knex, spDocId, t);
    return t;
  },

  /**
   * Обратная операция по json (правка base, «Zrušit uzavření», удаление брони).
   * Опубликованное списание (смена D2 уже закрыта) не трогаем — 409, как у
   * опубликованной записи. Нет json → no-op. json с записи НЕ снимает (вызывающий
   * удаляет запись или пишет новый json).
   */
  async revert(transfer: any) {
    const t = asKorekceObject(transfer);
    if (!t) return false;
    if (t.mode === 'payroll' && t.payrollDocId) {
      const pub = await strapi.documents(PAYROLL_UID).findOne({ documentId: t.payrollDocId, status: 'published', fields: ['sum'] });
      if (pub) {
        throw new KorekceError(
          409,
          'korekce_payroll_published',
          'Odpis ze mzdy je už zveřejněný (směna je uzavřená) — nejdřív vraťte uzavření směny',
        );
      }
      const draft = await strapi.documents(PAYROLL_UID).findOne({ documentId: t.payrollDocId, status: 'draft', fields: ['sum'] });
      if (draft) await strapi.documents(PAYROLL_UID).delete({ documentId: t.payrollDocId });
      return true;
    }
    if (t.mode === 'record' && !t.pending && t.originalSpDocId) {
      const updates = await this._originalUpdates(t.originalSpDocId, t, -1);
      if (updates.length) {
        await strapi.db.connection.transaction(async (trx) => this._writeRows(trx, updates));
      }
      return true;
    }
    return false;
  },

  /** Ожидающие переносы на исходный визит (режим record, запись исходного ещё не создана). */
  async pendingFor(originalBookingDocId: string) {
    const list = await this._transfersTo(originalBookingDocId);
    return list.filter((x) => x.json.mode === 'record' && x.json.pending === true);
  },

  /** Применённые (не ожидающие) переносы режима record — для подсказки у закрытого исходного. */
  async appliedFor(originalBookingDocId: string) {
    const list = await this._transfersTo(originalBookingDocId);
    return list.filter((x) => x.json.mode === 'record' && x.json.pending !== true);
  },

  /** Исходный визит закрыли: ожидающие переносы становятся применёнными. */
  async absorbPending(items: any[], originalSpDocId: string) {
    if (!items?.length) return;
    const knex = strapi.db.connection;
    await knex.transaction(async (trx) => {
      for (const x of items) {
        await this._writeJson(trx, x.spDocId, { ...x.json, pending: false, originalSpDocId });
      }
    });
  },

  /**
   * Запись исходного визита удалена («Zrušit uzavření» / удаление брони): её
   * аккумуляторы ушли вместе с ней, поэтому применённые переносы снова ждут —
   * при следующем закрытии подсказка опять будет с вычетом.
   */
  async releaseToPending(originalBookingDocId: string) {
    const applied = await this.appliedFor(originalBookingDocId);
    if (!applied.length) return 0;
    const knex = strapi.db.connection;
    await knex.transaction(async (trx) => {
      for (const x of applied) {
        await this._writeJson(trx, x.spDocId, { ...x.json, pending: true, originalSpDocId: null });
      }
    });
    return applied.length;
  },

  /** Журнал календаря (fire-and-forget, сбой журнала операцию не роняет). */
  log(action: string, t: any, session: any, extra: Record<string, unknown> = {}) {
    const who = t?.master || '';
    const from = `${csDay(t?.originalDate)} u ${t?.originalMaster || '—'}`;
    let summary: string;
    if (action === 'korekce_revert') {
      summary = `Převod podílu zrušen: ${t?.clientName || ''} · korekce ${csDay(t?.korekceDate)} u ${who}`;
    } else if (t?.mode === 'same_master') {
      summary = `Korekce: ${t?.clientName || ''} · ${csDay(t?.korekceDate)} u ${who} — stejná mistrová, bez převodu`;
    } else if (t?.mode === 'payroll') {
      summary = `Převod podílu: ${t?.clientName || ''} · korekce ${csDay(t?.korekceDate)} u ${who} → odpis ze mzdy ${
        t?.originalMaster
      } −${t?.payrollKc} Kč (návštěva ${from})`;
    } else {
      summary = `Převod podílu: ${t?.clientName || ''} · korekce ${csDay(t?.korekceDate)} u ${who} ← návštěva ${from}${
        t?.pending ? ' (čeká na uzavření původní návštěvy)' : ''
      }`;
    }
    const details: Record<string, unknown> = {
      režim: t?.mode === 'payroll' ? 'odpis ze mzdy' : t?.mode === 'same_master' ? 'stejná mistrová' : 'záznam',
      'opravená část': `${fmtKc(t?.baseKc)} Kč z ${fmtKc(t?.fullPrice)} Kč`,
      [t?.originalMaster || 'původní mistrová']:
        t?.mode === 'payroll' ? `odpis −${t?.payrollKc} Kč` : `−${fmtKc(t?.staffOutKc)} Kč`,
      [who || 'mistrová korekce']: `+${fmtKc(t?.staffInKc)} Kč`,
      ...(t?.mode === 'record' ? { salon: `${signedKc(parseMoney(t?.salonAdjKc))} Kč` } : {}),
      ...extra,
    };
    return strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action,
        entityType: 'korekce',
        actorName: session?.username || '',
        entityDocId: t?.korekceBookingDocId || null,
        clientName: t?.clientName || '',
        employeeName: who,
        summary,
        details,
      })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  /**
   * Кандидаты для селекта «po které návštěvě»: визиты того же клиента (по карточке,
   * телефону или e-mail — дубли карточек) за KOREKCE_CANDIDATE_DAYS дней до
   * коррекции, начавшиеся раньше неё, active/checkedOut, не сами коррекции.
   */
  async candidates(bookingDocId: string) {
    const knex = strapi.db.connection;
    const [b] = await knex('bookings')
      .select('id', 'starts_at', knex.raw("to_char(date,'YYYY-MM-DD') as date"))
      .where('document_id', bookingDocId);
    if (!b) throw new KorekceError(404, 'booking_not_found', 'Rezervace nenalezena');
    const [c] = await knex('bookings_client_lnk as bc')
      .join('clients as c', 'c.id', 'bc.client_id')
      .where('bc.booking_id', b.id)
      .select('c.id', 'c.phone', 'c.email');
    if (!c) return { items: [] };
    const phone = String(c.phone || '').trim();
    const email = String(c.email || '').trim().toLowerCase();
    const spJt = joinTableOf(SP_UID, 'booking');
    const hasRecord = spJt
      ? knex.raw(`exists(select 1 from ${spJt.table} l where l.${spJt.targetCol} = b.id) as "hasRecord"`)
      : knex.raw('false as "hasRecord"');
    const q = knex('bookings as b')
      .join('bookings_client_lnk as bc', 'bc.booking_id', 'b.id')
      .join('clients as cl', 'cl.id', 'bc.client_id')
      .where((w) => {
        w.where('cl.id', c.id);
        if (phone) w.orWhere('cl.phone', phone);
        if (email) w.orWhereRaw('lower(trim(cl.email)) = ?', [email]);
      })
      .whereNot('b.id', b.id)
      .whereIn('b.status', ['active', 'checkedOut'])
      .whereRaw('coalesce(b.korekce, false) = false')
      .whereRaw('coalesce(b.internal, false) = false')
      .where('b.date', '>=', addDaysYmd(b.date, -KOREKCE_CANDIDATE_DAYS))
      .where('b.date', '<=', b.date);
    if (b.starts_at) q.where('b.starts_at', '<', b.starts_at);
    const rows = await q
      .select(
        'b.document_id as documentId',
        knex.raw("to_char(b.date,'YYYY-MM-DD') as date"),
        'b.starts_at as startsAt',
        'b.status',
        'b.employee_name_raw as master',
        'b.services',
        'b.total_price as totalPrice',
        hasRecord,
      )
      .orderBy('b.starts_at', 'desc')
      .limit(30);
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      if (seen.has(r.documentId)) continue;
      seen.add(r.documentId);
      items.push({
        documentId: r.documentId,
        date: r.date,
        startsAt: r.startsAt,
        status: r.status,
        master: r.master || '',
        services: servicesTitles(r.services),
        totalPrice: r.totalPrice == null ? null : parseMoney(r.totalPrice),
        hasRecord: r.hasRecord === true,
      });
    }
    return { items };
  },
};
