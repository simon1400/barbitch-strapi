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
  parseMoney,
} from '../../../utils/verify-flags';

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
];

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
      published: Boolean(published),
      personalName: rec.personal?.name || '',
      voucher: rec.voucher
        ? { documentId: rec.voucher.documentId, idVoucher: rec.voucher.idVoucher, sum: rec.voucher.sum }
        : null,
    };
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
    const { fullPrice, paidExpected, systemDiscountKc } = bookingPricing(booking, null);
    const mustStaff = Math.round(fullPrice * (ratePercent / 100) * 100) / 100;
    return {
      checkout: this._shape(rec, published),
      hint: {
        fullPrice,
        paidExpected,
        systemDiscountKc,
        ratePercent,
        mustStaff,
        mustSalon: Math.round((paidExpected - mustStaff) * 100) / 100,
      },
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
  async _flagsFor(booking, { staffSalaries, salonSalaries, sale, internal }) {
    const flags = computeBookingFlags({
      booking,
      ratePercent: Number(booking.employee?.ratePercent) || 0,
      staffSalaries: parseMoney(staffSalaries),
      salonSalaries: parseMoney(salonSalaries),
      sale,
      internal,
    });

    if (flags.includes('sleva') && process.env.LOYALTY_ENABLED === 'true') {
      try {
        const hasRebook = booking.discount?.type === 'rebook' && booking.discount?.applied;
        let hasRedemption = hasRebook;
        if (!hasRedemption) {
          const used = await strapi.documents(REDEMPTION_UID).count({
            filters: { status: { $eq: 'used' }, usedInBookingDocId: { $eq: booking.documentId } },
          });
          hasRedemption = used > 0;
        }
        if (!hasRedemption) flags.push('sleva_bez_karty');
      } catch (e) {
        strapi.log.warn(`visit-close: sleva_bez_karty check failed: ${e?.message || e}`);
      }
    }
    return flags;
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

    const internal = body.internal === true;
    const sale = orNull(body.sale);
    const flags = await this._flagsFor(booking, {
      staffSalaries: body.staffSalaries,
      salonSalaries: body.salonSalaries,
      sale,
      internal,
    });

    const date = String(booking.date);
    const time = booking.startsAt ? minToHHMM(utcToPragueMinClamped(booking.startsAt, date)) : null;
    const clientName = booking.client?.name || booking.clientNameRaw || '';
    if (!clientName) throw new EngineError(400, 'client_required', 'U rezervace chybí jméno klientky');

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
        comment: orNull(body.comment),
        verifyFlags: flags,
        verify: dominantEmoji(flags),
      },
    });

    // бронь → checkedOut (реюз adminPatchBooking: arrived=true, журнал/пуш как обычно)
    if (booking.status !== 'checkedOut') {
      await strapi
        .service('api::booking-engine.booking-engine')
        .adminPatchBooking(bookingDocId, { status: 'checkedOut' }, session);
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
    const flags = await this._flagsFor(booking, merged);

    const data: Record<string, unknown> = {
      staffSalaries: moneyStr(merged.staffSalaries),
      salonSalaries: moneyStr(merged.salonSalaries),
      sale: merged.sale,
      internal: merged.internal,
      verifyFlags: flags,
      verify: dominantEmoji(flags),
    };
    if ('tip' in body) data.tip = orNull(body.tip) ? moneyStr(body.tip) : null;
    if ('cash' in body) data.cash = body.cash !== false;
    if ('comment' in body) data.comment = orNull(body.comment);
    if ('voucherDocId' in body) {
      data.voucher = body.voucherDocId ? rel(await this._resolveVoucher(body.voucherDocId)) : null;
    }

    await strapi.documents(SP_UID).update({ documentId: spDocId, status: 'draft', data });

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
    await strapi.documents(SP_UID).delete({ documentId: rec.documentId });
    strapi.log.info(`visit-close: removed draft checkout ${rec.documentId} with booking ${bookingDocId}`);
    return { deleted: true };
  },

  /**
   * DELETE /engine/admin/checkout/:id — отменить закрытие визита:
   * удалить черновик и вернуть бронь в active (клиент остаётся «dorazil»).
   * Опубликованный документ не трогаем — там уже посчитана смена.
   */
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
