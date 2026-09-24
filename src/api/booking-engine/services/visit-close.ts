// @ts-nocheck
// Закрытие визита («Uzavřít návštěvu», вариант D2): запись «Оказанная услуга»
// (service-provided) создаётся ПРЯМО ИЗ БРОНИ календаря вместо ручного ввода в CM.
//
// Что даёт связь service-provided.booking:
//   • клиент/мастер/услуга/дата/время берутся из брони — опечатки в имени клиента
//     (ложные ±2 при закрытии смены, s88/s97) уходят по построению;
//   • verify-флаги считаются от цен БРОНИ (юниор-цена, дозапись −15 %, bitchcard) —
//     легаси-оффер («Услуги» эпохи Noona) для новых записей больше не нужен;
//   • сверка смены (V3) матчит записи с бронями структурно, а не по имени.
//
// Руками админ вводит ТОЛЬКО деньги (решение владельца s142/s83: автозаполнение
// убило бы verify-контроль — форма показывает лишь подсказку расчёта).
//
// Запись создаётся ЧЕРНОВИКОМ — публикует её по-прежнему закрытие смены.
// Флаги считает движок сам: lifecycle при REST-create не получает relations
// в CM-формате и вернул бы null (гоча s129).

import { minToHHMM, utcToPragueMinClamped } from './slots-core';
import { EngineError } from './booking-engine';
import {
  bookingPricing,
  computeBookingFlags,
  dominantEmoji,
  hasManualSale,
  korekceFlagInput,
  parseMoney,
} from '../../../utils/verify-flags';
import {
  correctionCommentLine,
  korekceHint,
  originalCommentLine,
  removeLine,
  sumTransfers,
} from './korekce-transfer';

const BOOKING_UID = 'api::booking.booking';
const SP_UID = 'api::service-provided.service-provided';
const VOUCHER_UID = 'api::voucher.voucher';
const REDEMPTION_UID = 'api::redemption.redemption';

const BOOKING_FIELDS = [
  'date',
  'startsAt',
  'endsAt',
  'status',
  'services',
  'totalPrice',
  'priceOverride',
  'discount',
  'clientNameRaw',
  'employeeNameRaw',
  // интерная бронь (s203): предзаполняет галку «Interní» и обнуляет подсказку mustSalon
  'internal',
  // бесплатная коррекция (s210): перенос доли мастера с исходного визита
  'korekce',
];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const korekceSvc = () => strapi.service('api::booking-engine.korekce-transfer');

/** Пустая строка/пробелы → null (чтобы не писать «» в необязательные поля). */
const orNull = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

// Деньги в схеме — строка; агрегаты зарплат читают их через Number()/parseFloat,
// поэтому храним канонический вид с точкой (запятая дала бы NaN).
const moneyStr = (v) => String(parseMoney(v));

/**
 * 🟥 Связь ВСЕГДА передаём объектом `{ documentId }`, а не голой строкой.
 * Strapi 5 определяет «строка — это id или documentId?» через `parseInt(value)`
 * (mapRelation в document-service): documentId, НАЧИНАЮЩИЙСЯ С ЦИФРЫ
 * («2p1jqoyz…» → parseInt = 2), принимается за числовой entity id, связь не
 * резолвится → 500 «Invalid relations». Объектная форма однозначна.
 */
const rel = (documentId) => (documentId ? { documentId } : null);

export default {
  // ── чтение ──

  /** Бронь + мастер (ratePercent для формул) + имя клиента. */
  async _loadBooking(bookingDocId) {
    const booking = await strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      fields: BOOKING_FIELDS,
      populate: {
        employee: { fields: ['name', 'ratePercent', 'tier'] },
        client: { fields: ['name'] },
      },
    });
    if (!booking) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');
    return booking;
  },

  /**
   * Запись чекаута этой брони (черновик; у опубликованной документ тот же).
   * `status: 'draft'` — Strapi 5 отдаёт черновую версию и у опубликованных документов.
   */
  async _findByBooking(bookingDocId) {
    const rows = await strapi.documents(SP_UID).findMany({
      filters: { booking: { documentId: { $eq: bookingDocId } } },
      status: 'draft',
      populate: { voucher: { fields: ['idVoucher', 'sum'] }, personal: { fields: ['name'] } },
      limit: 1,
    });
    return rows[0] || null;
  },

  /** Опубликована ли запись (закрытие смены уже прошло) — правки/удаление запрещены. */
  async _isPublished(spDocId) {
    const pub = await strapi.documents(SP_UID).findOne({
      documentId: spDocId,
      status: 'published',
      fields: ['date'],
    });
    return Boolean(pub);
  },

  _shape(rec, published) {
    if (!rec) return null;
    return {
      documentId: rec.documentId,
      clientName: rec.clientName,
      date: rec.date,
      time: rec.time,
      staffSalaries: rec.staffSalaries,
      salonSalaries: rec.salonSalaries,
      tip: rec.tip,
      sale: rec.sale,
      cash: rec.cash !== false,
      internal: Boolean(rec.internal),
      comment: rec.comment || '',
      verify: rec.verify || '',
      verifyFlags: Array.isArray(rec.verifyFlags) ? rec.verifyFlags : [],
      // 💰 разница ручной цены (s203); null у записей до внедрения
      manualDeltaKc: rec.manualDeltaKc == null ? null : Number(rec.manualDeltaKc),
      // перенос доли (s210): json у записи коррекции, аккумуляторы у исходной
      korekce: rec.korekce || null,
      korekceStaffOutKc: rec.korekceStaffOutKc == null ? null : Number(rec.korekceStaffOutKc),
      korekceSalonAdjKc: rec.korekceSalonAdjKc == null ? null : Number(rec.korekceSalonAdjKc),
      korekceBaseUsedKc: rec.korekceBaseUsedKc == null ? null : Number(rec.korekceBaseUsedKc),
      published: Boolean(published),
      personalName: rec.personal?.name || '',
      voucher: rec.voucher
        ? { documentId: rec.voucher.documentId, idVoucher: rec.voucher.idVoucher, sum: rec.voucher.sum }
        : null,
    };
  },

  /**
   * Σ discountKc погашенных bitchcard-наград этой брони — для разворота полной цены
   * (redemption снижает total_price + взводит price_override, s152). Сбой lookup /
   * пустая таблица → 0 (расчёт деградирует к оплаченной сумме, ничего не ломается).
   */
  async _redemptionKc(bookingDocId) {
    try {
      const rows = await strapi.documents(REDEMPTION_UID).findMany({
        filters: { status: { $eq: 'used' }, usedInBookingDocId: { $eq: bookingDocId } },
        fields: ['discountKc'],
        limit: 10,
      });
      return rows.reduce((acc, r) => acc + (Number(r.discountKc) || 0), 0);
    } catch (e) {
      strapi.log.warn(`visit-close: redemptionKc lookup failed: ${e?.message || e}`);
      return 0;
    }
  },

  /**
   * GET-ручка для drawer: закрыт ли визит + подсказка расчёта.
   * `hint` считается всегда — форма показывает его до ввода сумм.
   */
  async getForBooking(bookingDocId) {
    const booking = await this._loadBooking(bookingDocId);
    const rec = await this._findByBooking(bookingDocId);
    const published = rec ? await this._isPublished(rec.documentId) : false;
    const ratePercent = Number(booking.employee?.ratePercent) || 0;
    const redemptionKc = await this._redemptionKc(bookingDocId);
    const { fullPrice, paidExpected, systemDiscountKc, manualDeltaKc, catalogPrice } = bookingPricing(booking, null, { redemptionKc });
    const mustStaff0 = Math.round(fullPrice * (ratePercent / 100) * 100) / 100;
    // Интерная услуга: салон себе не берёт ничего — подсказка mustSalon = 0.
    // (В CM-хинте ServiceMoneyHint.tsx:161 так было всегда, а ручка drawer'а
    // обнуления не делала — форма предлагала админу положить салону разницу.)
    const isInternalBooking = booking.internal === true;

    // Перенос доли (s210). У брони-коррекции — план переноса (подсказка = доля
    // исправителя, салон 0). У ЛЮБОЙ брони — переносы, которые ждут её закрытия
    // (или уже применены к её записи): подсказка сразу с вычетом.
    const korekce = await this._korekceHint(bookingDocId, booking, rec);
    const korekceOut = await this._korekceOutHint(bookingDocId, rec);
    let mustStaff = r2(mustStaff0 - (korekceOut?.staffOutKc || 0));
    let mustSalon = isInternalBooking ? 0 : r2(paidExpected - mustStaff0 + (korekceOut?.salonAdjKc || 0));
    if (korekce && ['ok', 'same_master'].includes(korekce.status)) {
      const base = korekce.applied ? Number(korekce.applied.baseKc) || 0 : korekce.remainingBaseKc;
      mustStaff = korekce.status === 'ok' ? r2((base * (korekce.rateB || 0)) / 100) : 0;
      mustSalon = 0;
    }
    return {
      checkout: this._shape(rec, published),
      hint: {
        fullPrice,
        paidExpected,
        systemDiscountKc,
        manualDeltaKc,
        catalogPrice,
        ratePercent,
        mustStaff,
        mustSalon,
        // предзаполнение галки «Interní (mistr mistrové)» в форме закрытия визита;
        // админ может её снять — решение владельца §1а.5
        internal: isInternalBooking,
        korekce,
        korekceOut,
      },
    };
  },

  /** План переноса для формы брони-коррекции (null — не коррекция). */
  async _korekceHint(bookingDocId, booking, rec) {
    if (booking.korekce !== true) return null;
    const p = await korekceSvc().plan(bookingDocId, { excludeSpDocId: rec?.documentId || null });
    return korekceHint(p, rec?.korekce);
  },

  /**
   * Переносы С этой брони на коррекции: у закрытого визита — применённые
   * (аккумуляторы записи), у незакрытого — ожидающие. null — переносов нет.
   */
  async _korekceOutHint(bookingDocId, rec) {
    const svc = korekceSvc();
    const list = rec ? await svc.appliedFor(bookingDocId) : await svc.pendingFor(bookingDocId);
    const tot = rec
      ? {
          staffOutKc: r2(rec.korekceStaffOutKc),
          salonAdjKc: r2(rec.korekceSalonAdjKc),
          baseUsedKc: r2(rec.korekceBaseUsedKc),
        }
      : sumTransfers(list.map((x) => x.json));
    if (!list.length && !tot.staffOutKc && !tot.salonAdjKc) return null;
    return {
      ...tot,
      applied: Boolean(rec),
      items: list.map((x) => ({
        spDocId: x.spDocId,
        korekceDate: x.json.korekceDate,
        master: x.json.master,
        baseKc: x.json.baseKc,
        staffOutKc: x.json.staffOutKc,
        staffInKc: x.json.staffInKc,
        salonAdjKc: x.json.salonAdjKc,
      })),
    };
  },

  // ── расчёт флагов ──

  /**
   * Флаги по брони + информационный 🎟 sleva_bez_karty: у записи есть РУЧНАЯ скидка,
   * а системной (bitchcard-погашение / применённая скидка дозаписи) на этой брони нет
   * → скидку дали мимо программы. Матчинг структурный (по documentId брони), а не
   * по имени клиента, как в legacy-lifecycle. Гейт LOYALTY_ENABLED, сбой lookup не
   * блокирует сохранение.
   */
  async _flagsFor(booking, { staffSalaries, salonSalaries, sale, internal, korekce = null }) {
    // Погашенные bitchcard-награды нужны ДО расчёта (разворот полной цены, s152),
    // а не только для 🎟 — поэтому lookup всегда, не под флагом sleva.
    const redemptionKc = await this._redemptionKc(booking.documentId);

    const flags = computeBookingFlags({
      booking,
      ratePercent: Number(booking.employee?.ratePercent) || 0,
      staffSalaries: parseMoney(staffSalaries),
      salonSalaries: parseMoney(salonSalaries),
      sale,
      internal,
      redemptionKc,
      korekce,
    });

    // Запись бесплатной коррекции (s210): 0 Kč за услугу — это правило, а не ручная
    // цена и не скидка «мимо программы». Дельту храним 0, чтобы сумма 💰 за день
    // в закрытии смены её не считала.
    if (korekce?.staffInKc != null) return { flags, manualDeltaKc: 0 };

    // 💰 ручная цена (s203): дельта хранится в записи, чтобы админка показывала сумму
    // без пересчёта (redemptionKc в браузере недоступен).
    const { manualDeltaKc } = bookingPricing(booking, sale, { redemptionKc });

    // 🎟 при РУЧНОЙ скидке (поле sale) ИЛИ ручном занижении цены (не flags.includes('sleva') —
    // 🟦 ставится и системными скидками, а те по определению «по программе»).
    if ((hasManualSale(sale) || manualDeltaKc < 0) && process.env.LOYALTY_ENABLED === 'true') {
      const hasRebook = booking.discount?.type === 'rebook' && booking.discount?.applied;
      if (!hasRebook && redemptionKc <= 0) flags.push('sleva_bez_karty');
    }
    return { flags, manualDeltaKc };
  },

  /** Ваучер должен быть оплачен и ещё не реализован (тот же фильтр, что в relation-picker). */
  async _resolveVoucher(voucherDocId) {
    if (!voucherDocId) return null;
    const v = await strapi.documents(VOUCHER_UID).findOne({
      documentId: voucherDocId,
      fields: ['idVoucher', 'datePay', 'dateRealized'],
    });
    if (!v) throw new EngineError(404, 'voucher_not_found', 'Voucher nenalezen');
    if (!v.datePay) throw new EngineError(409, 'voucher_not_paid', 'Voucher není zaplacený');
    return v.documentId;
  },

  _validateMoney(body) {
    for (const key of ['staffSalaries', 'salonSalaries']) {
      const raw = body?.[key];
      if (raw == null || String(raw).trim() === '') {
        throw new EngineError(400, 'money_required', 'Vyplňte cenu mistra i zisk salonu');
      }
      // parseMoney глотает мусор в 0 — здесь нужен строгий разбор, иначе «abc» → 0 Kč
      const n = Number(String(raw).replace(',', '.').replace(/\s/g, ''));
      if (!Number.isFinite(n)) throw new EngineError(400, 'bad_money', 'Částky musí být čísla');
    }
  },

  /** Свежая запись с populate (voucher/personal) в форме ответа. */
  async _readShaped(spDocId) {
    const rec = await strapi.documents(SP_UID).findOne({
      documentId: spDocId,
      status: 'draft',
      populate: { voucher: { fields: ['idVoucher', 'sum'] }, personal: { fields: ['name'] } },
    });
    return this._shape(rec, false);
  },

  // ── запись ──

  /**
   * POST /engine/admin/bookings/:id/checkout — закрыть визит.
   * Создаёт ЧЕРНОВИК service-provided с линком на бронь и переводит бронь в checkedOut.
   */
  async createForBooking(bookingDocId, body, session) {
    const booking = await this._loadBooking(bookingDocId);

    if (['cancelled', 'noshow'].includes(booking.status)) {
      throw new EngineError(409, 'booking_not_closable', 'Zrušenou rezervaci nelze uzavřít');
    }
    const employeeDocId = booking.employee?.documentId;
    if (!employeeDocId) throw new EngineError(400, 'employee_required', 'U rezervace chybí mistrová');

    const existing = await this._findByBooking(bookingDocId);
    if (existing) throw new EngineError(409, 'already_checked_out', 'Návštěva už je uzavřená');

    this._validateMoney(body);
    const voucherDocId = await this._resolveVoucher(body.voucherDocId);

    // галка приходит из формы уже предзаполненной из брони (hint.internal), но
    // последнее слово за админом: если в теле её нет вовсе — берём признак брони
    const internal = 'internal' in body ? body.internal === true : booking.internal === true;
    const sale = orNull(body.sale);

    // Перенос доли (s210). (1) Эта бронь — бесплатная коррекция: суммы по формуле
    // (без выбранного исходного визита закрыть нельзя — 400 korekce_no_link).
    // (2) Эта бронь — исходный визит, на который ждут переносы: её запись сразу
    // создаётся с аккумуляторами, повторно ничего не вычитается.
    const svc = korekceSvc();
    const transfer = await svc.prepare(bookingDocId, body.korekce, session);
    const pending = await svc.pendingFor(bookingDocId);
    const acc = sumTransfers(pending.map((x) => x.json));
    const korekce = korekceFlagInput({
      korekce: transfer,
      korekceStaffOutKc: acc.staffOutKc,
      korekceSalonAdjKc: acc.salonAdjKc,
    });

    const { flags, manualDeltaKc } = await this._flagsFor(booking, {
      staffSalaries: body.staffSalaries,
      salonSalaries: body.salonSalaries,
      sale,
      internal,
      korekce,
    });

    const date = String(booking.date);
    const time = booking.startsAt ? minToHHMM(utcToPragueMinClamped(booking.startsAt, date)) : null;
    const clientName = booking.client?.name || booking.clientNameRaw || '';
    if (!clientName) throw new EngineError(400, 'client_required', 'U rezervace chybí jméno klientky');

    // автострока в комментарии обеих записей (решение владельца s209 п. 8)
    let comment = orNull(body.comment);
    if (transfer) comment = `${comment || ''}${correctionCommentLine(transfer)}`;
    for (const x of pending) comment = `${comment || ''}${originalCommentLine(x.json)}`;

    const created = await strapi.documents(SP_UID).create({
      status: 'draft',
      data: {
        clientName,
        date,
        time,
        personal: rel(employeeDocId),
        booking: rel(bookingDocId),
        ...(voucherDocId ? { voucher: rel(voucherDocId) } : {}),
        staffSalaries: moneyStr(body.staffSalaries),
        salonSalaries: moneyStr(body.salonSalaries),
        tip: orNull(body.tip) ? moneyStr(body.tip) : null,
        sale,
        cash: body.cash !== false,
        internal,
        comment,
        verifyFlags: flags,
        verify: dominantEmoji(flags),
        manualDeltaKc,
        korekce: transfer,
        korekceStaffOutKc: acc.staffOutKc || null,
        korekceSalonAdjKc: acc.salonAdjKc || null,
        korekceBaseUsedKc: acc.baseUsedKc || null,
      },
    });

    // Побочные эффекты переноса ДО смены статуса брони: при сбое запись коррекции
    // удаляется и бронь остаётся как была — полуприменённого переноса не бывает.
    let applied = null;
    try {
      if (transfer) applied = await svc.apply(created.documentId, transfer);
      if (pending.length) await svc.absorbPending(pending, created.documentId);
    } catch (e) {
      strapi.log.error(`visit-close: korekce transfer failed for ${bookingDocId}, record rolled back: ${e.message}`);
      await strapi.documents(SP_UID).delete({ documentId: created.documentId }).catch(() => {});
      throw e;
    }
    if (applied) svc.log('korekce_transfer', applied, session);
    for (const x of pending) {
      svc.log('korekce_transfer', { ...x.json, pending: false }, session, {
        uplatněno: `při uzavření návštěvy ${date}`,
      });
    }

    // бронь → checkedOut (реюз adminPatchBooking: arrived=true, журнал/пуш как обычно)
    if (booking.status !== 'checkedOut') {
      await strapi
        .service('api::booking-engine.booking-engine')
        .adminPatchBooking(bookingDocId, { status: 'checkedOut' }, session);
    }

    // Интерная услуга (s203): списание с зарплаты получателя выравниваем по ФАКТИЧЕСКИ
    // введённой доле мастера — при создании брони сумма считалась от каталожной цены,
    // а на закрытии админ мог ввести другую. Опубликованный черновик не трогается.
    if (booking.internal === true) {
      await strapi
        .service('api::booking-engine.internal-payroll')
        .syncDraft(bookingDocId, { sum: Math.round(parseMoney(body.staffSalaries) || 0) })
        .catch((e) => strapi.log.error(`internal-payroll sync on checkout failed: ${e.message}`));
    }

    strapi.log.info(
      `visit-close: admin ${session?.username || '?'} closed visit for booking ${bookingDocId} → sp ${created.documentId} [${flags.join(',')}]`
    );

    return { checkout: await this._readShaped(created.documentId), created: true };
  },

  /**
   * PATCH /engine/admin/checkout/:id — правка сумм/галок закрытого визита.
   * Опубликованную (смена уже закрыта) править нельзя — только в Strapi CM.
   */
  async patch(spDocId, body, session) {
    const rec = await strapi.documents(SP_UID).findOne({
      documentId: spDocId,
      status: 'draft',
      populate: { booking: { fields: ['date'] } },
    });
    if (!rec) throw new EngineError(404, 'checkout_not_found', 'Záznam nenalezen');
    if (await this._isPublished(spDocId)) {
      throw new EngineError(409, 'already_published', 'Směna je už uzavřená — upravte záznam ve Strapi');
    }
    const bookingDocId = rec.booking?.documentId;
    if (!bookingDocId) throw new EngineError(409, 'not_booking_linked', 'Záznam není napojen na rezervaci');

    const booking = await this._loadBooking(bookingDocId);
    const merged = {
      staffSalaries: body.staffSalaries ?? rec.staffSalaries,
      salonSalaries: body.salonSalaries ?? rec.salonSalaries,
      sale: 'sale' in body ? orNull(body.sale) : rec.sale,
      internal: 'internal' in body ? body.internal === true : Boolean(rec.internal),
    };
    this._validateMoney(merged);

    // Перенос доли (s210): изменилась «opravená část ceny» → откат старого переноса
    // и применение нового. Остаток считается без самой этой записи.
    const svc = korekceSvc();
    let transfer = rec.korekce || null;
    let rePlanned = null;
    const oldBase = Number(transfer?.baseKc) || 0;
    if (
      transfer &&
      ['record', 'payroll'].includes(transfer.mode) &&
      body.korekce?.baseKc != null &&
      r2(Number(String(body.korekce.baseKc).replace(',', '.'))) !== r2(oldBase)
    ) {
      rePlanned = await svc.prepare(bookingDocId, body.korekce, session, { excludeSpDocId: spDocId });
      transfer = rePlanned;
    }
    const korekce = korekceFlagInput({
      korekce: transfer,
      korekceStaffOutKc: rec.korekceStaffOutKc,
      korekceSalonAdjKc: rec.korekceSalonAdjKc,
    });
    const { flags, manualDeltaKc } = await this._flagsFor(booking, { ...merged, korekce });

    const data: Record<string, unknown> = {
      staffSalaries: moneyStr(merged.staffSalaries),
      salonSalaries: moneyStr(merged.salonSalaries),
      sale: merged.sale,
      internal: merged.internal,
      verifyFlags: flags,
      verify: dominantEmoji(flags),
      manualDeltaKc,
    };
    if ('tip' in body) data.tip = orNull(body.tip) ? moneyStr(body.tip) : null;
    if ('cash' in body) data.cash = body.cash !== false;
    if ('comment' in body) data.comment = orNull(body.comment);
    if ('voucherDocId' in body) {
      data.voucher = body.voucherDocId ? rel(await this._resolveVoucher(body.voucherDocId)) : null;
    }
    // Автостроки переноса в комментарии не теряем, даже если форма прислала
    // комментарий без них; при смене base старая строка заменяется новой.
    if (rec.korekce) {
      // json переноса едет вместе с данными: lifecycle beforeUpdate пересчитывает
      // флаги по ключам payload, и со старым json норма была бы от старой base
      data.korekce = transfer;
      const base = 'comment' in data ? data.comment : rec.comment;
      const clean = removeLine(base, correctionCommentLine(rec.korekce));
      data.comment = `${clean || ''}${correctionCommentLine(transfer)}`;
    }

    if (rePlanned) {
      // откат старого переноса → новый; сбой нового возвращает старый
      await svc.revert(rec.korekce);
      try {
        await strapi.documents(SP_UID).update({ documentId: spDocId, status: 'draft', data });
        const applied = await svc.apply(spDocId, rePlanned);
        svc.log('korekce_revert', rec.korekce, session, { důvod: 'změna opravené části ceny' });
        svc.log('korekce_transfer', applied, session);
      } catch (e) {
        strapi.log.error(`visit-close: korekce re-apply failed for ${spDocId}: ${e.message}`);
        await svc.apply(spDocId, rec.korekce).catch(() => {});
        throw e;
      }
    } else {
      await strapi.documents(SP_UID).update({ documentId: spDocId, status: 'draft', data });
    }

    // правка суммы у интерного визита тянет за собой списание с зарплаты (s203)
    if (booking.internal === true) {
      await strapi
        .service('api::booking-engine.internal-payroll')
        .syncDraft(bookingDocId, { sum: Math.round(parseMoney(merged.staffSalaries) || 0) })
        .catch((e) => strapi.log.error(`internal-payroll sync on checkout patch failed: ${e.message}`));
    }

    strapi.log.info(
      `visit-close: admin ${session?.username || '?'} updated checkout ${spDocId} [${flags.join(',')}]`
    );
    return { checkout: await this._readShaped(spDocId), updated: true };
  },

  /**
   * Удаление брони: снимаем её НЕопубликованный чекаут (иначе останется черновик
   * без связи, который заблокирует публикацию смены pre-flight'ом). Опубликованную
   * запись оставляем — смена уже посчитана, данные визита денормализованы в ней.
   */
  async removeDraftForBooking(bookingDocId) {
    const rec = await this._findByBooking(bookingDocId);
    if (!rec) return { deleted: false };
    if (await this._isPublished(rec.documentId)) return { deleted: false, published: true };
    await this._undoKorekce(rec, bookingDocId, null);
    await strapi.documents(SP_UID).delete({ documentId: rec.documentId });
    strapi.log.info(`visit-close: removed draft checkout ${rec.documentId} with booking ${bookingDocId}`);
    return { deleted: true };
  },

  /**
   * DELETE /engine/admin/checkout/:id — отменить закрытие визита:
   * удалить черновик и вернуть бронь в active (клиент остаётся «dorazil»).
   * Опубликованный документ не трогаем — там уже посчитана смена.
   */
  /**
   * Перед удалением записи (s210): (1) запись коррекции — обратная операция
   * переноса (опубликованное списание → 409, запись остаётся); (2) запись
   * исходного визита — применённые переносы снова ждут её закрытия.
   */
  async _undoKorekce(rec, bookingDocId, session) {
    const svc = korekceSvc();
    if (rec.korekce) {
      await svc.revert(rec.korekce);
      svc.log('korekce_revert', rec.korekce, session);
    }
    if (bookingDocId) await svc.releaseToPending(bookingDocId);
  },

  async remove(spDocId, session) {
    const rec = await strapi.documents(SP_UID).findOne({
      documentId: spDocId,
      status: 'draft',
      populate: { booking: { fields: ['date'] } },
    });
    if (!rec) throw new EngineError(404, 'checkout_not_found', 'Záznam nenalezen');
    if (await this._isPublished(spDocId)) {
      throw new EngineError(409, 'already_published', 'Směna je už uzavřená — záznam nelze zrušit');
    }
    const bookingDocId = rec.booking?.documentId || null;

    await this._undoKorekce(rec, bookingDocId, session);
    await strapi.documents(SP_UID).delete({ documentId: spDocId });

    if (bookingDocId) {
      await strapi
        .service('api::booking-engine.booking-engine')
        .adminPatchBooking(bookingDocId, { status: 'active', arrived: true }, session);
    }

    strapi.log.info(
      `visit-close: admin ${session?.username || '?'} removed checkout ${spDocId} (booking ${bookingDocId || '?'} → active)`
    );
    return { deleted: true, bookingDocId };
  },
};
