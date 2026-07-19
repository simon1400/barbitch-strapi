// @ts-nocheck
/**
 * Сервис личного кабинета клиента (К1): passwordless magic-link auth + профиль + брони.
 *
 * Поверх существующих данных движка: client (email = identity) + booking
 * (relation client + services-снапшот с serviceDocId). Отмена/перенос кабинет
 * НЕ делает (К2 обернёт manage-функции движка под JWT).
 *
 * Всё за env-гейтом CLIENT_JWT_SECRET (cabinetEnabled) → деплой безопасен:
 * без env каждая ручка отвечает 503 cabinet_disabled.
 */
import crypto from 'crypto';

import { cabinetEnabled, signClientSession } from '../../../utils/client-jwt';
import { pragueDateOf, utcToPragueMinClamped, minToHHMM } from '../../booking-engine/services/slots-core';

const CLIENT_UID = 'api::client.client';
const BOOKING_UID = 'api::booking.booking';
const LOGIN_TOKEN_UID = 'api::client-login-token.client-login-token';

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://barbitch.cz';
const LOGIN_TOKEN_TTL_MIN = 15;
const HISTORY_LIMIT = 50;

export class CabinetError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const normalizeEmail = (raw): string => String(raw || '').trim().toLowerCase();

// Базовая проверка формы email (не RFC-полная — режем явный мусор до письма/токена).
const looksLikeEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;

export default {
  assertEnabled() {
    if (!cabinetEnabled()) {
      throw new CabinetError(503, 'cabinet_disabled', 'Kabinet není momentálně dostupný');
    }
  },

  // ── login: найти/создать клиента по email → одноразовый токен → письмо ──

  // Несколько client-записей с одним email (историческая реальность зеркала) →
  // берём самую свежую С БРОНЯМИ, иначе просто самую свежую.
  async resolveClientByEmail(email: string) {
    const candidates = await strapi.documents(CLIENT_UID).findMany({
      filters: { email: { $eqi: email } },
      sort: 'createdAt:desc',
      fields: ['name', 'email'],
      limit: 10,
    });
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    for (const c of candidates) {
      const count = await strapi.documents(BOOKING_UID).count({
        filters: { client: { documentId: { $eq: c.documentId } } },
      });
      if (count > 0) return c;
    }
    return candidates[0];
  },

  async login(rawEmail) {
    this.assertEnabled();
    const email = normalizeEmail(rawEmail);
    if (!looksLikeEmail(email)) {
      throw new CabinetError(400, 'invalid_email', 'Zadejte platný e-mail');
    }

    let client = await this.resolveClientByEmail(email);
    if (!client) {
      client = await strapi.documents(CLIENT_UID).create({
        data: {
          name: email.split('@')[0] || email,
          email,
          source: 'site',
        },
      });
    }

    // Сырой токен живёт только в письме; в БД — sha256-хэш.
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000).toISOString();
    await strapi.documents(LOGIN_TOKEN_UID).create({
      data: {
        tokenHash: sha256(token),
        expiresAt,
        email,
        client: client.documentId,
      },
    });

    const url = `${SITE_URL}/cabinet/verify?token=${token}`;
    try {
      const res = await strapi
        .service('api::booking-engine.booking-notify')
        .sendCabinetLogin(email, url);
      // Письмо реально не ушло (нет RESEND_API_KEY / ENGINE_NOTIFY_DRY) —
      // ссылка в лог, чтобы вход был проверяем на dev. В прод-режиме не логируется.
      if (res?.skipped || res?.dry) {
        strapi.log.info(`client-cabinet DRY login link (${email}): ${url}`);
      }
    } catch (e) {
      // Не палим существование email наружу — сбой письма только в лог.
      strapi.log.error(`client-cabinet login e-mail failed (${email}): ${e?.message || e}`);
    }

    // Ответ ВСЕГДА {ok:true} — не раскрываем, существует ли клиент.
    return { ok: true };
  },

  // ── verify: одноразовое погашение токена → JWT ──

  async verify(rawToken) {
    this.assertEnabled();
    const token = String(rawToken || '').trim();
    if (!token) throw new CabinetError(410, 'token_invalid', 'Odkaz je neplatný nebo vypršel');

    const rows = await strapi.documents(LOGIN_TOKEN_UID).findMany({
      filters: { tokenHash: { $eq: sha256(token) } },
      populate: { client: { fields: ['name', 'email', 'emailVerifiedAt'] } },
      limit: 1,
    });
    const rec = rows[0];
    const now = Date.now();
    if (
      !rec ||
      rec.usedAt ||
      !rec.expiresAt ||
      new Date(rec.expiresAt).getTime() < now ||
      !rec.client
    ) {
      throw new CabinetError(410, 'token_invalid', 'Odkaz je neplatný nebo vypršel');
    }

    const nowIso = new Date(now).toISOString();
    // первый вход = e-mail ещё не был подтверждён (для бонуса за регистрацию ниже)
    const firstLogin = !rec.client.emailVerifiedAt;
    await strapi.documents(LOGIN_TOKEN_UID).update({
      documentId: rec.documentId,
      data: { usedAt: nowIso },
    });
    await strapi.documents(CLIENT_UID).update({
      documentId: rec.client.documentId,
      data: { emailVerifiedAt: nowIso, cabinetLastLoginAt: nowIso },
    });

    // Бонус за регистрацию 100 Kč (решение (е), К4): только при ПЕРВОМ входе,
    // идемпотентно (одна signup-транзакция на клиента навсегда — страховка и от
    // сброшенного emailVerifiedAt). Гейт LOYALTY_ENABLED внутри grantSignupBonus:
    // без env тихо не начисляем, вход работает. Сбой бонуса вход НЕ роняет.
    if (firstLogin) {
      try {
        await strapi.service('api::loyalty.loyalty').grantSignupBonus(rec.client.documentId);
      } catch (e) {
        strapi.log.error(`client-cabinet signup bonus failed (${rec.client.documentId}): ${e?.message || e}`);
      }
    }

    const jwt = signClientSession({
      clientDocId: rec.client.documentId,
      email: rec.client.email || rec.email || '',
    });
    return {
      jwt,
      client: {
        documentId: rec.client.documentId,
        name: rec.client.name,
        email: rec.client.email || rec.email || null,
      },
    };
  },

  // ── профиль ──

  async me(session) {
    this.assertEnabled();
    const client = await strapi.documents(CLIENT_UID).findOne({
      documentId: session.clientDocId,
      fields: ['name', 'phone', 'email', 'birthday', 'marketingConsent', 'emailVerifiedAt'],
    });
    if (!client) throw new CabinetError(404, 'client_not_found', 'Klient nenalezen');
    return {
      documentId: client.documentId,
      name: client.name,
      phone: client.phone || null,
      email: client.email || null,
      birthday: client.birthday || null,
      marketingConsent: Boolean(client.marketingConsent),
      emailVerifiedAt: client.emailVerifiedAt || null,
    };
  },

  async patchMe(session, patch) {
    this.assertEnabled();
    const data: Record<string, unknown> = {};

    if (patch.name !== undefined) {
      const name = String(patch.name || '').trim();
      if (!name || name.length > 120) throw new CabinetError(400, 'invalid_name', 'Neplatné jméno');
      data.name = name;
    }
    if (patch.phone !== undefined) {
      const phone = String(patch.phone || '').trim();
      if (phone.length > 30) throw new CabinetError(400, 'invalid_phone', 'Neplatný telefon');
      data.phone = phone || null;
    }
    if (patch.birthday !== undefined) {
      const birthday = String(patch.birthday || '').trim();
      if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
        throw new CabinetError(400, 'invalid_birthday', 'Neplatné datum narození');
      }
      data.birthday = birthday || null;
    }
    if (patch.marketingConsent !== undefined) {
      data.marketingConsent = Boolean(patch.marketingConsent);
      data.marketingConsentAt = new Date().toISOString();
    }
    // E-mail этой ручкой НЕ меняется: e-mail = identity кабинета,
    // смена — отдельный verify-флоу (не в К1).

    if (Object.keys(data).length > 0) {
      await strapi.documents(CLIENT_UID).update({
        documentId: session.clientDocId,
        data,
      });
    }
    return this.me(session);
  },

  // ── брони клиента ──

  // Скидка для карточки брони кабинета: приоритет bitchcard-redemption (loyalty),
  // иначе структурированная скидка дозаписи из самой брони (rebook, applied).
  shapeDiscount(b, loyaltyDiscount) {
    if (loyaltyDiscount && loyaltyDiscount.discountKc != null) {
      return {
        type: 'bitchcard',
        discountKc: loyaltyDiscount.discountKc,
        rewardTitle: loyaltyDiscount.rewardTitle || null,
        code: loyaltyDiscount.code || null,
      };
    }
    const rd = b.discount;
    if (rd && rd.type === 'rebook' && rd.applied && Number(rd.discountKc) > 0) {
      return {
        type: 'rebook',
        discountKc: Number(rd.discountKc),
        rewardTitle: null,
        code: null,
      };
    }
    return null;
  },

  shapeBooking(b, discount = null) {
    const dateStr = String(b.date || '');
    const services = Array.isArray(b.services) ? b.services : [];
    return {
      documentId: b.documentId,
      date: dateStr || null,
      time:
        b.startsAt && dateStr ? minToHHMM(utcToPragueMinClamped(b.startsAt, dateStr)) : null,
      status: b.status,
      arrived: Boolean(b.arrived),
      services,
      totalPrice: b.totalPrice != null ? Number(b.totalPrice) : null,
      // Применённая скидка: bitchcard (used-redemption) либо структурированная
      // скидка дозаписи (booking.discount type='rebook', пишет движок rebook) —
      // клиент видит, что цена уже со slevou. type различает бейдж и право снятия
      // (rebook клиент снять не может — только админ из календаря).
      discount: this.shapeDiscount(b, discount),
      employeeName: b.employee?.name || b.employeeNameRaw || null,
      startsAt: b.startsAt || null,
      // Отмена из кабинета: любая активная бронь, вкл. зеркальные Noona-брони
      // (cancelToken не нужен — JWT-флоу резолвит по documentId; create-only
      // синк отменённую не воскресит). Правило 3ч проверяет сервер при действии.
      canCancel: b.status === 'active',
      // Перенос: только движковые брони (cancelToken) со снапшотом serviceDocId —
      // зеркальным нечем пересчитать availability (услуга/вариант неизвестны движку).
      canReschedule:
        b.status === 'active' && Boolean(b.cancelToken) && Boolean(services[0]?.serviceDocId),
      // «Записаться znovu» — снапшот несёт serviceDocId (движковые брони).
      canRebook: services.some((s) => Boolean(s?.serviceDocId)),
    };
  },

  async bookings(session) {
    this.assertEnabled();
    const today = pragueDateOf(new Date());
    const baseQuery = {
      fields: [
        'date',
        'startsAt',
        'status',
        'arrived',
        'services',
        'totalPrice',
        'employeeNameRaw',
        'cancelToken',
        'discount',
      ],
      populate: { employee: { fields: ['name'] } },
    };

    const [upcoming, history] = await Promise.all([
      strapi.documents(BOOKING_UID).findMany({
        ...baseQuery,
        filters: {
          client: { documentId: { $eq: session.clientDocId } },
          status: { $eq: 'active' },
          date: { $gte: today },
        },
        sort: ['date:asc', 'startsAt:asc'],
        limit: 100,
      }),
      strapi.documents(BOOKING_UID).findMany({
        ...baseQuery,
        filters: {
          client: { documentId: { $eq: session.clientDocId } },
          $or: [{ date: { $lt: today } }, { status: { $ne: 'active' } }],
        },
        sort: ['date:desc', 'startsAt:desc'],
        limit: HISTORY_LIMIT,
      }),
    ]);

    // Применённые скидки bitchcard для всех броней (тихо [] при выкл. программе)
    let discountMap = {};
    try {
      const ids = [...upcoming, ...history].map((b) => b.documentId);
      discountMap = await strapi.service('api::loyalty.loyalty').usedRedemptionsForBookings(ids);
    } catch (e) {
      strapi.log.warn(`cabinet: usedRedemptionsForBookings failed: ${e?.message || e}`);
    }

    return {
      upcoming: upcoming.map((b) => this.shapeBooking(b, discountMap[b.documentId])),
      history: history.map((b) => this.shapeBooking(b, discountMap[b.documentId])),
    };
  },

  // ── управление бронью из кабинета (К2): JWT-обёртки над manage-ядром движка ──
  // Правила НЕ дублируются: 3ч/лимит переносов/slot_taken/письма/push — всё в
  // cancelBookingCore / manageAvailabilityCore / rescheduleBookingCore (те же,
  // что у токен-флоу /rezervace/{token}). EngineError пробрасывается наружу —
  // контроллер маппит его так же, как CabinetError (status+code).

  // Анти-BOLA: бронь резолвится СТРОГО с фильтром по клиенту из JWT-сессии.
  // Чужая или несуществующая → одинаковый 404 (существование чужих не палим).
  async resolveOwnBooking(session, bookingDocId) {
    const id = String(bookingDocId || '').trim();
    if (id) {
      const rows = await strapi.documents(BOOKING_UID).findMany({
        filters: {
          documentId: { $eq: id },
          client: { documentId: { $eq: session.clientDocId } },
        },
        populate: { employee: { fields: ['name'] } },
        limit: 1,
      });
      if (rows.length) return rows[0];
    }
    throw new CabinetError(404, 'booking_not_found', 'Rezervace nenalezena');
  },

  async cancelBooking(session, bookingDocId) {
    this.assertEnabled();
    const booking = await this.resolveOwnBooking(session, bookingDocId);
    return strapi.service('api::booking-engine.booking-engine').cancelBookingCore(booking);
  },

  async bookingAvailability(session, bookingDocId, fromDate, toDate) {
    this.assertEnabled();
    const booking = await this.resolveOwnBooking(session, bookingDocId);
    return strapi
      .service('api::booking-engine.booking-engine')
      .manageAvailabilityCore(booking, fromDate, toDate);
  },

  async rescheduleBooking(session, bookingDocId, body) {
    this.assertEnabled();
    const booking = await this.resolveOwnBooking(session, bookingDocId);
    return strapi
      .service('api::booking-engine.booking-engine')
      .rescheduleBookingCore(booking, { date: body?.date, time: body?.time });
  },

  // ── лояльность bitchcard (К3): данные цифровой карточки для UI К4 ──
  // Отдельный env-гейт LOYALTY_ENABLED (независим от кабинета) → 503 loyalty_disabled.

  async loyalty(session) {
    this.assertEnabled();
    const loyaltySvc = strapi.service('api::loyalty.loyalty');
    if (!loyaltySvc.enabled()) {
      throw new CabinetError(503, 'loyalty_disabled', 'Věrnostní program není momentálně dostupný');
    }
    return loyaltySvc.loyaltyForClient(session.clientDocId);
  },

  // Уплатнение награды bitchcard на СВОЮ бронь (К4): анти-BOLA через
  // resolveOwnBooking (чужая бронь = 404), владельца награды проверяет сервис
  // лояльности (чужой код = 404 redemption_not_found). LoyaltyError
  // пробрасывается — контроллер маппит status+code как CabinetError.
  async applyRedemption(session, bookingDocId, code) {
    this.assertEnabled();
    const booking = await this.resolveOwnBooking(session, bookingDocId);
    return strapi
      .service('api::loyalty.loyalty')
      .applyRedemptionToBooking(booking, code, session.clientDocId);
  },

  // Снятие применённой награды со СВОЕЙ брони (К4): анти-BOLA через
  // resolveOwnBooking. Только на активной (будущей) брони — прошедшую/отменённую
  // трогать нет смысла. Награда возвращается в трек (used → available), цена
  // восстанавливается на discountKc. Тихий no-op, если скидки на брони нет.
  async releaseRedemption(session, bookingDocId) {
    this.assertEnabled();
    const booking = await this.resolveOwnBooking(session, bookingDocId);
    if (booking.status !== 'active') {
      throw new CabinetError(409, 'booking_not_active', 'Slevu lze zrušit jen u aktivní rezervace');
    }
    return strapi.service('api::loyalty.loyalty').releaseRedemptionForBooking(booking.documentId);
  },

  // Получение бонусного подарочного ваучера (награда C, К4): «обналичить» available
  // voucher-награду в реальный voucher-запись. Себе или в подарок (recipientName +
  // recipientEmail). Владелец награды = клиент из JWT-сессии (resolveOwn не нужен —
  // награда не привязана к брони). Само PDF-письмо шлёт клиент (/api/send-mail-voucher).
  async claimVoucher(session, body) {
    this.assertEnabled();
    const loyaltySvc = strapi.service('api::loyalty.loyalty');
    if (!loyaltySvc.enabled()) {
      throw new CabinetError(503, 'loyalty_disabled', 'Věrnostní program není momentálně dostupný');
    }
    return loyaltySvc.claimVoucherReward(session.clientDocId, {
      recipientName: body?.recipientName,
      recipientEmail: body?.recipientEmail,
    });
  },
};
