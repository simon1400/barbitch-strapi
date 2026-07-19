// @ts-nocheck
/**
 * Сервис лояльности bitchcard (К3): начисление копилки по checkedOut-броням,
 * авто-создание наград (redemption) при пересечении порогов, бэкфил карточного
 * года, expire-проход.
 *
 * Решения владельца (2026-07-18):
 *   (а) точная копилка — баланс года = Σ delta по cardYear, наклейки = floor/1000;
 *   (б) карточный год = календарный, награды сгорают 31.12 (expiresAt);
 *   (в) старт = бэкфил из истории checkedOut за карточный год, цифра = истина;
 *   (г) скидки 20%/50% — на весь чек визита;
 *   (д) ступень 5000 = фикс-скидка 400 Kč (discountType fixed);
 *   (е) бонус регистрации 100 Kč (reason=signup; начисление подключается в К4).
 *
 * Всё за env-гейтом LOYALTY_ENABLED=true → деплой безопасен: без env cron
 * тихо спит, ручки отвечают 503 loyalty_disabled.
 *
 * Идемпотентность: visit-транзакция уникальна по bookingDocId (unique в схеме
 * + предварительная проверка); redemption уникален по client+reward+cardYear
 * (app-level проверка перед create — cron однопоточный).
 */
import crypto from 'crypto';

import { pragueDateOf } from '../../booking-engine/services/slots-core';

const BOOKING_UID = 'api::booking.booking';
const TX_UID = 'api::loyalty-transaction.loyalty-transaction';
const REWARD_UID = 'api::reward.reward';
const REDEMPTION_UID = 'api::redemption.redemption';

// Окно ежедневного начисления: брони за последние N дней (не только «вчера») —
// ловит поздние чекауты (смену закрыли/перезакрыли через день-два). Идемпотентно.
const ACCRUE_WINDOW_DAYS = 7;
const SIGNUP_BONUS_KC = 100; // решение (е); начисление — К4

export class LoyaltyError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Код для админа: без похожих символов (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

// 31.12 cardYear 23:59:59 Praha (зимой UTC+1) → UTC ISO.
const endOfCardYearIso = (year: number) => `${year}-12-31T22:59:59.000Z`;

const shiftDate = (dateStr: string, days: number) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default {
  // Флаг «сервис сам создаёт транзакции пачкой» — lifecycle afterCreate
  // loyalty-transaction в этом режиме НЕ пересчитывает награды per-строку
  // (сервис пересчитает один раз per клиент в конце).
  _bulk: false,
  isBulk() {
    return this._bulk;
  },

  enabled() {
    return process.env.LOYALTY_ENABLED === 'true';
  },

  assertEnabled() {
    if (!this.enabled()) {
      throw new LoyaltyError(503, 'loyalty_disabled', 'Věrnostní program není momentálně dostupný');
    }
  },

  signupBonusKc() {
    return SIGNUP_BONUS_KC;
  },

  // ── сид трека bitchcard 2026 (идемпотентно: только если наград ещё нет) ──
  async ensureSeedRewards() {
    const existing = await strapi.documents(REWARD_UID).count({});
    if (existing > 0) return { seeded: 0 };
    const seed = [
      { title: 'Sleva 20 %', thresholdKc: 3000, discountType: 'percent', discountValue: 20, order: 1 },
      { title: 'Sleva 400 Kč', thresholdKc: 5000, discountType: 'fixed', discountValue: 400, order: 2 },
      { title: 'Sleva 50 %', thresholdKc: 8000, discountType: 'percent', discountValue: 50, order: 3 },
    ];
    for (const r of seed) {
      await strapi.documents(REWARD_UID).create({ data: { ...r, active: true } });
    }
    strapi.log.info('loyalty: seeded bitchcard track (3000/5000/8000)');
    return { seeded: seed.length };
  },

  // ── начисление ──

  // Обработать пачку броней (checkedOut + client): создать visit-транзакции,
  // вернуть затронутых клиентов. Идемпотентно по bookingDocId.
  async _accrueBookings(bookings) {
    let created = 0;
    let skipped = 0;
    const affected = new Map(); // clientDocId → Set<cardYear>

    for (const b of bookings) {
      const clientDocId = b.client?.documentId;
      const delta = Math.round(Number(b.totalPrice) || 0);
      if (!clientDocId || delta <= 0) {
        skipped++;
        continue;
      }
      const dup = await strapi.documents(TX_UID).count({
        filters: { bookingDocId: { $eq: b.documentId } },
      });
      if (dup > 0) {
        skipped++;
        continue;
      }
      const cardYear = Number(String(b.date || '').slice(0, 4));
      if (!cardYear) {
        skipped++;
        continue;
      }
      await strapi.documents(TX_UID).create({
        data: {
          client: clientDocId,
          delta,
          reason: 'visit',
          bookingDocId: b.documentId,
          cardYear,
          comment: null,
          createdByName: 'system',
        },
      });
      created++;
      if (!affected.has(clientDocId)) affected.set(clientDocId, new Set());
      affected.get(clientDocId).add(cardYear);
    }
    return { created, skipped, affected };
  },

  async _fetchCheckedOutBookings(fromDate: string, toDate: string) {
    const all = [];
    const PAGE = 500;
    for (let start = 0; ; start += PAGE) {
      const rows = await strapi.documents(BOOKING_UID).findMany({
        filters: {
          status: { $eq: 'checkedOut' },
          date: { $gte: fromDate, $lte: toDate },
          client: { documentId: { $notNull: true } },
        },
        fields: ['date', 'totalPrice'],
        populate: { client: { fields: ['name'] } },
        sort: 'date:asc',
        start,
        limit: PAGE,
      });
      all.push(...rows.filter((b) => b.client));
      if (rows.length < PAGE) break;
    }
    return all;
  },

  // Ежедневное начисление: окно последних ACCRUE_WINDOW_DAYS дней (вкл. сегодня).
  async accrueRecent() {
    const today = pragueDateOf(new Date());
    const from = shiftDate(today, -ACCRUE_WINDOW_DAYS);
    return this._runAccrual(from, today);
  },

  // Бэкфил карточного года (решение (в) — старт с накопленным прогрессом).
  async backfillYear(year: number) {
    const y = Number(year);
    if (!y || y < 2020 || y > 2100) {
      throw new LoyaltyError(400, 'invalid_year', 'Neplatný rok');
    }
    return this._runAccrual(`${y}-01-01`, `${y}-12-31`);
  },

  async _runAccrual(fromDate: string, toDate: string) {
    await this.ensureSeedRewards();
    const bookings = await this._fetchCheckedOutBookings(fromDate, toDate);
    this._bulk = true;
    let result;
    try {
      result = await this._accrueBookings(bookings);
    } finally {
      this._bulk = false;
    }
    let redemptionsCreated = 0;
    for (const [clientDocId, years] of result.affected) {
      for (const cardYear of years) {
        redemptionsCreated += await this.recomputeClientRewards(clientDocId, cardYear);
      }
    }
    return {
      window: { from: fromDate, to: toDate },
      bookings: bookings.length,
      created: result.created,
      skipped: result.skipped,
      clientsAffected: result.affected.size,
      redemptionsCreated,
    };
  },

  // ── награды ──

  async balanceOf(clientDocId: string, cardYear: number) {
    const rows = await strapi.documents(TX_UID).findMany({
      filters: {
        client: { documentId: { $eq: clientDocId } },
        cardYear: { $eq: cardYear },
      },
      fields: ['delta'],
      limit: 1000,
    });
    return rows.reduce((s, r) => s + (Number(r.delta) || 0), 0);
  },

  // Пересечение порога → авто-создать redemption available («заклеенный кружок»).
  // Уникальность client+reward+cardYear — каждая ступень раз в карточный год.
  async recomputeClientRewards(clientDocId: string, cardYear: number) {
    const balance = await this.balanceOf(clientDocId, cardYear);
    const rewards = await strapi.documents(REWARD_UID).findMany({
      filters: { active: { $eq: true } },
      sort: 'thresholdKc:asc',
      limit: 50,
    });
    let created = 0;
    for (const reward of rewards) {
      if (balance < Number(reward.thresholdKc)) continue;
      const dup = await strapi.documents(REDEMPTION_UID).count({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          reward: { documentId: { $eq: reward.documentId } },
          cardYear: { $eq: cardYear },
        },
      });
      if (dup > 0) continue;
      await strapi.documents(REDEMPTION_UID).create({
        data: {
          client: clientDocId,
          reward: reward.documentId,
          cardYear,
          status: 'available',
          code: genCode(),
          expiresAt: endOfCardYearIso(cardYear),
        },
      });
      created++;
    }
    return created;
  },

  // ── применение награды к брони (К4) ──

  // Скидка К БРОНИ клиента: percent → totalPrice×(1−v/100), fixed/voucher →
  // max(0, totalPrice−v) — на ВЕСЬ чек визита (решение (г)/(д)). В одной
  // knex-транзакции: redemption available→used (условный UPDATE по текущему
  // статусу — защита от гонки/повтора) + totalPrice брони (priceOverride).
  // clientDocId = ожидаемый владелец награды (кабинет: из JWT-сессии; админ:
  // клиент брони) — чужой код даёт тот же 404, что несуществующий.
  async applyRedemptionToBooking(booking, rawCode, clientDocId) {
    this.assertEnabled();
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) throw new LoyaltyError(400, 'code_required', 'Zadejte kód slevy');
    if (!clientDocId) throw new LoyaltyError(409, 'no_client', 'Rezervace nemá klienta');
    if (!['active', 'checkedOut'].includes(booking.status)) {
      throw new LoyaltyError(409, 'booking_not_active', 'Slevu lze uplatnit jen na aktivní rezervaci');
    }
    const totalPrice = booking.totalPrice != null ? Math.round(Number(booking.totalPrice)) : null;
    if (totalPrice == null) throw new LoyaltyError(409, 'no_price', 'Rezervace nemá cenu');

    const rows = await strapi.documents(REDEMPTION_UID).findMany({
      filters: {
        code: { $eq: code },
        client: { documentId: { $eq: clientDocId } },
      },
      populate: { reward: true },
      limit: 1,
    });
    const redemption = rows[0];
    if (!redemption || !redemption.reward) {
      throw new LoyaltyError(404, 'redemption_not_found', 'Kód slevy nenalezen');
    }
    if (redemption.status !== 'available') {
      throw new LoyaltyError(409, 'redemption_unavailable', 'Sleva už byla uplatněna nebo vypršela');
    }
    if (redemption.expiresAt && new Date(redemption.expiresAt).getTime() < Date.now()) {
      throw new LoyaltyError(409, 'redemption_unavailable', 'Platnost slevy vypršela');
    }
    // одна скидка на бронь
    const already = await strapi.documents(REDEMPTION_UID).count({
      filters: { status: { $eq: 'used' }, usedInBookingDocId: { $eq: booking.documentId } },
    });
    if (already > 0) {
      throw new LoyaltyError(409, 'booking_has_redemption', 'Na rezervaci už je uplatněna sleva');
    }

    const reward = redemption.reward;
    const value = Number(reward.discountValue) || 0;
    const newPrice =
      reward.discountType === 'percent'
        ? Math.round(totalPrice * (1 - value / 100))
        : Math.max(0, totalPrice - Math.round(value));
    const discountKc = totalPrice - newPrice;

    const knex = strapi.db.connection;
    await knex.transaction(async (trx) => {
      // идемпотентность/гонки: UPDATE проходит только пока статус available
      const updated = await trx('redemptions')
        .where({ document_id: redemption.documentId, status: 'available' })
        .update({
          status: 'used',
          used_in_booking_doc_id: booking.documentId,
          discount_kc: discountKc,
          updated_at: new Date(),
        });
      if (updated !== 1) {
        throw new LoyaltyError(409, 'redemption_unavailable', 'Sleva už byla uplatněna nebo vypršela');
      }
      await trx('bookings').where('document_id', booking.documentId).update({
        total_price: newPrice,
        price_override: true,
        updated_at: new Date(),
      });
    });

    strapi.log.info(
      `loyalty: redemption ${code} (${reward.title}) applied to booking ${booking.documentId}: ${totalPrice} → ${newPrice} Kč`
    );
    return {
      applied: true,
      code,
      reward: { title: reward.title, discountType: reward.discountType, discountValue: value },
      discountKc,
      totalPrice: newPrice,
      originalPrice: totalPrice,
    };
  },

  // Возврат награды при отмене/удалении брони (или ручном снятии админом):
  // used → available + восстановление цены брони на discountKc. Тихий no-op,
  // если на брони скидки нет. За гейтом LOYALTY_ENABLED (как вся программа).
  async releaseRedemptionForBooking(bookingDocId, { restorePrice = true } = {}) {
    if (!this.enabled()) return { released: 0 };
    const rows = await strapi.documents(REDEMPTION_UID).findMany({
      filters: { status: { $eq: 'used' }, usedInBookingDocId: { $eq: bookingDocId } },
      limit: 1,
    });
    const redemption = rows[0];
    if (!redemption) return { released: 0 };
    const discountKc = Math.round(Number(redemption.discountKc) || 0);

    const knex = strapi.db.connection;
    await knex.transaction(async (trx) => {
      const updated = await trx('redemptions')
        .where({ document_id: redemption.documentId, status: 'used' })
        .update({
          status: 'available',
          used_in_booking_doc_id: null,
          discount_kc: null,
          updated_at: new Date(),
        });
      if (updated !== 1) return; // кто-то успел раньше — no-op
      if (restorePrice && discountKc > 0) {
        // total_price = COALESCE(total_price,0) + discountKc — цена возвращается к до-скидочной
        await trx('bookings')
          .where('document_id', bookingDocId)
          .update({
            total_price: knex.raw('COALESCE(total_price, 0) + ?', [discountKc]),
            updated_at: new Date(),
          });
      }
    });
    strapi.log.info(`loyalty: redemption ${redemption.code} released from booking ${bookingDocId} (+${discountKc} Kč back)`);
    return { released: 1, code: redemption.code, discountKc };
  },

  // Награды клиента для админ-флоу (drawer календаря): available + применённая
  // к конкретной брони (если передана).
  // Карта применённых скидок по броням: bookingDocId → {code, discountKc,
  // rewardTitle}. Для отображения «✓ Sleva −X Kč» в списке броней кабинета.
  // Пустая карта, если программа выключена (тихо, вход/список не роняем).
  async usedRedemptionsForBookings(bookingDocIds) {
    if (!this.enabled() || !Array.isArray(bookingDocIds) || bookingDocIds.length === 0) {
      return {};
    }
    const rows = await strapi.documents(REDEMPTION_UID).findMany({
      filters: { status: { $eq: 'used' }, usedInBookingDocId: { $in: bookingDocIds } },
      populate: { reward: { fields: ['title', 'discountType', 'discountValue'] } },
      limit: 200,
    });
    const map = {};
    for (const r of rows) {
      if (!r.usedInBookingDocId) continue;
      map[r.usedInBookingDocId] = {
        code: r.code || null,
        discountKc: r.discountKc != null ? Number(r.discountKc) : null,
        rewardTitle: r.reward?.title || null,
      };
    }
    return map;
  },

  async redemptionsForAdmin(clientDocId, bookingDocId = null) {
    this.assertEnabled();
    const filters = bookingDocId
      ? {
          $or: [
            { status: { $eq: 'available' }, client: { documentId: { $eq: clientDocId } } },
            { status: { $eq: 'used' }, usedInBookingDocId: { $eq: bookingDocId } },
          ],
        }
      : { status: { $eq: 'available' }, client: { documentId: { $eq: clientDocId } } };
    const rows = await strapi.documents(REDEMPTION_UID).findMany({
      filters,
      populate: { reward: true },
      sort: 'createdAt:asc',
      limit: 20,
    });
    return rows
      .filter((r) => r.reward)
      .map((r) => ({
        documentId: r.documentId,
        status: r.status,
        code: r.code,
        cardYear: r.cardYear,
        expiresAt: r.expiresAt || null,
        usedInBookingDocId: r.usedInBookingDocId || null,
        discountKc: r.discountKc != null ? Number(r.discountKc) : null,
        reward: {
          title: r.reward.title,
          thresholdKc: Number(r.reward.thresholdKc),
          discountType: r.reward.discountType,
          discountValue: Number(r.reward.discountValue),
        },
      }));
  },

  // ── бонус за регистрацию (решение (е): 100 Kč при первом входе в кабинет) ──
  // Идемпотентно: одна signup-транзакция на клиента НАВСЕГДА (за всю историю,
  // не per год). Сбой начисления не должен ронять вход — зовущий ловит сам.
  async grantSignupBonus(clientDocId) {
    if (!this.enabled() || !clientDocId) return { granted: 0 };
    const existing = await strapi.documents(TX_UID).count({
      filters: {
        client: { documentId: { $eq: clientDocId } },
        reason: { $eq: 'signup' },
      },
    });
    if (existing > 0) return { granted: 0 };
    const cardYear = Number(pragueDateOf(new Date()).slice(0, 4));
    await strapi.documents(TX_UID).create({
      data: {
        client: clientDocId,
        delta: SIGNUP_BONUS_KC,
        reason: 'signup',
        cardYear,
        comment: 'Bonus za registraci do kabinetu',
        createdByName: 'system',
      },
    });
    // lifecycle afterCreate сам пересчитает награды (не bulk-режим)
    strapi.log.info(`loyalty: signup bonus +${SIGNUP_BONUS_KC} Kč → client ${clientDocId}`);
    return { granted: SIGNUP_BONUS_KC, cardYear };
  },

  // Награды сгорают 31.12 карточного года (решение (б)).
  async expirePass() {
    const nowIso = new Date().toISOString();
    const rows = await strapi.documents(REDEMPTION_UID).findMany({
      filters: { status: { $eq: 'available' }, expiresAt: { $lt: nowIso } },
      limit: 1000,
    });
    for (const r of rows) {
      await strapi.documents(REDEMPTION_UID).update({
        documentId: r.documentId,
        data: { status: 'expired' },
      });
    }
    return { expired: rows.length };
  },

  // Полный ежедневный проход (cron + ручной триггер mode=daily).
  async runDaily() {
    const accrual = await this.accrueRecent();
    const expire = await this.expirePass();
    return { ...accrual, ...expire };
  },

  // ── данные для кабинета (К3 ручка, UI — К4) ──

  async loyaltyForClient(clientDocId: string) {
    const cardYear = Number(pragueDateOf(new Date()).slice(0, 4));
    const [balanceKc, rewards, redemptions, transactions] = await Promise.all([
      this.balanceOf(clientDocId, cardYear),
      strapi.documents(REWARD_UID).findMany({
        filters: { active: { $eq: true } },
        sort: 'thresholdKc:asc',
        limit: 50,
      }),
      strapi.documents(REDEMPTION_UID).findMany({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          cardYear: { $eq: cardYear },
        },
        populate: { reward: { fields: ['thresholdKc'] } },
        limit: 50,
      }),
      strapi.documents(TX_UID).findMany({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          cardYear: { $eq: cardYear },
        },
        fields: ['delta', 'reason', 'comment', 'createdAt'],
        sort: 'createdAt:desc',
        limit: 50,
      }),
    ]);

    const redemptionByReward = new Map(
      redemptions.filter((r) => r.reward).map((r) => [r.reward.documentId, r])
    );

    return {
      cardYear,
      balanceKc,
      stamps: Math.floor(balanceKc / 1000),
      track: rewards.map((reward) => {
        const redemption = redemptionByReward.get(reward.documentId) || null;
        return {
          title: reward.title,
          thresholdKc: Number(reward.thresholdKc),
          discountType: reward.discountType,
          discountValue: Number(reward.discountValue),
          reached: balanceKc >= Number(reward.thresholdKc),
          redemption: redemption
            ? {
                status: redemption.status,
                code: redemption.code || null,
                expiresAt: redemption.expiresAt || null,
              }
            : null,
        };
      }),
      transactions: transactions.map((t) => ({
        delta: Number(t.delta) || 0,
        reason: t.reason,
        comment: t.comment || null,
        createdAt: t.createdAt,
      })),
    };
  },
};
