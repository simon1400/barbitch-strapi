// @ts-nocheck
// Модуль «Дозаписи администраторов» (s197).
//
// Администратор видит клиентов дня (в салоне сейчас и тех, кто придёт позже) и
// варианты дозаписи услуги ДРУГОЙ категории:
//   • «сразу после» — окно мастера начинается ≤15 мин после конца визита клиента;
//   • «сразу перед» — услуга заканчивается ≤15 мин до начала визита, а начинается
//     не раньше чем через UPSELL_BEFORE_LEAD_MIN от «сейчас» (клиент ещё едет).
// Тот же мастер разрешён, юниоры разрешены.
//
// Клиенту −10 %, администратору 5 % от ПОЛНОЙ цены (не от цены со скидкой).
// Комиссия — ЧЕРНОВИК «Доп. заработка» (add-money, source='upsell', связь booking):
// зарплаты и кабинет читают только опубликованные записи, публикует владелец на
// закрытии смены. Отмена/неявка/удаление дозаписи удаляют черновик.
//
// Скидка хранится как у thank-you-дозаписи (booking.discount.type='rebook'), поэтому
// все её потребители (сверка смены, TG, кабинет клиента, шторка календаря, барьер
// с bitchcard, пересчёт при смене услуги) работают без правок. Отличают её поля
// source='admin', adminUsername, commission. Одна дозапись в день на клиента —
// общая с thank-you.
//
// Классификация и окна — общее ядро upsell-core.ts.
//
// Результат предложения (s199). По каждому клиенту, который СЕГОДНЯ уже пришёл,
// администратор обязан закрыть состояние: дозапись создана (берётся из брони, не
// хранится отдельно) · отказ + причина · не предлагали + причина. Отказы и
// «не предлагали» лежат в коллекции upsell-attempt — одна запись на клиента в день.
// Владелец видит отчёт за месяц: сколько было в салоне, кому предложили, причины,
// сколько осталось без отметки и кто был на смене по графику.

import crypto from 'crypto';
import {
  computePricing,
  minToHHMM,
  pragueDateOf,
  pragueMinOf,
  pragueMinToUtcIso,
  utcToPragueMinClamped,
} from './slots-core';
import { classifyTitle, isExcludedOfferService, windowAfter, windowBefore } from './upsell-core';
import { EngineError } from './booking-engine';

const BOOKING_UID = 'api::booking.booking';
const SALON_SERVICE_UID = 'api::salon-service.salon-service';
const PERSONAL_UID = 'api::personal.personal';
const ADD_MONEY_UID = 'api::add-money.add-money';
const ATTEMPT_UID = 'api::upsell-attempt.upsell-attempt';
const SHIFT_UID = 'api::shift.shift';

const PG_EXCLUSION_VIOLATION = '23P01';

export const UPSELL_DISCOUNT_PERCENT = 10;
export const UPSELL_COMMISSION_PERCENT = 5;
// «сразу перед»: минимум минут от «сейчас» до начала дозаписи (администратор звонит клиенту)
export const UPSELL_BEFORE_LEAD_MIN = 30;

/** Причины результата. Ключи хранятся в базе, подписи — в админке (labels.ts). */
export const UPSELL_RESULT_REASONS = {
  declined: ['no_time', 'price', 'not_interested', 'own_master', 'later', 'other'],
  not_offered: ['no_slots', 'client_busy', 'admin_busy', 'client_left', 'other'],
};
const RESULT_COMMENT_MAX = 500;

const ACTIVE = 'active';
const CHECKED_OUT = 'checkedOut';

const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonthStr = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** Цена клиента и комиссия администратора от ПОЛНОЙ цены услуги (с учётом тира мастера). */
export const upsellAmounts = (price) => {
  const p = Number(price) || 0;
  const discountedPrice = Math.round((p * (100 - UPSELL_DISCOUNT_PERCENT)) / 100);
  return {
    price: p,
    discountedPrice,
    discountKc: p - discountedPrice,
    commissionKc: Math.round((p * UPSELL_COMMISSION_PERCENT) / 100),
  };
};

// Снапшот услуг брони массивом (json-поле или JSON-строка); битый → []
const svcArray = (raw) => {
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(arr) ? arr : [];
};
const svcTitles = (raw) => svcArray(raw).map((s) => s?.title || s?.base || '').filter(Boolean);
const jsonObj = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const genDocumentId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (let i = 0; i < 24; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
};

// связь объектом {documentId} — строкой Strapi 5 путает documentId, начинающийся с цифры, с id (s146)
const rel = (documentId) => (documentId ? { documentId } : null);

const engine = () => strapi.service('api::booking-engine.booking-engine');

/**
 * Контекст клиента на день по его броням (active + checkedOut).
 *   excludedBuckets — категории всех его броней дня;
 *   alreadyRebooked — уже есть дозапись (thank-you или админская) — одна в день;
 *   anchorAfter    — активная бронь с самым поздним концом;
 *   anchorBefore   — ближайшая БУДУЩАЯ активная бронь (сегодня — начало позже «сейчас»),
 *                    beforeMinStartMin — не раньше конца его же брони, кончающейся до неё.
 * Чистая функция: минуты — пражские, nowMin=null для не-сегодняшнего дня.
 */
export const clientDayContext = (bookings, date, nowMin) => {
  const excludedBuckets = new Set();
  let alreadyRebooked = false;
  const active = [];
  for (const b of bookings) {
    for (const t of svcTitles(b.services)) {
      const bucket = classifyTitle(t);
      if (bucket) excludedBuckets.add(bucket);
    }
    if (jsonObj(b.discount)?.type === 'rebook') alreadyRebooked = true;
    if (b.status === ACTIVE && b.startsAt && b.endsAt) {
      active.push({
        b,
        startMin: utcToPragueMinClamped(b.startsAt, date),
        endMin: utcToPragueMinClamped(b.endsAt, date),
      });
    }
  }
  let anchorAfter = null;
  for (const a of active) if (!anchorAfter || a.endMin > anchorAfter.endMin) anchorAfter = a;
  let anchorBefore = null;
  for (const a of active) {
    if (nowMin != null && a.startMin <= nowMin) continue;
    if (!anchorBefore || a.startMin < anchorBefore.startMin) anchorBefore = a;
  }
  // клиент не может быть в двух местах: дозапись «перед» не раньше конца его же визита
  let beforeFloor = null;
  if (anchorBefore) {
    for (const b of bookings) {
      if (b === anchorBefore.b || !b.startsAt || !b.endsAt) continue;
      if (b.status !== ACTIVE && b.status !== CHECKED_OUT) continue;
      const s = utcToPragueMinClamped(b.startsAt, date);
      if (s >= anchorBefore.startMin) continue;
      const e = utcToPragueMinClamped(b.endsAt, date);
      if (beforeFloor == null || e > beforeFloor) beforeFloor = e;
    }
  }
  const leadFloor = nowMin != null ? nowMin + UPSELL_BEFORE_LEAD_MIN : null;
  const floors = [beforeFloor, leadFloor].filter((x) => x != null);
  return {
    excludedBuckets,
    alreadyRebooked,
    anchorAfter,
    anchorBefore,
    beforeMinStartMin: floors.length ? Math.max(...floors) : null,
    inSalon: nowMin != null && active.some((a) => a.startMin <= nowMin && nowMin < a.endMin),
    hasFutureVisit: active.some((a) => nowMin == null || a.endMin > nowMin),
  };
};

/**
 * Варианты дозаписи у одного мастера для одного режима. Чистая функция.
 * after  — окно одно, все услуги стартуют вместе и должны влезть в него;
 * before — у каждой услуги свой старт (встаёт вплотную к визиту).
 */
export const masterOffers = ({ mode, master, offerable, excludedBuckets, hourRow, busyList, ctx, isToday, nowMin }) => {
  const services = [];
  if (mode === 'after') {
    if (!ctx.anchorAfter) return [];
    const win = windowAfter(hourRow, busyList, ctx.anchorAfter.endMin, isToday, nowMin);
    if (!win) return [];
    for (const [docId, { svc, bucket }] of offerable) {
      if (!master.serviceIds.has(docId) || excludedBuckets.has(bucket)) continue;
      if (svc.durationMin > win.availMin) continue;
      services.push({ svc, bucket, startMin: win.startMin, endMin: win.startMin + svc.durationMin });
    }
  } else {
    if (!ctx.anchorBefore) return [];
    for (const [docId, { svc, bucket }] of offerable) {
      if (!master.serviceIds.has(docId) || excludedBuckets.has(bucket)) continue;
      const win = windowBefore(hourRow, busyList, ctx.anchorBefore.startMin, svc.durationMin, ctx.beforeMinStartMin);
      if (!win) continue;
      services.push({ svc, bucket, startMin: win.startMin, endMin: win.endMin });
    }
  }
  return services.map(({ svc, bucket, startMin, endMin }) => {
    const pricing = computePricing({ basePrice: svc.price, baseDurationMin: svc.durationMin, tier: master.tier });
    const amounts = upsellAmounts(pricing.price);
    return {
      serviceDocId: svc.documentId,
      title: svc.title,
      bucket,
      durationMin: svc.durationMin,
      price: amounts.price,
      discountedPrice: amounts.discountedPrice,
      commissionKc: amounts.commissionKc,
      startMin,
      startTime: minToHHMM(startMin),
      endTime: minToHHMM(endMin),
    };
  });
};

/** Клиент уже пришёл: хотя бы один его визит дня (active/checkedOut) начался. Только сегодня. */
export const clientArrived = (bookings, date, nowMin) =>
  nowMin != null &&
  bookings.some(
    (b) => (b.status === ACTIVE || b.status === CHECKED_OUT) && b.startsAt && utcToPragueMinClamped(b.startsAt, date) <= nowMin
  );

/**
 * Результат по клиенту за день. Чистая функция.
 *   booked — есть живая админская дозапись (из брони, не из журнала);
 *   site   — дозаписалась сама на сайте (thank-you) — предлагать было нечего;
 *   declined / not_offered — отметка администратора из upsell-attempt;
 *   null   — не отмечено.
 * bookings — брони клиента за день; учитываются только active/checkedOut.
 */
export const clientDayResult = (bookings, attempt) => {
  let site = null;
  for (const b of bookings) {
    if (b.status !== ACTIVE && b.status !== CHECKED_OUT) continue;
    const d = jsonObj(b.discount);
    if (d?.type !== 'rebook') continue;
    if (d.source === 'admin') {
      return { outcome: 'booked', reason: null, comment: '', adminUsername: d.adminUsername || '', updatedAt: null, bookingDocId: b.documentId };
    }
    site = { outcome: 'site', reason: null, comment: '', adminUsername: '', updatedAt: null, bookingDocId: b.documentId };
  }
  if (site) return site;
  if (!attempt) return null;
  return {
    outcome: attempt.outcome,
    reason: attempt.reason || null,
    comment: attempt.comment || '',
    adminUsername: attempt.adminUsername || '',
    updatedAt: attempt.updatedAt || null,
    bookingDocId: null,
  };
};

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ymdParts = (ymd) => ymd.split('-').map(Number);
const dowOf = (ymd) => {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const addDays = (ymd, n) => {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const mondayOf = (ymd) => addDays(ymd, -((dowOf(ymd) + 6) % 7));

export default {
  // ── общие загрузки ──

  async _offerableCatalog() {
    const catalog = await strapi.documents(SALON_SERVICE_UID).findMany({
      filters: { active: true, onlineBookable: true },
      sort: ['categoryOrder:asc', 'order:asc', 'title:asc'],
      fields: ['title', 'category', 'durationMin', 'price'],
      limit: 500,
    });
    const offerable = new Map(); // serviceDocId → {svc, bucket}
    for (const s of catalog) {
      const bucket = classifyTitle(s.category) ?? classifyTitle(s.title);
      if (!bucket) continue;
      if (isExcludedOfferService(s.title, s.price)) continue;
      if (!s.durationMin || s.durationMin <= 0) continue;
      offerable.set(s.documentId, { svc: s, bucket });
    }
    return offerable;
  },

  async _masters(offerable) {
    const personals = await strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { isActive: true },
      fields: ['name', 'tier', 'noonaEmployeeId'],
      populate: { services: { fields: ['title'] } },
      limit: 100,
    });
    return personals
      .map((p) => ({
        documentId: p.documentId,
        name: p.name,
        tier: p.tier === 'junior' ? 'junior' : 'senior',
        noonaEmployeeId: p.noonaEmployeeId,
        serviceIds: new Set((p.services || []).map((s) => s.documentId)),
      }))
      .filter((m) => [...m.serviceIds].some((id) => offerable.has(id)));
  },

  // брони клиента(ов) дня, которые участвуют в правилах: active + checkedOut
  async _dayBookings(date, clientDocId = null) {
    const filters = { date, status: { $in: [ACTIVE, CHECKED_OUT] } };
    if (clientDocId) filters.client = { documentId: { $eq: clientDocId } };
    return strapi.documents(BOOKING_UID).findMany({
      filters,
      sort: 'startsAt:asc',
      fields: ['date', 'startsAt', 'endsAt', 'status', 'services', 'discount', 'clientNameRaw', 'employeeNameRaw', 'engineEmployeeId'],
      populate: { client: { fields: ['name', 'phone'] }, employee: { fields: ['name'] } },
      limit: 500,
    });
  },

  // ── GET /engine/admin/upsell/day?date= ──

  async dayCandidates({ date, now = new Date() }) {
    const todayPrague = pragueDateOf(now);
    const day = date || todayPrague;
    if (!isDateStr(day)) throw new EngineError(400, 'bad_date', 'date должен быть YYYY-MM-DD');
    const isToday = day === todayPrague;
    const nowMin = isToday ? pragueMinOf(now) : null;
    const shell = {
      date: day,
      now: isToday ? minToHHMM(nowMin) : null,
      discountPercent: UPSELL_DISCOUNT_PERCENT,
      commissionPercent: UPSELL_COMMISSION_PERCENT,
      clients: [],
      // сегодня: клиенты, чьи визиты уже закончились, но результат по ним нужен
      leftClients: [],
    };
    if (day < todayPrague) return { ...shell, past: true };

    const bookings = await this._dayBookings(day);
    const byClient = new Map();
    for (const b of bookings) {
      const id = b.client?.documentId;
      if (!id) continue;
      if (!byClient.has(id)) byClient.set(id, []);
      byClient.get(id).push(b);
    }
    if (!byClient.size) return shell;

    const offerable = await this._offerableCatalog();
    const masters = offerable.size ? await this._masters(offerable) : [];
    const { hoursByDate, busy } = masters.length
      ? await engine().loadDayContexts(masters, day, day)
      : { hoursByDate: new Map(), busy: new Map() };
    const hourRow = hoursByDate.get(day);
    const busyOf = (docId) => busy.get(day)?.get(docId) || [];
    const attempts = isToday ? await this._attempts(day, day) : new Map();

    const clients = [];
    const leftClients = [];
    for (const [clientDocId, list] of byClient) {
      const ctx = clientDayContext(list, day, nowMin);
      const arrived = clientArrived(list, day, nowMin);
      const left = !ctx.hasFutureVisit; // визиты закончились или закрыты
      if (left && !arrived) continue;
      const first = list[0];
      const offers = [];
      if (!ctx.alreadyRebooked && !left) {
        for (const mode of ['after', 'before']) {
          const anchor = mode === 'after' ? ctx.anchorAfter : ctx.anchorBefore;
          if (!anchor) continue;
          for (const m of masters) {
            const services = masterOffers({
              mode,
              master: m,
              offerable,
              excludedBuckets: ctx.excludedBuckets,
              hourRow,
              busyList: busyOf(m.documentId),
              ctx,
              isToday,
              nowMin,
            });
            if (!services.length) continue;
            offers.push({
              mode,
              employeeDocId: m.documentId,
              employeeName: m.name,
              tier: m.tier,
              anchorBookingDocId: anchor.b.documentId,
              startMin: Math.min(...services.map((s) => s.startMin)),
              services,
            });
          }
        }
        offers.sort((a, b) => a.startMin - b.startMin || a.employeeName.localeCompare(b.employeeName));
      }
      const result = arrived ? clientDayResult(list, attempts.get(`${day}|${clientDocId}`)) : null;
      (left ? leftClients : clients).push({
        clientDocId,
        clientName: first.client?.name || first.clientNameRaw || '',
        phone: first.client?.phone || '',
        inSalon: ctx.inSalon,
        arrived,
        left,
        result,
        needsResult: arrived && !result,
        alreadyRebooked: ctx.alreadyRebooked,
        firstStartMin: Math.min(...list.map((b) => utcToPragueMinClamped(b.startsAt, day))),
        bookings: list.map((b) => ({
          documentId: b.documentId,
          status: b.status,
          employeeName: b.employee?.name || b.employeeNameRaw || '',
          time: `${minToHHMM(utcToPragueMinClamped(b.startsAt, day))}–${minToHHMM(utcToPragueMinClamped(b.endsAt, day))}`,
          services: svcTitles(b.services),
          isRebook: jsonObj(b.discount)?.type === 'rebook',
        })),
        offers,
      });
    }
    clients.sort((a, b) => a.firstStartMin - b.firstStartMin || a.clientName.localeCompare(b.clientName));
    // ушедшие: сначала те, по кому результат ещё не отмечен
    leftClients.sort(
      (a, b) => Number(b.needsResult) - Number(a.needsResult) || a.firstStartMin - b.firstStartMin || a.clientName.localeCompare(b.clientName)
    );
    return { ...shell, clients, leftClients };
  },

  // карточка администратора — по строке имени (инвариант s194: personal.name = username)
  async _adminPersonalDocId(username) {
    const name = String(username || '').trim();
    if (!name) return null;
    const rows = await strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { name: { $eqi: name }, position: 'administrator' },
      fields: ['name'],
      limit: 1,
    });
    return rows[0]?.documentId || null;
  },

  // ── POST /engine/admin/upsell {anchorBooking, service, employee, mode} ──

  async create({ session, anchorBookingDocId, serviceDocId, employeeDocId, mode, now = new Date() }) {
    if (mode !== 'after' && mode !== 'before') throw new EngineError(400, 'bad_mode', 'mode: after | before');
    if (!anchorBookingDocId) throw new EngineError(400, 'anchor_required', 'Нужна бронь клиента');

    const anchor = await strapi.documents(BOOKING_UID).findOne({
      documentId: anchorBookingDocId,
      fields: ['date', 'status', 'clientNameRaw'],
      populate: { client: { fields: ['name'] } },
    });
    if (!anchor) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');
    if (anchor.status !== ACTIVE || !anchor.client?.documentId) {
      throw new EngineError(409, 'upsell_stale', 'Situace se změnila — obnovte seznam');
    }
    const date = String(anchor.date);
    const todayPrague = pragueDateOf(now);
    if (date < todayPrague) throw new EngineError(409, 'upsell_stale', 'Situace se změnila — obnovte seznam');
    const isToday = date === todayPrague;
    const nowMin = isToday ? pragueMinOf(now) : null;

    const list = await this._dayBookings(date, anchor.client.documentId);
    const ctx = clientDayContext(list, date, nowMin);
    if (ctx.alreadyRebooked) throw new EngineError(409, 'already_rebooked', 'Klientka už dnes dozápis má');
    const expectedAnchor = mode === 'after' ? ctx.anchorAfter : ctx.anchorBefore;
    if (expectedAnchor?.b.documentId !== anchorBookingDocId) {
      throw new EngineError(409, 'upsell_stale', 'Situace se změnila — obnovte seznam');
    }

    const svc = await engine().resolveService(serviceDocId);
    if (svc.onlineBookable === false) throw new EngineError(404, 'service_not_bookable', 'Služba není dostupná');
    const bucket = classifyTitle(svc.category) ?? classifyTitle(svc.title);
    if (!bucket || ctx.excludedBuckets.has(bucket) || isExcludedOfferService(svc.title, svc.price) || !(svc.durationMin > 0)) {
      throw new EngineError(409, 'rebook_unavailable', 'Tuto službu nelze dozapsat');
    }
    const assigned = await engine().listEmployeesForService(svc.documentId);
    const emp = assigned.find((p) => p.documentId === employeeDocId);
    if (!emp) throw new EngineError(400, 'employee_service_mismatch', 'Mistrová tuto službu nedělá');
    const master = {
      documentId: emp.documentId,
      name: emp.name,
      tier: emp.tier === 'junior' ? 'junior' : 'senior',
      noonaEmployeeId: emp.noonaEmployeeId,
      serviceIds: new Set([svc.documentId]),
    };

    // окно всё ещё свободно — тем же расчётом, что и в списке вариантов
    const { hoursByDate, busy } = await engine().loadDayContexts([master], date, date);
    const offered = masterOffers({
      mode,
      master,
      offerable: new Map([[svc.documentId, { svc, bucket }]]),
      excludedBuckets: ctx.excludedBuckets,
      hourRow: hoursByDate.get(date),
      busyList: busy.get(date)?.get(master.documentId) || [],
      ctx,
      isToday,
      nowMin,
    });
    const offer = offered[0];
    if (!offer) throw new EngineError(409, 'slot_taken', 'Okénko už bohužel není volné');

    const pricing = computePricing({ basePrice: svc.price, baseDurationMin: svc.durationMin, tier: master.tier });
    const amounts = upsellAmounts(pricing.price);
    const username = String(session?.username || '').trim();
    const adminPersonalDocId = await this._adminPersonalDocId(username);
    const clientName = anchor.client.name || anchor.clientNameRaw || '';
    const snapshot = engine().buildServiceSnapshot(svc, null, [], pricing);
    const discount = {
      type: 'rebook',
      source: 'admin',
      percent: UPSELL_DISCOUNT_PERCENT,
      discountKc: amounts.discountKc,
      originalPrice: amounts.price,
      applied: true,
      anchorBookingDocId,
      adminUsername: username,
      adminPersonalDocId,
      commission: {
        percent: UPSELL_COMMISSION_PERCENT,
        kc: amounts.commissionKc,
        addMoneyDocId: null,
      },
    };

    const startsAt = pragueMinToUtcIso(date, offer.startMin);
    const endsAt = pragueMinToUtcIso(date, offer.startMin + svc.durationMin);
    const knex = strapi.db.connection;
    const clientRow = (await knex('clients').select('id').where('document_id', anchor.client.documentId))[0];
    if (!clientRow) throw new EngineError(404, 'client_not_found', 'Klient nenalezen');
    const personalRowList = await engine().personalRows(master.documentId);

    const documentId = genDocumentId();
    try {
      await knex.transaction(async (trx) => {
        await engine().insertBookingRaw(trx, {
          documentId,
          clientRow,
          personalRowList,
          data: {
            clientName,
            date,
            startsAt,
            endsAt,
            services: snapshot,
            totalPrice: amounts.discountedPrice,
            comment: '',
            origin: 'admin',
            cancelToken: crypto.randomUUID(),
            employeeDocId: master.documentId,
            createdByName: username,
            priceOverride: true,
            discount,
          },
        });
      });
    } catch (e) {
      if (e?.code === PG_EXCLUSION_VIOLATION) throw new EngineError(409, 'slot_taken', 'Okénko právě někdo obsadil');
      throw e;
    }

    // комиссия — черновик «Доп. заработка»; без карточки администратора не создаётся
    let commission = null;
    let commissionReason = null;
    if (!adminPersonalDocId) {
      commissionReason = 'no_personal';
    } else {
      try {
        const created = await strapi.documents(ADD_MONEY_UID).create({
          status: 'draft',
          data: {
            title: `Dozápis: ${clientName} → ${svc.title} u ${master.name}`,
            date,
            sum: String(amounts.commissionKc),
            personal: rel(adminPersonalDocId),
            source: 'upsell',
            booking: rel(documentId),
          },
        });
        const next = { ...discount, commission: { ...discount.commission, addMoneyDocId: created.documentId } };
        await knex('bookings')
          .where('document_id', documentId)
          .update({ discount: JSON.stringify(next), updated_at: new Date() });
        commission = { kc: amounts.commissionKc, addMoneyDocId: created.documentId };
      } catch (e) {
        // бронь без записи комиссии администратору не нужна — откатываем её целиком
        strapi.log.error(`upsell: commission draft failed for ${documentId}, booking rolled back: ${e.message}`);
        try {
          await strapi.documents(BOOKING_UID).delete({ documentId });
        } catch (e2) {
          strapi.log.error(`upsell: rollback of booking ${documentId} failed: ${e2.message}`);
        }
        throw new EngineError(500, 'commission_failed', 'Provizi se nepodařilo založit — dozápis nevytvořen');
      }
    }

    // клиент стоит рядом — письма нет; Telegram салону + push мастеру
    strapi
      .service('api::booking-engine.booking-notify')
      .notifyUpsellCreated(documentId, username)
      .catch((e) => strapi.log.error(`upsell notify failed: ${e.message}`));
    strapi
      .service('api::booking-engine.push-notify')
      .notifyBookingEvent(documentId, 'new')
      .catch((e) => strapi.log.error(`upsell push failed: ${e.message}`));
    strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action: 'booking_create',
        entityType: 'booking',
        actorName: username,
        entityDocId: documentId,
        clientName,
        employeeName: master.name,
        summary: `Dozápis: ${clientName} · ${offer.startTime} · ${master.name}`,
        details: {
          čas: `${offer.startTime}–${offer.endTime}`,
          mistr: master.name,
          klient: clientName,
          služba: svc.title,
          cena: `${amounts.discountedPrice} Kč (z ${amounts.price} Kč, −${UPSELL_DISCOUNT_PERCENT} %)`,
          provize: commission ? `${commission.kc} Kč` : '—',
        },
      })
      .catch((e) => strapi.log.error(`upsell calendar-log failed: ${e.message}`));

    strapi.log.info(
      `booking-engine: upsell ${documentId} by ${username || '?'} (${svc.title} · ${master.name} · ${date} ${offer.startTime} · ${amounts.discountedPrice} Kč · provize ${commission ? commission.kc : '—'})`
    );

    return {
      bookingId: documentId,
      date,
      mode,
      time: offer.startTime,
      endTime: offer.endTime,
      totalPrice: amounts.discountedPrice,
      originalPrice: amounts.price,
      employee: { documentId: master.documentId, name: master.name },
      serviceTitle: svc.title,
      clientName,
      commission,
      commissionReason,
    };
  },

  // ── GET /engine/admin/upsell/mine?month=YYYY-MM ──

  async mine({ session, month }) {
    if (!isMonthStr(month)) throw new EngineError(400, 'bad_month', 'month должен быть YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const isOwner = session?.role === 'owner';

    const knex = strapi.db.connection;
    let q = knex('bookings')
      .select('document_id', 'date', 'starts_at', 'ends_at', 'status', 'services', 'total_price', 'discount', 'client_name_raw', 'employee_name_raw')
      .whereBetween('date', [from, to])
      .whereRaw(`discount->>'source' = 'admin'`)
      .orderBy('starts_at', 'desc');
    if (!isOwner) {
      q = q.whereRaw(`lower(trim(discount->>'adminUsername')) = lower(trim(?))`, [String(session?.username || '')]);
    }
    const bookings = await q;

    const moneyIds = [
      ...new Set(bookings.map((b) => jsonObj(b.discount)?.commission?.addMoneyDocId).filter(Boolean)),
    ];
    const drafts = new Map();
    const published = new Map();
    if (moneyIds.length) {
      const [d, p] = await Promise.all([
        strapi.documents(ADD_MONEY_UID).findMany({ status: 'draft', filters: { documentId: { $in: moneyIds } }, fields: ['sum'], limit: 1000 }),
        strapi.documents(ADD_MONEY_UID).findMany({ status: 'published', filters: { documentId: { $in: moneyIds } }, fields: ['sum'], limit: 1000 }),
      ]);
      for (const r of d) drafts.set(r.documentId, r);
      for (const r of p) published.set(r.documentId, r);
    }
    const kcOf = (rec, fallback) => {
      const n = Number(String(rec?.sum ?? '').replace(',', '.'));
      return Number.isFinite(n) && rec?.sum != null && rec.sum !== '' ? Math.round(n) : fallback;
    };

    const rows = bookings.map((b) => {
      const d = jsonObj(b.discount) || {};
      const date = typeof b.date === 'string' ? b.date.slice(0, 10) : pragueDateOf(b.date);
      const moneyId = d.commission?.addMoneyDocId || null;
      const pub = moneyId ? published.get(moneyId) : null;
      const draft = moneyId ? drafts.get(moneyId) : null;
      let state;
      if (pub) state = 'confirmed';
      else if (b.status === 'cancelled' || b.status === 'noshow') state = 'cancelled';
      else if (!draft) state = 'no_commission';
      else if (b.status === CHECKED_OUT) state = 'awaiting_confirmation';
      else state = 'awaiting_visit';
      const commissionKc = kcOf(pub || draft, Number(d.commission?.kc) || 0);
      return {
        bookingDocId: b.document_id,
        date,
        time: b.starts_at ? minToHHMM(utcToPragueMinClamped(b.starts_at, date)) : '',
        clientName: b.client_name_raw || '',
        serviceTitle: svcTitles(b.services).join(' + '),
        employeeName: b.employee_name_raw || '',
        adminUsername: d.adminUsername || '',
        originalPrice: Number(d.originalPrice) || 0,
        totalPrice: b.total_price != null ? Number(b.total_price) : null,
        bookingStatus: b.status,
        state,
        commissionKc,
      };
    });

    const sum = (list, st) =>
      list.filter((r) => st.includes(r.state)).reduce((s, r) => s + r.commissionKc, 0);
    const EXPECTED = ['awaiting_visit', 'awaiting_confirmation'];
    const CONFIRMED = ['confirmed'];
    const out = { month, rows, expectedKc: sum(rows, EXPECTED), confirmedKc: sum(rows, CONFIRMED) };
    if (isOwner) {
      const groups = new Map();
      for (const r of rows) {
        const k = r.adminUsername || '—';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      out.byAdmin = [...groups.entries()]
        .map(([adminUsername, list]) => ({
          adminUsername,
          count: list.length,
          expectedKc: sum(list, EXPECTED),
          confirmedKc: sum(list, CONFIRMED),
        }))
        .sort((a, b) => a.adminUsername.localeCompare(b.adminUsername));
    }
    return out;
  },

  // ── результат предложения (s199) ──

  // отметки администраторов за период: ключ `date|clientDocId`
  async _attempts(from, to) {
    const rows = await strapi.documents(ATTEMPT_UID).findMany({
      filters: { date: { $gte: from, $lte: to } },
      fields: ['date', 'outcome', 'reason', 'comment', 'adminUsername', 'clientName', 'updatedAt'],
      populate: { client: { fields: ['name'] } },
      limit: 10000,
    });
    const map = new Map();
    for (const r of rows) {
      const id = r.client?.documentId;
      if (!id) continue;
      map.set(`${String(r.date).slice(0, 10)}|${id}`, r);
    }
    return map;
  },

  // POST /engine/admin/upsell/result {client, outcome, reason, comment}
  async saveResult({ session, clientDocId, outcome, reason, comment, now = new Date() }) {
    const reasons = UPSELL_RESULT_REASONS[outcome];
    if (!reasons) throw new EngineError(400, 'bad_outcome', 'outcome: declined | not_offered');
    if (!reasons.includes(reason)) throw new EngineError(400, 'bad_reason', 'Neznámý důvod');
    const text = String(comment ?? '').trim().slice(0, RESULT_COMMENT_MAX);
    if (reason === 'other' && !text) throw new EngineError(400, 'comment_required', 'Napište, co se stalo');
    if (!clientDocId) throw new EngineError(400, 'client_required', 'Chybí klientka');

    // только сегодня и только по клиенту, который уже пришёл
    const date = pragueDateOf(now);
    const nowMin = pragueMinOf(now);
    const list = await this._dayBookings(date, clientDocId);
    if (!clientArrived(list, date, nowMin)) {
      throw new EngineError(409, 'result_not_arrived', 'Výsledek lze zapsat jen u klientky, která už dnes přišla');
    }
    if (clientDayResult(list, null)) {
      throw new EngineError(409, 'result_auto', 'Klientka už dozápis má — výsledek se zapsal sám');
    }

    const username = String(session?.username || '').trim();
    const clientName = list[0]?.client?.name || list[0]?.clientNameRaw || '';
    const existing = await strapi.documents(ATTEMPT_UID).findMany({
      filters: { date, client: { documentId: { $eq: clientDocId } } },
      fields: ['outcome'],
      limit: 1,
    });
    const data = { date, clientName, outcome, reason, comment: text, adminUsername: username };
    const saved = existing[0]
      ? await strapi.documents(ATTEMPT_UID).update({ documentId: existing[0].documentId, data })
      : await strapi.documents(ATTEMPT_UID).create({ data: { ...data, client: rel(clientDocId) } });

    strapi.log.info(
      `booking-engine: upsell result ${outcome}/${reason} for client ${clientDocId} by ${username || '?'} (${existing[0] ? 'updated' : 'created'})`
    );
    return {
      clientDocId,
      result: {
        outcome,
        reason,
        comment: text,
        adminUsername: username,
        updatedAt: saved?.updatedAt || now.toISOString(),
        bookingDocId: null,
      },
    };
  },

  // дежурный администратор по графику (коллекция shift, свободный текст «Вика»), см. s115
  async _dutyByDate(from, to) {
    const mondays = new Set();
    for (let d = from; d <= to; d = addDays(d, 1)) mondays.add(mondayOf(d));
    const shifts = await strapi.documents(SHIFT_UID).findMany({
      status: 'draft',
      filters: { from: { $in: [...mondays] } },
      fields: ['from'],
      populate: { days: true },
      limit: 20,
    });
    const byMonday = new Map(shifts.map((sh) => [String(sh.from).slice(0, 10), sh.days || {}]));
    const out = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      out.set(d, String(byMonday.get(mondayOf(d))?.[DAY_KEYS[dowOf(d)]] || '').trim());
    }
    return out;
  },

  // ── GET /engine/admin/upsell/report?month=YYYY-MM — только владелец ──
  async report({ month, now = new Date() }) {
    if (!isMonthStr(month)) throw new EngineError(400, 'bad_month', 'month должен быть YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const today = pragueDateOf(now);
    const nowMin = pragueMinOf(now);
    const totals = {
      visited: 0,
      site: 0,
      required: 0,
      marked: 0,
      booked: 0,
      declined: 0,
      notOffered: 0,
      missing: 0,
      conversionPct: null,
      coveragePct: null,
    };
    if (from > today) return { month, today, totals, byAdmin: [], reasons: [], days: [], rows: [] };
    const end = to < today ? to : today;

    const [bookings, attempts, duty] = await Promise.all([
      strapi.documents(BOOKING_UID).findMany({
        filters: { date: { $gte: from, $lte: end }, status: { $in: [ACTIVE, CHECKED_OUT] } },
        sort: 'startsAt:asc',
        fields: ['date', 'startsAt', 'endsAt', 'status', 'services', 'discount', 'clientNameRaw', 'employeeNameRaw'],
        populate: { client: { fields: ['name'] }, employee: { fields: ['name'] } },
        limit: 10000,
      }),
      this._attempts(from, end),
      this._dutyByDate(from, end),
    ]);

    const groups = new Map(); // date|client → брони клиента за день
    for (const b of bookings) {
      const id = b.client?.documentId;
      if (!id) continue;
      const date = String(b.date).slice(0, 10);
      const k = `${date}|${id}`;
      if (!groups.has(k)) groups.set(k, { date, clientDocId: id, list: [] });
      groups.get(k).list.push(b);
    }

    const KEY = { booked: 'booked', declined: 'declined', not_offered: 'notOffered', site: 'site', missing: 'missing' };
    const days = new Map();
    const dayRow = (date) => {
      if (!days.has(date)) {
        days.set(date, { date, duty: duty.get(date) || '', visited: 0, site: 0, booked: 0, declined: 0, notOffered: 0, missing: 0 });
      }
      return days.get(date);
    };
    const admins = new Map();
    const adminRow = (name) => {
      const k = name || '—';
      if (!admins.has(k)) admins.set(k, { adminUsername: k, booked: 0, declined: 0, notOffered: 0 });
      return admins.get(k);
    };
    const reasons = new Map();
    const rows = [];

    for (const { date, clientDocId, list } of groups.values()) {
      // прошлые дни: пришла, раз визит не отменён и не неявка; сегодня — визит уже начался
      if (!(date < today || clientArrived(list, date, nowMin))) continue;
      const result = clientDayResult(list, attempts.get(`${date}|${clientDocId}`));
      const outcome = result?.outcome || 'missing';
      const d = dayRow(date);
      d.visited += 1;
      d[KEY[outcome]] += 1;
      totals.visited += 1;
      totals[KEY[outcome]] += 1;
      if (outcome === 'booked' || outcome === 'declined' || outcome === 'not_offered') {
        adminRow(result.adminUsername)[KEY[outcome]] += 1;
      }
      if (result?.reason) {
        const rk = `${outcome}|${result.reason}`;
        reasons.set(rk, (reasons.get(rk) || 0) + 1);
      }
      const first = list[0];
      rows.push({
        date,
        time: first.startsAt ? minToHHMM(utcToPragueMinClamped(first.startsAt, date)) : '',
        clientDocId,
        clientName: first.client?.name || first.clientNameRaw || '',
        employees: [...new Set(list.map((b) => b.employee?.name || b.employeeNameRaw || '').filter(Boolean))],
        services: list.flatMap((b) => svcTitles(b.services)),
        outcome,
        reason: result?.reason || null,
        comment: result?.comment || '',
        adminUsername: result?.adminUsername || '',
        updatedAt: result?.updatedAt || null,
        duty: duty.get(date) || '',
      });
    }

    totals.required = totals.visited - totals.site;
    totals.marked = totals.required - totals.missing;
    const offered = totals.booked + totals.declined;
    totals.conversionPct = offered ? Math.round((totals.booked * 100) / offered) : null;
    totals.coveragePct = totals.required ? Math.round((totals.marked * 100) / totals.required) : null;

    rows.sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time) || a.clientName.localeCompare(b.clientName));
    return {
      month,
      today,
      totals,
      byAdmin: [...admins.values()].sort((a, b) => a.adminUsername.localeCompare(b.adminUsername)),
      reasons: [...reasons.entries()]
        .map(([k, count]) => {
          const [outcome, reason] = k.split('|');
          return { outcome, reason, count };
        })
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)),
      rows,
    };
  },

  // ── хуки: отмена/неявка/удаление дозаписи убирают неопубликованную комиссию ──
  // Опубликованную (смена уже закрыта, деньги посчитаны) НЕ трогаем.
  async dropCommissionDraft(bookingDocId) {
    if (!bookingDocId) return 0;
    const rows = await strapi.documents(ADD_MONEY_UID).findMany({
      status: 'draft',
      filters: { source: 'upsell', booking: { documentId: { $eq: bookingDocId } } },
      fields: ['sum'],
      limit: 10,
    });
    let deleted = 0;
    for (const r of rows) {
      const pub = await strapi.documents(ADD_MONEY_UID).findOne({
        documentId: r.documentId,
        status: 'published',
        fields: ['sum'],
      });
      if (pub) {
        strapi.log.info(`upsell: commission ${r.documentId} of booking ${bookingDocId} already published — kept`);
        continue;
      }
      await strapi.documents(ADD_MONEY_UID).delete({ documentId: r.documentId });
      deleted += 1;
      strapi.log.info(`upsell: commission draft ${r.documentId} removed with booking ${bookingDocId}`);
    }
    return deleted;
  },
};
