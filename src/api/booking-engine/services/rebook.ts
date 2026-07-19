// @ts-nocheck
// Дозапись с thank-you страницы (rebook): после создания брони предлагаем клиенту
// услуги ДРУГИХ категорий у мастеров, у которых свободное окно начинается сразу
// после конца его визита (≤REBOOK_GAP_TOLERANCE_MIN), со скидкой −15%.
//
// Аутентификация — cancelToken исходной брони (паттерн /engine/manage/:token).
// Предложение живёт REBOOK_OFFER_TTL_MIN минут от создания исходной брони —
// сервер валидирует окно и при выдаче offers, и при создании дозаписи.
//
// Классификация категорий — порт classifyTitle из admin windowCrossSell (s86):
// строка salon-service.category ненадёжна (эмодзи), бакеты по ключевым словам.

import crypto from 'crypto';
import {
  computePricing,
  minToHHMM,
  pragueDateOf,
  pragueMinOf,
  pragueMinToUtcIso,
  subtractIntervals,
  utcToPragueMinClamped,
} from './slots-core';
import { EngineError } from './booking-engine';

const BOOKING_UID = 'api::booking.booking';
const SALON_SERVICE_UID = 'api::salon-service.salon-service';
const PERSONAL_UID = 'api::personal.personal';

const PG_EXCLUSION_VIOLATION = '23P01';

export const REBOOK_DISCOUNT_PERCENT = 15;
// сколько минут после создания исходной брони действует предложение (таймер на thank-you)
export const REBOOK_OFFER_TTL_MIN = 15;
// окно мастера должно начинаться не позже, чем через N минут после конца брони клиента
const REBOOK_GAP_TOLERANCE_MIN = 15;
// суммарный лимит предлагаемых услуг, лимит карточек мастеров и услуг на карточку
// (при 2 карточках × 6 услуг суммарный потолок практически не режет — страховка)
const MAX_OFFER_SERVICES = 12;
const MAX_MASTER_CARDS = 2;
const MAX_SERVICES_PER_MASTER = 6;

// ── классификация категорий (порт classifyTitle из admin windowCrossSell) ──

const BUCKETS = ['manicure', 'brows', 'lashes'];

// подпись специализации на карточке мастера («Lash specialistka»)
const BUCKET_SPECIALIST_CS = { manicure: 'Nail', brows: 'Brow', lashes: 'Lash' };

// Порядок важен: «řas» (ресницы) до «obočí», маникюр последним.
// ⚠️ При новых категориях каталога — дополнить ключевые слова (синхронно с admin).
const classifyTitle = (raw) => {
  const t = String(raw || '').toLowerCase();
  if (t.includes('řas') || t.includes('rias') || t.includes('lash')) return 'lashes';
  if (
    t.includes('obočí') ||
    t.includes('oboci') ||
    t.includes('brow') ||
    t.includes('barvení a péče') ||
    t.includes('laminace') ||
    t.includes('úprava tvaru') ||
    t.includes('uprava tvaru')
  )
    return 'brows';
  const nailKeys = ['nehty', 'manikúra', 'manikura', 'gel lak', 'prodloužení neht', 'nano', 'sundání', 'hygienick', 'ibx'];
  if (nailKeys.some((k) => t.includes(k))) return 'manicure';
  return null;
};

// Не предлагаем снятия/доливы/коррекции — только самостоятельные базовые услуги.
const NON_BASE_KEYWORDS = ['sundání', 'sundani', 'odstranění', 'odstraneni', 'doplnění', 'doplneni', 'korekce'];
const isExcludedOfferService = (title) => {
  const t = String(title || '').toLowerCase();
  return NON_BASE_KEYWORDS.some((k) => t.includes(k));
};

const genDocumentId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (let i = 0; i < 24; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
};

const engine = () => strapi.service('api::booking-engine.booking-engine');

export default {
  // ── контекст якоря: бронь по токену + все брони клиента в тот же день ──

  // Якорь дозаписи = ПОСЛЕДНЯЯ активная бронь клиента в день исходной брони
  // (после успешной дозаписи offers пере-запрашиваются → каскад работает сам:
  // якорь сдвигается на конец дозаписи, её категория попадает в исключённые).
  async _anchorContext(token) {
    const found = await strapi.documents(BOOKING_UID).findMany({
      filters: { cancelToken: token },
      populate: {
        client: { fields: ['name'] },
        employee: { fields: ['name'] },
      },
      limit: 1,
    });
    if (!found.length) throw new EngineError(404, 'booking_not_found', 'Rezervace nenalezena');
    const base = found[0];

    const expiresAtMs = new Date(base.createdAt).getTime() + REBOOK_OFFER_TTL_MIN * 60000;
    const baseInfo = {
      date: base.date,
      time: base.startsAt ? minToHHMM(utcToPragueMinClamped(base.startsAt, String(base.date))) : null,
    };

    if (base.status !== 'active') {
      return { base, baseInfo, expiresAtMs, available: false, reason: 'not_active' };
    }
    if (Date.now() >= expiresAtMs) {
      return { base, baseInfo, expiresAtMs, available: false, reason: 'expired' };
    }
    if (!base.client?.documentId) {
      return { base, baseInfo, expiresAtMs, available: false, reason: 'no_client' };
    }

    const dayBookings = await strapi.documents(BOOKING_UID).findMany({
      filters: {
        date: base.date,
        status: 'active',
        client: { documentId: { $eq: base.client.documentId } },
      },
      fields: ['date', 'startsAt', 'endsAt', 'services', 'engineEmployeeId', 'discount'],
      populate: { employee: { fields: ['name'] } },
      limit: 50,
    });
    const all = dayBookings.length ? dayBookings : [base];

    // дозапись — ОДНА: если среди активных броней дня уже есть rebook-бронь,
    // повторные предложения не выдаём (reload страницы не даёт каскад; создание
    // тоже режется — create проверяет ctx.available)
    if (all.some((b) => b.discount?.type === 'rebook')) {
      return { base, baseInfo, expiresAtMs, available: false, reason: 'already_rebooked' };
    }

    // якорь — бронь с самым поздним концом; исключённые бакеты — со ВСЕХ броней дня
    let anchor = all[0];
    for (const b of all) {
      if (new Date(b.endsAt).getTime() > new Date(anchor.endsAt).getTime()) anchor = b;
    }
    const excludedBuckets = new Set();
    // мастеров, у которых клиент уже записан в этот день, не предлагаем повторно —
    // дозапись = «vedlejší křeslo», а не продление у той же мастерицы
    const excludedEmployees = new Set();
    for (const b of all) {
      const items = Array.isArray(b.services) ? b.services : [];
      for (const it of items) {
        const bucket = classifyTitle(it?.title || it?.base || '');
        if (bucket) excludedBuckets.add(bucket);
      }
      const empDocId = b.employee?.documentId || b.engineEmployeeId;
      if (empDocId) excludedEmployees.add(empDocId);
    }

    const anchorEndMin = utcToPragueMinClamped(anchor.endsAt, String(base.date));
    return {
      base,
      baseInfo,
      expiresAtMs,
      available: true,
      anchorDocId: anchor.documentId,
      anchorEndMin,
      excludedBuckets,
      excludedEmployees,
    };
  },

  // Свободное окно мастера, начинающееся сразу после конца якоря.
  // Возвращает { startMin, availMin } либо null.
  _masterWindow(hourRow, busyList, anchorEndMin, isToday, nowMin) {
    const openMin = hourRow?.openMin ?? null;
    const closeMin = hourRow?.closeMin ?? null;
    if (openMin == null || closeMin == null || closeMin <= openMin) return null;
    const free = subtractIntervals({ startMin: openMin, endMin: closeMin }, busyList);
    for (const gap of free) {
      if (gap.endMin <= anchorEndMin) continue;
      const startMin = Math.max(gap.startMin, anchorEndMin);
      if (startMin > anchorEndMin + REBOOK_GAP_TOLERANCE_MIN) return null; // free отсортирован — дальше только позже
      if (isToday && startMin < nowMin) return null; // якорь уже в прошлом — дозапись не предлагаем
      const availMin = gap.endMin - startMin;
      if (availMin <= 0) continue;
      return { startMin, availMin };
    }
    return null;
  },

  // ── GET /engine/rebook/:token/offers ──

  async offers(token) {
    const ctx = await this._anchorContext(token);
    const shell = {
      discountPercent: REBOOK_DISCOUNT_PERCENT,
      expiresAt: new Date(ctx.expiresAtMs).toISOString(),
      anchor: ctx.baseInfo,
      offers: [],
    };
    if (!ctx.available) return { ...shell, available: false, reason: ctx.reason };

    const date = String(ctx.base.date);
    const todayPrague = pragueDateOf(new Date());
    const nowMin = pragueMinOf(new Date());

    // каталог предлагаемых услуг: другие категории, базовые, без снятий/коррекций
    const catalog = await strapi.documents(SALON_SERVICE_UID).findMany({
      filters: { active: true, onlineBookable: true },
      sort: ['categoryOrder:asc', 'order:asc', 'title:asc'],
      fields: ['title', 'category', 'durationMin', 'price'],
      limit: 500,
    });
    const offerable = new Map(); // serviceDocId → {svc, bucket}
    for (const s of catalog) {
      const bucket = classifyTitle(s.category) ?? classifyTitle(s.title);
      if (!bucket || ctx.excludedBuckets.has(bucket)) continue;
      if (isExcludedOfferService(s.title)) continue;
      if (!s.durationMin || s.durationMin <= 0) continue;
      offerable.set(s.documentId, { svc: s, bucket });
    }
    if (!offerable.size) return { ...shell, available: false, reason: 'no_offers' };

    // активные мастера + их назначенные услуги (со стороны personal — как publicServiceEmployees)
    const personals = await strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { isActive: true },
      fields: ['name', 'tier', 'noonaEmployeeId'],
      populate: { photo: true, services: { fields: ['title'] } },
      limit: 100,
    });
    const masters = personals
      .map((p) => ({
        documentId: p.documentId,
        name: p.name,
        tier: p.tier === 'junior' ? 'junior' : 'senior',
        noonaEmployeeId: p.noonaEmployeeId,
        photoUrl: p.photo?.formats?.thumbnail?.url || p.photo?.url || null,
        serviceIds: new Set((p.services || []).map((s) => s.documentId)),
      }))
      .filter((m) => !ctx.excludedEmployees.has(m.documentId))
      .filter((m) => [...m.serviceIds].some((id) => offerable.has(id)));
    if (!masters.length) return { ...shell, available: false, reason: 'no_offers' };

    const { hoursByDate, busy } = await engine().loadDayContexts(masters, date, date);
    const hourRow = hoursByDate.get(date);

    // карточка per мастер: окно + влезающие услуги (цена с tier мастера, −15% сверху)
    const cards = [];
    for (const m of masters) {
      const win = this._masterWindow(
        hourRow,
        busy.get(date)?.get(m.documentId) || [],
        ctx.anchorEndMin,
        date === todayPrague,
        nowMin
      );
      if (!win) continue;
      const services = [];
      for (const [docId, { svc, bucket }] of offerable) {
        if (!m.serviceIds.has(docId)) continue;
        if (svc.durationMin > win.availMin) continue;
        const pricing = computePricing({ basePrice: svc.price, baseDurationMin: svc.durationMin, tier: m.tier });
        services.push({
          serviceDocId: docId,
          title: svc.title,
          bucket,
          durationMin: svc.durationMin,
          price: pricing.price,
          discountedPrice: Math.round(pricing.price * (1 - REBOOK_DISCOUNT_PERCENT / 100)),
          endTime: minToHHMM(win.startMin + svc.durationMin),
        });
      }
      if (!services.length) continue;
      const buckets = [...new Set(services.map((s) => s.bucket))];
      cards.push({
        employeeDocId: m.documentId,
        employeeName: m.name,
        tier: m.tier,
        photoUrl: m.photoUrl,
        specialist: `${buckets.map((b) => BUCKET_SPECIALIST_CS[b]).join(' & ')} specialistka`,
        buckets,
        startMin: win.startMin,
        startTime: minToHHMM(win.startMin),
        services,
      });
    }
    if (!cards.length) return { ...shell, available: false, reason: 'no_offers' };

    // отбор: раньше старт — выше; первым проходом покрываем разные категории,
    // затем добираем остальных; ≤MAX_MASTER_CARDS карточек, суммарно
    // ≤MAX_OFFER_SERVICES услуг, ≤MAX_SERVICES_PER_MASTER на карточку
    cards.sort((a, b) => a.startMin - b.startMin);
    const picked = [];
    const pickedIds = new Set();
    let total = 0;
    const take = (card) => {
      if (picked.length >= MAX_MASTER_CARDS) return;
      if (pickedIds.has(card.employeeDocId) || total >= MAX_OFFER_SERVICES) return;
      const room = Math.min(MAX_SERVICES_PER_MASTER, MAX_OFFER_SERVICES - total);
      const services = card.services.slice(0, room);
      if (!services.length) return;
      pickedIds.add(card.employeeDocId);
      total += services.length;
      picked.push({ ...card, services });
    };
    for (const bucket of BUCKETS) {
      if (ctx.excludedBuckets.has(bucket)) continue;
      const first = cards.find((c) => c.buckets.includes(bucket) && !pickedIds.has(c.employeeDocId));
      if (first) take(first);
    }
    for (const c of cards) take(c);

    return { ...shell, available: true, offers: picked };
  },

  // ── POST /engine/rebook/:token {service, employee} — дозапись в 1 клик ──

  async create(token, { serviceDocId, employeeDocId }) {
    const ctx = await this._anchorContext(token);
    if (!ctx.available) {
      if (ctx.reason === 'expired') throw new EngineError(410, 'rebook_expired', 'Nabídka dozápisu vypršela');
      throw new EngineError(409, 'rebook_unavailable', 'Dozápis není k dispozici');
    }
    const date = String(ctx.base.date);

    // услуга: активна, онлайн, другой бакет, не снятие/коррекция
    const svc = await engine().resolveService(serviceDocId);
    if (svc.onlineBookable === false) throw new EngineError(404, 'service_not_bookable', 'Služba není dostupná');
    const bucket = classifyTitle(svc.category) ?? classifyTitle(svc.title);
    if (!bucket || ctx.excludedBuckets.has(bucket) || isExcludedOfferService(svc.title)) {
      throw new EngineError(409, 'rebook_unavailable', 'Tuto službu nelze dozarezervovat');
    }

    // мастер: активен, делает услугу и клиент к нему сегодня ещё не записан
    if (ctx.excludedEmployees.has(employeeDocId)) {
      throw new EngineError(409, 'rebook_unavailable', 'K této mistrové už dnes rezervaci máte');
    }
    const assigned = await engine().listEmployeesForService(svc.documentId);
    const emp = assigned.find((p) => p.documentId === employeeDocId);
    if (!emp) throw new EngineError(400, 'employee_service_mismatch', 'Mistrová tuto službu nedělá');

    // окно всё ещё свободно и услуга влезает до следующего клиента мастера
    const todayPrague = pragueDateOf(new Date());
    const nowMin = pragueMinOf(new Date());
    const { hoursByDate, busy } = await engine().loadDayContexts([emp], date, date);
    const win = this._masterWindow(
      hoursByDate.get(date),
      busy.get(date)?.get(emp.documentId) || [],
      ctx.anchorEndMin,
      date === todayPrague,
      nowMin
    );
    if (!win || svc.durationMin > win.availMin) {
      throw new EngineError(409, 'slot_taken', 'Okénko už bohužel není volné');
    }

    const pricing = computePricing({
      basePrice: svc.price,
      baseDurationMin: svc.durationMin,
      tier: emp.tier === 'junior' ? 'junior' : 'senior',
    });
    const discounted = Math.round(pricing.price * (1 - REBOOK_DISCOUNT_PERCENT / 100));
    // снапшот несёт реальную цену услуги; итог брони — со скидкой (priceOverride).
    // Скидка структурированная (booking.discount) — админ управляет ей из drawer
    // календаря (снять/вернуть), кабинет показывает бейдж; паттерн bitchcard.
    const snapshot = engine().buildServiceSnapshot(svc, null, [], pricing);
    // anchorBookingDocId = бронь, «сразу после» которой сделана дозапись: если клиент
    // её отменит/перенесёт, скидка автоматически снимается (revokeDiscountsForAnchor)
    const discount = {
      type: 'rebook',
      percent: REBOOK_DISCOUNT_PERCENT,
      discountKc: pricing.price - discounted,
      originalPrice: pricing.price,
      applied: true,
      anchorBookingDocId: ctx.anchorDocId,
    };

    const startsAt = pragueMinToUtcIso(date, win.startMin);
    const endsAt = pragueMinToUtcIso(date, win.startMin + svc.durationMin);

    const knex = strapi.db.connection;
    const clientRow = (await knex('clients').select('id').where('document_id', ctx.base.client.documentId))[0];
    if (!clientRow) throw new EngineError(404, 'client_not_found', 'Klient nenalezen');
    const personalRowList = await engine().personalRows(emp.documentId);

    const documentId = genDocumentId();
    const cancelToken = crypto.randomUUID();
    try {
      await knex.transaction(async (trx) => {
        await engine().insertBookingRaw(trx, {
          documentId,
          clientRow,
          personalRowList,
          data: {
            clientName: ctx.base.client.name || ctx.base.clientNameRaw || '',
            date,
            startsAt,
            endsAt,
            services: snapshot,
            totalPrice: discounted,
            comment: '',
            origin: 'site',
            cancelToken,
            employeeDocId: emp.documentId,
            priceOverride: true,
            discount,
          },
        });
      });
    } catch (e) {
      if (e?.code === PG_EXCLUSION_VIOLATION) throw new EngineError(409, 'slot_taken', 'Okénko právě někdo obsadil');
      throw e;
    }

    // нотификации fire-and-forget: подтверждение клиенту + Telegram салону + push мастеру
    strapi
      .service('api::booking-engine.booking-notify')
      .notifyBookingCreated(documentId)
      .catch((e) => strapi.log.error(`rebook notify failed: ${e.message}`));
    strapi
      .service('api::booking-engine.push-notify')
      .notifyBookingEvent(documentId, 'new')
      .catch((e) => strapi.log.error(`rebook push failed: ${e.message}`));

    strapi.log.info(
      `booking-engine: rebook created ${documentId} (${svc.title} · ${emp.name} · ${date} ${minToHHMM(win.startMin)} · ${discounted} Kč)`
    );

    return {
      bookingId: documentId,
      date,
      time: minToHHMM(win.startMin),
      endTime: minToHHMM(win.startMin + svc.durationMin),
      totalPrice: discounted,
      originalPrice: pricing.price,
      employee: { documentId: emp.documentId, name: emp.name },
      serviceTitle: svc.title,
    };
  },

  // ── управление скидкой дозаписи из admin-drawer (паттерн redemption bitchcard) ──

  async _bookingWithRebookDiscount(bookingDocId) {
    const booking = await strapi.documents(BOOKING_UID).findOne({ documentId: bookingDocId });
    if (!booking) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');
    const d = booking.discount;
    if (!d || d.type !== 'rebook' || !(Number(d.discountKc) > 0)) {
      throw new EngineError(404, 'rebook_discount_missing', 'На брони нет скидки дозаписи');
    }
    return { booking, discount: d };
  },

  // Транзакционно меняет applied-статус скидки и цену брони на ±discountKc.
  async _toggleDiscount(bookingDocId, apply) {
    const { booking, discount } = await this._bookingWithRebookDiscount(bookingDocId);
    if (booking.status !== 'active') {
      throw new EngineError(409, 'booking_not_active', 'Slevu lze měnit jen u aktivní rezervace');
    }
    if (Boolean(discount.applied) === apply) {
      throw new EngineError(409, apply ? 'discount_already_applied' : 'discount_not_applied',
        apply ? 'Скидка уже применена' : 'Скидка уже снята');
    }
    const delta = apply ? -Number(discount.discountKc) : Number(discount.discountKc);
    const next = { ...discount, applied: apply };
    const knex = strapi.db.connection;
    await knex.transaction(async (trx) => {
      await trx('bookings')
        .where('document_id', bookingDocId)
        .update({
          total_price: knex.raw('COALESCE(total_price, 0) + ?', [delta]),
          discount: JSON.stringify(next),
          updated_at: new Date(),
        });
    });
    const fresh = await strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      fields: ['totalPrice'],
    });
    return {
      applied: apply,
      discountKc: Number(discount.discountKc),
      totalPrice: fresh?.totalPrice != null ? Number(fresh.totalPrice) : null,
      discount: next,
    };
  },

  // DELETE /engine/admin/bookings/:id/rebook-discount — снять скидку (цена назад к полной)
  async removeDiscount(bookingDocId) {
    return this._toggleDiscount(bookingDocId, false);
  },

  // POST /engine/admin/bookings/:id/rebook-discount — вернуть ошибочно снятую скидку
  async restoreDiscount(bookingDocId) {
    return this._toggleDiscount(bookingDocId, true);
  },

  // ── анти-мухлёж: скидка действует, только пока жива якорная бронь ──
  // Клиент мог бы отменить/перенести первую (полную) бронь и оставить только дозапись
  // со скидкой — тогда это уже не дозапись. Хуки движка (отмена клиентом/админом,
  // удаление, перенос клиентом) зовут revokeDiscountsForAnchor(докId якоря) —
  // у всех активных дозаписей с applied-скидкой на этот якорь цена возвращается
  // к полной (та же механика, что «Zrušit slevu» в drawer — админ может вернуть).
  async revokeDiscountsForAnchor(anchorDocId) {
    if (!anchorDocId) return 0;
    const knex = strapi.db.connection;
    const rows = await knex('bookings')
      .select('document_id')
      .where('status', 'active')
      .whereRaw(`discount->>'type' = 'rebook'`)
      .whereRaw(`discount->>'applied' = 'true'`)
      .whereRaw(`discount->>'anchorBookingDocId' = ?`, [anchorDocId]);
    for (const r of rows) {
      try {
        await this._toggleDiscount(r.document_id, false);
        strapi.log.info(`booking-engine: rebook discount revoked on ${r.document_id} (anchor ${anchorDocId} gone)`);
      } catch (e) {
        strapi.log.error(`rebook revoke for ${r.document_id} failed: ${e.message}`);
      }
    }
    return rows.length;
  },

  // Перенос клиентом самой дозаписи: она перестаёт быть «hned po vás» → снять её скидку.
  async revokeOwnDiscount(bookingDocId) {
    const booking = await strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      fields: ['status', 'discount'],
    });
    const d = booking?.discount;
    if (!d || d.type !== 'rebook' || !d.applied || booking.status !== 'active') return false;
    await this._toggleDiscount(bookingDocId, false);
    strapi.log.info(`booking-engine: rebook discount revoked on ${bookingDocId} (booking rescheduled by client)`);
    return true;
  },
};
