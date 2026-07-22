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
const CLIENT_UID = 'api::client.client';
const VOUCHER_UID = 'api::voucher.voucher';

// Окно ежедневного начисления: брони за последние N дней (не только «вчера») —
// ловит поздние чекауты (смену закрыли/перезакрыли через день-два). Идемпотентно.
const ACCRUE_WINDOW_DAYS = 7;
// Бонус за регистрацию в кабинете. По умолчанию ВЫКЛЮЧЕН (0).
// Включить = задать env SIGNUP_BONUS_KC (напр. 100). ≤0 → бонус не начисляется.
const SIGNUP_BONUS_KC = Number(process.env.SIGNUP_BONUS_KC) || 0;

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

  // ── сид трека bitchcard 2026 ──
  // Идемпотентно по thresholdKc: досоздаёт недостающие ступени, не дублируя
  // существующие. Так 4-я награда (voucher 10000) добавится и на уже засиженном
  // проде без миграции — пропущенные пороги просто дозаведутся при первом проходе.
  // Награда C (решение владельца 2026-07-19): порог 10000 → бонус-ваучер 1000 Kč,
  // тип voucher (в трек кабинета НЕ рисуется — отдаётся отдельным bonusReward,
  // применяется через claimVoucherReward, а НЕ applyRedemptionToBooking).
  async ensureSeedRewards() {
    const seed = [
      { title: 'Sleva 20 %', thresholdKc: 3000, discountType: 'percent', discountValue: 20, order: 1 },
      { title: 'Sleva 400 Kč', thresholdKc: 5000, discountType: 'fixed', discountValue: 400, order: 2 },
      { title: 'Sleva 50 %', thresholdKc: 8000, discountType: 'percent', discountValue: 50, order: 3 },
      { title: 'Dárkový voucher 1000 Kč', thresholdKc: 10000, discountType: 'voucher', discountValue: 1000, order: 4 },
    ];
    const existing = await strapi.documents(REWARD_UID).findMany({
      fields: ['thresholdKc'],
      limit: 100,
    });
    const haveThresholds = new Set(existing.map((r) => Number(r.thresholdKc)));
    let seeded = 0;
    for (const r of seed) {
      if (haveThresholds.has(r.thresholdKc)) continue;
      await strapi.documents(REWARD_UID).create({ data: { ...r, active: true } });
      seeded++;
    }
    if (seeded) strapi.log.info(`loyalty: seeded ${seeded} bitchcard reward(s)`);
    return { seeded };
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

  // Приводит награды клиента в соответствие с ТЕКУЩИМ балансом карточного года:
  //  • порог достигнут (balance ≥ threshold) и награды ещё нет → создать available;
  //  • порог НЕ достигнут (balance < threshold) → снять ещё НЕиспользованную
  //    награду (status='available'), если она осталась с момента, когда баланс был
  //    выше (ручная −Kč корректировка / пере-бэкфил после скидки). used/expired
  //    НЕ трогаем — скидка уже применена к брони / награда сгорела 31.12.
  // Уникальность client+reward+cardYear — каждая ступень раз в карточный год.
  async recomputeClientRewards(clientDocId: string, cardYear: number) {
    const balance = await this.balanceOf(clientDocId, cardYear);
    const rewards = await strapi.documents(REWARD_UID).findMany({
      filters: { active: { $eq: true } },
      sort: 'thresholdKc:asc',
      limit: 50,
    });
    let created = 0;
    let revoked = 0;
    for (const reward of rewards) {
      const existing = await strapi.documents(REDEMPTION_UID).findMany({
        filters: {
          client: { documentId: { $eq: clientDocId } },
          reward: { documentId: { $eq: reward.documentId } },
          cardYear: { $eq: cardYear },
        },
        fields: ['status'],
        limit: 5,
      });
      if (balance >= Number(reward.thresholdKc)) {
        if (existing.length > 0) continue; // награда любого статуса уже есть
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
      } else {
        // баланс упал ниже порога → снять невыданные (available) награды
        for (const r of existing) {
          if (r.status !== 'available') continue;
          await strapi.documents(REDEMPTION_UID).delete({ documentId: r.documentId });
          revoked++;
        }
      }
    }
    if (revoked) {
      strapi.log.info(
        `loyalty: revoked ${revoked} unearned redemption(s) for client ${clientDocId} (${cardYear}, balance ${balance})`
      );
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
    // Бонус-ваучер — не скидка на чек: его нельзя «уплатнить на бронь», только
    // получить как подарочный voucher (claimVoucherReward).
    if (redemption.reward.discountType === 'voucher') {
      throw new LoyaltyError(409, 'voucher_not_applicable', 'Bonusový voucher nelze uplatnit na rezervaci');
    }
    if (redemption.status !== 'available') {
      throw new LoyaltyError(409, 'redemption_unavailable', 'Sleva už byla uplatněna nebo vypršela');
    }
    if (redemption.expiresAt && new Date(redemption.expiresAt).getTime() < Date.now()) {
      throw new LoyaltyError(409, 'redemption_unavailable', 'Platnost slevy vypršela');
    }
    // «Награду нельзя применить, пока порог не достигнут» — проверка на момент
    // применения (баланс мог упасть ниже порога после выдачи награды: ручная
    // −Kč корректировка / пере-бэкфил). Единый барьер для кабинета/админа/кода.
    const balanceNow = await this.balanceOf(clientDocId, Number(redemption.cardYear));
    if (balanceNow < Number(redemption.reward.thresholdKc)) {
      throw new LoyaltyError(
        409,
        'reward_not_earned',
        'Na tuto slevu zatím nemáte nárok — chybí ještě body do dalšího prahu'
      );
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
    // Гейт (решение владельца 2026-07-21): available-скидки bitchcard в календаре
    // показываем ТОЛЬКО клиентам с цифровым аккаунтом кабинета (emailVerifiedAt).
    // Бумажные карты не действуют — чтобы получить скидку, клиент регистрируется
    // в кабинете, тогда его накопленные награды становятся видны. Уже ПРИМЕНЁННУЮ
    // к этой брони скидку (used) показываем всегда — факт брони, админ может снять.
    const client = clientDocId
      ? await strapi.documents(CLIENT_UID).findOne({
          documentId: clientDocId,
          fields: ['emailVerifiedAt'],
        })
      : null;
    const registered = !!client?.emailVerifiedAt;

    const availFilter = {
      status: { $eq: 'available' },
      client: { documentId: { $eq: clientDocId } },
    };
    const usedFilter = { status: { $eq: 'used' }, usedInBookingDocId: { $eq: bookingDocId } };

    let filters;
    if (bookingDocId) {
      // used всегда; available — только зарегистрированным
      filters = registered ? { $or: [availFilter, usedFilter] } : usedFilter;
    } else {
      if (!registered) return [];
      filters = availFilter;
    }

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

  // Прогресс копилки для админ-флоу (drawer календаря): сколько клиент накопил
  // за текущий карточный год и сколько осталось до следующей награды. Гейта по
  // emailVerifiedAt тут нет намеренно — это информация для админа («до скидки
  // 400 Kč вам не хватает 400 — зарегистрируйтесь в кабинете»), сами available-
  // награды незарегистрированным по-прежнему не отдаются (redemptionsForAdmin).
  // Voucher-ступень (бонус-сюрприз 10000) следующей наградой НЕ считается —
  // как в треке кабинета (loyaltyForClient), чтобы не спойлерить сюрприз.
  async clientProgress(clientDocId) {
    const cardYear = Number(pragueDateOf(new Date()).slice(0, 4));
    const [balanceKc, rewards] = await Promise.all([
      this.balanceOf(clientDocId, cardYear),
      strapi.documents(REWARD_UID).findMany({
        filters: { active: { $eq: true } },
        sort: 'thresholdKc:asc',
        limit: 50,
      }),
    ]);
    const next =
      rewards.find((r) => r.discountType !== 'voucher' && Number(r.thresholdKc) > balanceKc) ||
      null;
    return {
      cardYear,
      balanceKc,
      nextReward: next
        ? {
            title: next.title,
            thresholdKc: Number(next.thresholdKc),
            remainingKc: Number(next.thresholdKc) - balanceKc,
          }
        : null,
    };
  },

  // ── награда C: получение бонусного подарочного ваучера (решение 2026-07-19) ──
  // Клиент с available voucher-наградой «обналичивает» её в реальный voucher-запись
  // (сразу оплаченную/активную, бесплатную — заработана). Себе (email из client)
  // или в подарок (recipientName + recipientEmail). Генерация PDF/письма — на
  // клиенте (кабинет зовёт /api/send-mail-voucher same-origin, как VoucherForm);
  // здесь только атомарно гасим redemption и создаём voucher-запись.
  //
  // Порядок ради «no double-issue»: сначала условный UPDATE redemption→used
  // (гонка/повтор → 409), потом create voucher. Если create упал — redemption
  // возвращается в available (ничего не выдано → retry возможен). Сбой ПИСЬМА
  // (уже на клиенте) redemption НЕ откатывает — voucher-запись существует.
  async claimVoucherReward(clientDocId, { recipientName, recipientEmail } = {}) {
    this.assertEnabled();
    if (!clientDocId) throw new LoyaltyError(409, 'no_client', 'Chybí klient');

    const rows = await strapi.documents(REDEMPTION_UID).findMany({
      filters: {
        client: { documentId: { $eq: clientDocId } },
        status: { $eq: 'available' },
      },
      populate: { reward: true },
      sort: 'createdAt:asc',
      limit: 20,
    });
    const redemption = rows.find((r) => r.reward?.discountType === 'voucher');
    if (!redemption) {
      throw new LoyaltyError(409, 'no_voucher_reward', 'Nemáte k dispozici bonusový voucher');
    }
    if (redemption.expiresAt && new Date(redemption.expiresAt).getTime() < Date.now()) {
      throw new LoyaltyError(409, 'redemption_unavailable', 'Platnost bonusu vypršela');
    }

    const client = await strapi.documents(CLIENT_UID).findOne({
      documentId: clientDocId,
      fields: ['name', 'email'],
    });
    const forName = String(recipientName || '').trim() || client?.name || 'Zákazník';
    const email = String(recipientEmail || '').trim().toLowerCase() || String(client?.email || '').toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new LoyaltyError(400, 'invalid_email', 'Zadejte platný e-mail příjemce');
    }
    const sum = Number(redemption.reward.discountValue) || 1000;

    const knex = strapi.db.connection;
    const updated = await knex('redemptions')
      .where({ document_id: redemption.documentId, status: 'available' })
      .update({ status: 'used', updated_at: new Date() });
    if (updated !== 1) {
      throw new LoyaltyError(409, 'redemption_unavailable', 'Bonus už byl uplatněn');
    }

    const idVoucher = String(crypto.randomInt(10000000, 100000000));
    let voucher;
    try {
      const today = pragueDateOf(new Date());
      voucher = await strapi.documents(VOUCHER_UID).create({
        data: {
          name: client?.name || forName, // «покупатель» = клиент, заработавший бонус
          for: forName,
          sum,
          dateOrder: today,
          datePay: today, // бесплатный/заработан → уже оплачен
          deliveryMethod: 'email',
          idVoucher,
          email,
          commentAdmin: `bitchcard bonus ${redemption.reward.thresholdKc}`,
        },
      });
    } catch (e) {
      // ничего не выдано → вернуть награду в трек, чтобы клиент повторил
      await knex('redemptions')
        .where({ document_id: redemption.documentId, status: 'used' })
        .update({ status: 'available', updated_at: new Date() });
      strapi.log.error(
        `loyalty: claimVoucher create failed, redemption ${redemption.code} released: ${e?.message || e}`
      );
      throw new LoyaltyError(500, 'voucher_create_failed', 'Voucher se nepodařilo vytvořit');
    }
    // публикуем запись (draft→published), чтобы ваучер был «активным» в системе;
    // сбой публикации не критичен — черновик с datePay всё равно валиден
    try {
      await strapi.documents(VOUCHER_UID).publish({ documentId: voucher.documentId });
    } catch (e) {
      strapi.log.warn(`loyalty: voucher ${idVoucher} created as draft, publish failed: ${e?.message || e}`);
    }

    strapi.log.info(
      `loyalty: voucher reward ${redemption.code} claimed by client ${clientDocId} → voucher ${idVoucher} (${sum} Kč) → ${email}`
    );
    return { idVoucher, sum, recipientName: forName, email };
  },

  // ── бонус за регистрацию (SIGNUP_BONUS_KC при первом входе; по умолч. 0 = выкл) ──
  // Идемпотентно: одна signup-транзакция на клиента НАВСЕГДА (за всю историю,
  // не per год). Сбой начисления не должен ронять вход — зовущий ловит сам.
  async grantSignupBonus(clientDocId) {
    if (!this.enabled() || !clientDocId || SIGNUP_BONUS_KC <= 0) return { granted: 0 };
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

    // Награда C (voucher) в обычный трек кабинета НЕ рисуется (иначе стала бы
    // 4-й ступенью и сломала бы «сюрприз»). Отдаём её ОТДЕЛЬНЫМ полем bonusReward,
    // видимым в UI только после закрытия карты (stamps>=8).
    const trackRewards = rewards.filter((r) => r.discountType !== 'voucher');
    const voucherReward = rewards.find((r) => r.discountType === 'voucher') || null;
    const voucherRedemption = voucherReward
      ? redemptionByReward.get(voucherReward.documentId) || null
      : null;

    return {
      cardYear,
      balanceKc,
      stamps: Math.floor(balanceKc / 1000),
      track: trackRewards.map((reward) => {
        const redemption = redemptionByReward.get(reward.documentId) || null;
        const reached = balanceKc >= Number(reward.thresholdKc);
        // Защита от рассинхрона (баланс упал ниже порога, а recompute ещё не
        // снял награду): available-награду показываем ТОЛЬКО при достигнутом
        // пороге; used/expired — всегда (скидка уже применена / сгорела).
        const showRedemption =
          redemption && (redemption.status !== 'available' || reached);
        return {
          title: reward.title,
          thresholdKc: Number(reward.thresholdKc),
          discountType: reward.discountType,
          discountValue: Number(reward.discountValue),
          reached,
          redemption: showRedemption
            ? {
                status: redemption.status,
                code: redemption.code || null,
                expiresAt: redemption.expiresAt || null,
              }
            : null,
        };
      }),
      // Бонус-ваучер 1000 Kč: available = награда заработана и ещё не обналичена;
      // claimed = уже получен (voucher создан); expired = сгорел 31.12.
      // available гейтим и балансом (баланс мог упасть ниже порога до recompute).
      bonusReward: voucherReward
        ? {
            thresholdKc: Number(voucherReward.thresholdKc),
            value: Number(voucherReward.discountValue),
            available:
              voucherRedemption?.status === 'available' &&
              balanceKc >= Number(voucherReward.thresholdKc),
            claimed: voucherRedemption?.status === 'used',
            expired: voucherRedemption?.status === 'expired',
            expiresAt: voucherRedemption?.expiresAt || null,
          }
        : null,
      transactions: transactions.map((t) => ({
        delta: Number(t.delta) || 0,
        reason: t.reason,
        comment: t.comment || null,
        createdAt: t.createdAt,
      })),
    };
  },
};
