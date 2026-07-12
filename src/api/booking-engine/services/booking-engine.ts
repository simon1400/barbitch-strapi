// @ts-nocheck
// Движок бронирования (own-booking): availability / holds / bookings / admin-операции.
// Пишет ТОЛЬКО в наши коллекции (booking/client/slot-hold/time-block), к Noona не ходит.
//
// Горячий путь записи (holds, bookings) — raw SQL через strapi.db.connection (Knex):
//   - транзакции + Postgres EXCLUDE-constraint (backup/engine_db_migrate.mjs) исключают
//     двойную бронь на уровне БД (код 23P01 → 409 slot_taken);
//   - raw-вставка брони заполняет link-таблицы как documents API: bookings_client_lnk
//     (1 строка, clients без D&P) и bookings_employee_lnk (2 строки — draft+published
//     id персонала, проверено по данным зеркала);
//   - engine_employee_id (documentId персонала) — денормализованная колонка ТОЛЬКО
//     для EXCLUDE-constraint; чтение занятости идёт по link-таблицам/relations.
// Чтения — documents API (объёмы дневные, дешёво).

import crypto from 'crypto';
import {
  CANCEL_MIN_HOURS,
  HOLD_TTL_MIN,
  LOAD_WINDOW_RADIUS_DAYS,
  MIN_LEAD_MIN,
  STEP_MIN,
  buildComboTitle,
  computePricing,
  dayAvailability,
  minToHHMM,
  pragueDateOf,
  pragueMinOf,
  pragueMinToUtcIso,
  selectEmployee,
  utcToPragueMinClamped,
} from './slots-core';

const SALON_SERVICE_UID = 'api::salon-service.salon-service';
const SLOT_HOLD_UID = 'api::slot-hold.slot-hold';
const BOOKING_UID = 'api::booking.booking';
const CLIENT_UID = 'api::client.client';
const PERSONAL_UID = 'api::personal.personal';
const SALON_HOUR_UID = 'api::salon-hour.salon-hour';
const TIME_BLOCK_UID = 'api::time-block.time-block';

const MAX_RANGE_DAYS = 120; // потолок окна availability за один запрос (сайт просит ~3,5 месяца, как в Noona-флоу)
const PG_EXCLUSION_VIOLATION = '23P01';
const OWN_BLOCK_PREFIX = 'own|'; // noonaKey engine-блоков — реконсайл зеркала их не трогает

/** Ошибка с HTTP-статусом — контроллер мапит в ответ. */
export class EngineError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const genDocumentId = (): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (let i = 0; i < 24; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
};

const addDays = (dateStr: string, n: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

const listDates = (fromDate: string, toDate: string): string[] => {
  const out = [];
  let cur = fromDate;
  let guard = 0;
  while (cur <= toDate && guard < MAX_RANGE_DAYS) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
};

const isDateStr = (s): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Телефон → канонический вид: +<код><номер>; 9 цифр без кода → чешский +420
export const normalizePhone = (raw): string => {
  let s = String(raw || '').replace(/[\s\-().]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    const digits = s.replace(/\D/g, '');
    s = digits.length === 9 ? `+420${digits}` : digits ? `+${digits}` : '';
  }
  return s;
};

export default {
  // ── каталог ──

  async resolveService(serviceDocId) {
    if (!serviceDocId) throw new EngineError(400, 'service_required', 'Параметр service обязателен');
    let svc = await strapi.documents(SALON_SERVICE_UID).findOne({
      documentId: serviceDocId,
      populate: { variants: true, modifiers: true },
    });
    if (!svc) {
      // легаси-ссылки (/cenik, старые письма) несут Noona event_type id базовой услуги
      const byNoona = await strapi.documents(SALON_SERVICE_UID).findMany({
        filters: { noonaBaseId: serviceDocId },
        populate: { variants: true, modifiers: true },
        limit: 1,
      });
      svc = byNoona[0] || null;
    }
    if (!svc || svc.active === false) throw new EngineError(404, 'service_not_found', 'Услуга не найдена или выключена');
    return svc;
  },

  // ── публичный каталог (сайт, auth:false + rate-limit) ──

  shapeService(svc) {
    return {
      id: svc.documentId,
      title: svc.title,
      category: svc.category || '',
      durationMin: svc.durationMin,
      price: svc.price,
      description: svc.description || '',
      variants: (svc.variants || []).map((v) => ({
        label: v.label,
        priceDiff: v.priceDiff || 0,
        durationDiff: v.durationDiff || 0,
        description: v.description || '',
      })),
      modifiers: (svc.modifiers || []).map((m) => ({
        key: m.key,
        label: m.label,
        priceDiff: m.priceDiff || 0,
        durationDiff: m.durationDiff || 0,
        group: m.group || '',
        description: m.description || '',
      })),
    };
  },

  async publicCatalog() {
    const list = await strapi.documents(SALON_SERVICE_UID).findMany({
      filters: { active: true, onlineBookable: true },
      sort: ['categoryOrder:asc', 'order:asc', 'title:asc'],
      populate: { variants: true, modifiers: true },
      limit: 500,
    });
    const groups = [];
    const byCat = new Map();
    for (const s of list) {
      const cat = s.category || 'Ostatní';
      if (!byCat.has(cat)) {
        const g = { title: cat, services: [] };
        byCat.set(cat, g);
        groups.push(g);
      }
      byCat.get(cat).services.push(this.shapeService(s));
    }
    return { groups };
  },

  async publicService(serviceDocId) {
    const svc = await this.resolveService(serviceDocId);
    if (svc.onlineBookable === false) {
      throw new EngineError(404, 'service_not_bookable', 'Услуга недоступна для онлайн-записи');
    }
    return this.shapeService(svc);
  },

  async publicServiceEmployees(serviceDocId) {
    const svc = await this.resolveService(serviceDocId);
    const employees = await strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { isActive: true, services: { documentId: { $eq: svc.documentId } } },
      fields: ['name', 'tier'],
      populate: { photo: true },
      limit: 100,
    });
    return {
      serviceId: svc.documentId,
      employees: employees.map((e) => ({
        documentId: e.documentId,
        name: e.name,
        tier: e.tier === 'junior' ? 'junior' : 'senior',
        photoUrl: e.photo?.formats?.thumbnail?.url || e.photo?.url || null,
      })),
    };
  },

  resolveVariantAndModifiers(svc, variantLabel, modifierKeys) {
    let variant = null;
    if (variantLabel) {
      variant = (svc.variants || []).find((v) => v.label === variantLabel) || null;
      if (!variant) throw new EngineError(400, 'variant_not_found', `Вариант «${variantLabel}» не найден`);
    }
    const keys = Array.isArray(modifierKeys) ? modifierKeys.filter(Boolean) : [];
    const byKey = new Map((svc.modifiers || []).map((m) => [m.key, m]));
    const mods = keys.map((k) => {
      const m = byKey.get(k);
      if (!m) throw new EngineError(400, 'modifier_not_found', `Дополнение «${k}» не найдено`);
      return m;
    });
    // взаимоисключающие группы: максимум один модификатор на группу (s55)
    const seenGroups = new Set();
    for (const m of mods) {
      if (!m.group) continue;
      if (seenGroups.has(m.group)) throw new EngineError(400, 'modifier_group_conflict', `Дополнения группы «${m.group}» взаимоисключающие`);
      seenGroups.add(m.group);
    }
    return { variant, modifiers: mods };
  },

  buildServiceSnapshot(svc, variant, modifiers, pricing) {
    const title = buildComboTitle(svc.title, [variant?.label, ...modifiers.map((m) => m.label)].filter(Boolean));
    return [
      {
        title,
        price: pricing.price,
        durationMin: pricing.durationMin,
        serviceDocId: svc.documentId,
        base: svc.title,
        variant: variant?.label || null,
        modifiers: modifiers.map((m) => m.key),
        seniorPrice: pricing.seniorPrice,
      },
    ];
  },

  async listEmployeesForService(serviceDocId) {
    return strapi.documents(PERSONAL_UID).findMany({
      status: 'published',
      filters: { isActive: true, services: { documentId: { $eq: serviceDocId } } },
      fields: ['name', 'tier', 'bookingPriority', 'noonaEmployeeId'],
      limit: 100,
    });
  },

  async getEmployee(employeeDocId) {
    const p = await strapi.documents(PERSONAL_UID).findOne({
      documentId: employeeDocId,
      status: 'published',
      fields: ['name', 'tier', 'bookingPriority', 'noonaEmployeeId', 'isActive'],
    });
    if (!p || p.isActive === false) throw new EngineError(404, 'employee_not_found', 'Мастер не найден или неактивен');
    return p;
  },

  // ── занятость: часы салона, блоки, брони, холды за окно дат ──

  async loadDayContexts(employees, fromDate, toDate) {
    const nowIso = new Date().toISOString();
    const [hours, blocks, bookings, holds] = await Promise.all([
      strapi.documents(SALON_HOUR_UID).findMany({
        filters: { date: { $gte: fromDate, $lte: toDate } },
        limit: 1000,
      }),
      strapi.documents(TIME_BLOCK_UID).findMany({
        filters: { date: { $gte: fromDate, $lte: toDate } },
        populate: { employee: { fields: ['documentId'] } },
        limit: 10000,
      }),
      strapi.documents(BOOKING_UID).findMany({
        filters: { date: { $gte: fromDate, $lte: toDate }, status: 'active' },
        fields: ['date', 'startsAt', 'endsAt', 'noonaEmployeeId', 'engineEmployeeId'],
        populate: { employee: { fields: ['documentId'] } },
        limit: 10000,
      }),
      strapi.documents(SLOT_HOLD_UID).findMany({
        filters: { date: { $gte: fromDate, $lte: toDate }, expiresAt: { $gt: nowIso } },
        fields: ['date', 'startsAt', 'endsAt', 'employeeDocId'],
        limit: 1000,
      }),
    ]);

    const hoursByDate = new Map(hours.map((h) => [String(h.date), h]));
    // ключи матчинга занятости к мастеру: documentId + noonaEmployeeId (зеркальные записи)
    const empKeys = new Map(); // docId → Set(matchKeys)
    for (const e of employees) {
      const keys = new Set([e.documentId]);
      if (e.noonaEmployeeId) keys.add(e.noonaEmployeeId);
      empKeys.set(e.documentId, keys);
    }
    const belongs = (docId, item) => {
      const keys = empKeys.get(docId);
      return (
        (item.employee?.documentId && keys.has(item.employee.documentId)) ||
        (item.noonaEmployeeId && keys.has(item.noonaEmployeeId)) ||
        (item.engineEmployeeId && keys.has(item.engineEmployeeId)) ||
        (item.employeeDocId && keys.has(item.employeeDocId))
      );
    };

    // busy[date][docId] = Interval[]
    const busy = new Map();
    const push = (date, docId, startsAt, endsAt) => {
      if (!startsAt || !endsAt) return;
      const d = String(date);
      if (!busy.has(d)) busy.set(d, new Map());
      const perEmp = busy.get(d);
      if (!perEmp.has(docId)) perEmp.set(docId, []);
      perEmp.get(docId).push({
        startMin: utcToPragueMinClamped(startsAt, d),
        endMin: utcToPragueMinClamped(endsAt, d),
      });
    };
    for (const list of [blocks, bookings, holds]) {
      for (const item of list) {
        for (const e of employees) {
          if (belongs(e.documentId, item)) push(item.date, e.documentId, item.startsAt, item.endsAt);
        }
      }
    }
    return { hoursByDate, busy };
  },

  // ── availability ──

  async getAvailability({ serviceDocId, variantLabel, modifierKeys, employee, fromDate, toDate, publicOnly = true }) {
    if (!isDateStr(fromDate) || !isDateStr(toDate) || toDate < fromDate) {
      throw new EngineError(400, 'bad_range', 'from/to должны быть YYYY-MM-DD, from ≤ to');
    }
    const svc = await this.resolveService(serviceDocId);
    if (publicOnly && svc.onlineBookable === false) throw new EngineError(404, 'service_not_bookable', 'Услуга недоступна для онлайн-записи');
    const { variant, modifiers } = this.resolveVariantAndModifiers(svc, variantLabel, modifierKeys);
    // длительность у senior/junior одинаковая (s95) → одна сетка для всех
    const { durationMin } = computePricing({
      basePrice: svc.price,
      baseDurationMin: svc.durationMin,
      variant,
      modifiers,
      tier: 'senior',
    });
    if (durationMin <= 0) throw new EngineError(400, 'bad_duration', 'Нулевая длительность услуги');

    const assigned = await this.listEmployeesForService(svc.documentId);
    let employees = assigned;
    if (employee && employee !== 'any') {
      employees = assigned.filter((p) => p.documentId === employee);
      if (!employees.length) throw new EngineError(400, 'employee_service_mismatch', 'Мастер не делает эту услугу');
    }
    if (!employees.length) return { durationMin, days: [] };

    const dates = listDates(fromDate, toDate);
    const { hoursByDate, busy } = await this.loadDayContexts(employees, fromDate, toDate);

    const todayPrague = pragueDateOf(new Date());
    const nowMin = pragueMinOf(new Date());

    const days = [];
    for (const date of dates) {
      const h = hoursByDate.get(date);
      const openMin = h?.openMin ?? null;
      const closeMin = h?.closeMin ?? null;
      const minStartMin = date === todayPrague ? nowMin + MIN_LEAD_MIN : 0;
      if (date < todayPrague) continue; // прошлое не отдаём

      const slotEmployees = new Map(); // startMin → [docId]
      for (const e of employees) {
        const starts = dayAvailability({
          openMin,
          closeMin,
          busy: busy.get(date)?.get(e.documentId) || [],
          durationMin,
          stepMin: STEP_MIN,
          minStartMin,
        });
        for (const s of starts) {
          if (!slotEmployees.has(s)) slotEmployees.set(s, []);
          slotEmployees.get(s).push(e.documentId);
        }
      }
      const slots = [...slotEmployees.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([startMin, emps]) => ({ startMin, time: minToHHMM(startMin), employees: emps }));
      if (slots.length) days.push({ date, slots });
    }
    return { durationMin, days };
  },

  // ── балансировка «any»: загрузка мастеров в окне ±3 дня ──

  async employeeLoadWindow(employees, centerDate) {
    const fromDate = addDays(centerDate, -LOAD_WINDOW_RADIUS_DAYS);
    const toDate = addDays(centerDate, LOAD_WINDOW_RADIUS_DAYS);
    const bookings = await strapi.documents(BOOKING_UID).findMany({
      filters: { date: { $gte: fromDate, $lte: toDate }, status: 'active' },
      fields: ['noonaEmployeeId', 'engineEmployeeId'],
      populate: { employee: { fields: ['documentId'] } },
      limit: 10000,
    });
    const load = new Map(employees.map((e) => [e.documentId, 0]));
    for (const b of bookings) {
      for (const e of employees) {
        if (
          b.employee?.documentId === e.documentId ||
          (b.noonaEmployeeId && b.noonaEmployeeId === e.noonaEmployeeId) ||
          b.engineEmployeeId === e.documentId
        ) {
          load.set(e.documentId, (load.get(e.documentId) || 0) + 1);
          break;
        }
      }
    }
    return load;
  },

  // ── holds ──

  async createHold({ serviceDocId, variantLabel, modifierKeys, employee, date, time, sessionKey }) {
    if (!isDateStr(date)) throw new EngineError(400, 'bad_date', 'date должен быть YYYY-MM-DD');
    if (!/^\d{2}:\d{2}$/.test(String(time || ''))) throw new EngineError(400, 'bad_time', 'time должен быть HH:MM');
    const startMin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

    const availability = await this.getAvailability({
      serviceDocId,
      variantLabel,
      modifierKeys,
      employee,
      fromDate: date,
      toDate: date,
    });
    const slot = availability.days[0]?.slots.find((s) => s.startMin === startMin);
    if (!slot) throw new EngineError(409, 'slot_taken', 'Слот уже занят или недоступен');

    // кандидаты: конкретный мастер или балансировка среди свободных (порт selectMaster s75)
    let chosenDocId;
    const svc = await this.resolveService(serviceDocId);
    const allEmployees = await this.listEmployeesForService(svc.documentId);
    if (employee && employee !== 'any') {
      chosenDocId = employee;
    } else {
      const free = allEmployees.filter((e) => slot.employees.includes(e.documentId));
      const load = await this.employeeLoadWindow(free, date);
      chosenDocId = selectEmployee(
        free.map((e) => ({ id: e.documentId, load: load.get(e.documentId) || 0, boost: e.bookingPriority || 0 }))
      );
    }
    const chosen = allEmployees.find((e) => e.documentId === chosenDocId);
    if (!chosen) throw new EngineError(409, 'slot_taken', 'Мастер недоступен');

    const { variant, modifiers } = this.resolveVariantAndModifiers(svc, variantLabel, modifierKeys);
    const pricing = computePricing({
      basePrice: svc.price,
      baseDurationMin: svc.durationMin,
      variant,
      modifiers,
      tier: chosen.tier === 'junior' ? 'junior' : 'senior',
    });
    const snapshot = this.buildServiceSnapshot(svc, variant, modifiers, pricing);

    const startsAt = pragueMinToUtcIso(date, startMin);
    const endsAt = pragueMinToUtcIso(date, startMin + pricing.durationMin);
    const expiresAt = new Date(Date.now() + HOLD_TTL_MIN * 60000);
    const documentId = genDocumentId();
    const now = new Date();

    const knex = strapi.db.connection;
    try {
      await knex.transaction(async (trx) => {
        // протухшие холды освобождают слоты сразу (EXCLUDE на slot_holds без WHERE)
        await trx('slot_holds').where('expires_at', '<', now).del();
        await trx('slot_holds').insert({
          document_id: documentId,
          employee_doc_id: chosen.documentId,
          employee_name: chosen.name,
          date,
          starts_at: new Date(startsAt),
          ends_at: new Date(endsAt),
          services: JSON.stringify(snapshot),
          total_price: pricing.price,
          duration_min: pricing.durationMin,
          expires_at: expiresAt,
          session_key: sessionKey || null,
          created_at: now,
          updated_at: now,
          published_at: now,
        });
      });
    } catch (e) {
      if (e?.code === PG_EXCLUSION_VIOLATION) throw new EngineError(409, 'slot_taken', 'Слот только что заняли');
      throw e;
    }

    return {
      holdId: documentId,
      expiresAt: expiresAt.toISOString(),
      date,
      time: minToHHMM(startMin),
      startsAt,
      endsAt,
      durationMin: pricing.durationMin,
      price: pricing.price,
      seniorPrice: pricing.seniorPrice,
      employee: { documentId: chosen.documentId, name: chosen.name, tier: chosen.tier || 'senior' },
      services: snapshot,
    };
  },

  async getHold(holdId) {
    const hold = await strapi.documents(SLOT_HOLD_UID).findOne({ documentId: holdId });
    if (!hold) throw new EngineError(404, 'hold_not_found', 'Резервация не найдена');
    const expired = new Date(hold.expiresAt).getTime() < Date.now();
    return {
      holdId: hold.documentId,
      expired,
      expiresAt: hold.expiresAt,
      date: hold.date,
      time: hold.startsAt ? minToHHMM(utcToPragueMinClamped(hold.startsAt, String(hold.date))) : null,
      startsAt: hold.startsAt,
      endsAt: hold.endsAt,
      durationMin: hold.durationMin,
      price: Number(hold.totalPrice),
      employee: { documentId: hold.employeeDocId, name: hold.employeeName },
      services: hold.services,
    };
  },

  // ── клиенты ──

  async findOrCreateClient({ name, phone, email }) {
    const normPhone = normalizePhone(phone);
    if (!normPhone) throw new EngineError(400, 'phone_required', 'Телефон обязателен');
    const found = await strapi.documents(CLIENT_UID).findMany({
      filters: { phone: normPhone },
      limit: 1,
    });
    if (found.length) {
      const c = found[0];
      // дообогащаем пустые поля (email появился и т.п.), имя не перетираем
      const patch = {};
      if (email && !c.email) patch.email = String(email).trim();
      if (Object.keys(patch).length) {
        await strapi.documents(CLIENT_UID).update({ documentId: c.documentId, data: patch });
      }
      return { ...c, ...patch };
    }
    return strapi.documents(CLIENT_UID).create({
      data: {
        name: String(name || '').trim() || 'Bez jména',
        phone: normPhone,
        email: String(email || '').trim(),
        source: 'site',
      },
    });
  },

  // ── raw-вставка брони (общая для site/admin) ──

  async personalRows(employeeDocId) {
    const knex = strapi.db.connection;
    const rows = await knex('personals')
      .select('id', 'name', 'noona_employee_id', 'published_at')
      .where('document_id', employeeDocId);
    if (!rows.length) throw new EngineError(404, 'employee_not_found', 'Мастер не найден');
    return rows;
  },

  async insertBookingRaw(trx, { documentId, clientRow, personalRowList, data }) {
    const now = new Date();
    const pub = personalRowList.find((r) => r.published_at) || personalRowList[0];
    const [inserted] = await trx('bookings')
      .insert({
        document_id: documentId,
        client_name_raw: data.clientName || '',
        employee_name_raw: pub.name || '',
        noona_employee_id: pub.noona_employee_id || '',
        date: data.date,
        starts_at: new Date(data.startsAt),
        ends_at: new Date(data.endsAt),
        status: data.status || 'active',
        noona_status: '',
        services: JSON.stringify(data.services || []),
        total_price: data.totalPrice ?? null,
        comment: data.comment || '',
        customer_comment: data.customerComment || '',
        origin: data.origin,
        bs_channel: '',
        bs_group: '',
        cancel_token: data.cancelToken,
        engine_employee_id: data.employeeDocId,
        created_by_name: data.createdByName || '',
        price_override: Boolean(data.priceOverride),
        created_at: now,
        updated_at: now,
        published_at: now,
      })
      .returning('id');
    const bookingId = inserted.id ?? inserted;

    if (clientRow) {
      const [{ maxOrd }] = await trx('bookings_client_lnk')
        .where('client_id', clientRow.id)
        .max('booking_ord as maxOrd');
      await trx('bookings_client_lnk').insert({
        booking_id: bookingId,
        client_id: clientRow.id,
        booking_ord: Number(maxOrd || 0) + 1,
      });
    }
    // documents API линкует бронь к ОБЕИМ версиям personal (draft+published) — повторяем
    for (const p of personalRowList) {
      await trx('bookings_employee_lnk').insert({ booking_id: bookingId, personal_id: p.id });
    }
    return bookingId;
  },

  // ── бронь с сайта: hold → booking ──

  async createBooking({ holdId, name, phone, email, customerComment }) {
    const hold = await strapi.documents(SLOT_HOLD_UID).findOne({ documentId: holdId });
    if (!hold) throw new EngineError(404, 'hold_not_found', 'Резервация не найдена');
    if (new Date(hold.expiresAt).getTime() < Date.now()) {
      throw new EngineError(410, 'hold_expired', 'Rezervace vypršela');
    }

    const client = await this.findOrCreateClient({ name, phone, email });
    // серверный блэклист — дыра s94 закрывается по построению
    if (client.blacklisted) throw new EngineError(403, 'blacklisted', 'Rezervaci nelze vytvořit');

    const knex = strapi.db.connection;
    const clientRow = (await knex('clients').select('id').where('document_id', client.documentId))[0];
    const personalRowList = await this.personalRows(hold.employeeDocId);

    const documentId = genDocumentId();
    const cancelToken = crypto.randomUUID();
    try {
      await knex.transaction(async (trx) => {
        await this.insertBookingRaw(trx, {
          documentId,
          clientRow,
          personalRowList,
          data: {
            clientName: client.name,
            date: String(hold.date),
            startsAt: hold.startsAt,
            endsAt: hold.endsAt,
            services: hold.services,
            totalPrice: Number(hold.totalPrice),
            customerComment,
            origin: 'site',
            cancelToken,
            employeeDocId: hold.employeeDocId,
          },
        });
        await trx('slot_holds').where('document_id', hold.documentId).del();
      });
    } catch (e) {
      if (e?.code === PG_EXCLUSION_VIOLATION) throw new EngineError(409, 'slot_taken', 'Слот только что заняли');
      throw e;
    }

    // нотификации fire-and-forget: подтверждение клиенту + Telegram салону;
    // сбой письма НЕ роняет уже созданную бронь
    strapi
      .service('api::booking-engine.booking-notify')
      .notifyBookingCreated(documentId)
      .catch((e) => strapi.log.error(`booking-notify created failed: ${e.message}`));

    return {
      bookingId: documentId,
      cancelToken,
      date: hold.date,
      time: hold.startsAt ? minToHHMM(utcToPragueMinClamped(hold.startsAt, String(hold.date))) : null,
      startsAt: hold.startsAt,
      endsAt: hold.endsAt,
      totalPrice: Number(hold.totalPrice),
      employee: { documentId: hold.employeeDocId, name: hold.employeeName },
      services: hold.services,
      client: { documentId: client.documentId, name: client.name },
    };
  },

  // ── админ: прямая бронь (без hold) ──

  async adminCreateBooking({ session, employee, date, time, serviceItems, client, clientDocId, priceOverride, comment, notify = false, sendMinLead = false }) {
    if (!isDateStr(date)) throw new EngineError(400, 'bad_date', 'date должен быть YYYY-MM-DD');
    if (!/^\d{2}:\d{2}$/.test(String(time || ''))) throw new EngineError(400, 'bad_time', 'time должен быть HH:MM');
    if (!Array.isArray(serviceItems) || !serviceItems.length) {
      throw new EngineError(400, 'services_required', 'Нужна минимум одна услуга');
    }
    const emp = await this.getEmployee(employee);

    // снапшоты и суммы по всем услугам брони
    const snapshot = [];
    let totalPrice = 0;
    let totalDuration = 0;
    for (const item of serviceItems) {
      const svc = await this.resolveService(item.service);
      const { variant, modifiers } = this.resolveVariantAndModifiers(svc, item.variant, item.modifiers);
      const pricing = computePricing({
        basePrice: svc.price,
        baseDurationMin: svc.durationMin,
        variant,
        modifiers,
        tier: emp.tier === 'junior' ? 'junior' : 'senior',
      });
      const price = item.priceOverride != null ? Number(item.priceOverride) : pricing.price;
      snapshot.push({ ...this.buildServiceSnapshot(svc, variant, modifiers, pricing)[0], price });
      totalPrice += price;
      totalDuration += pricing.durationMin;
    }
    if (priceOverride != null) totalPrice = Number(priceOverride);
    if (totalDuration <= 0) throw new EngineError(400, 'bad_duration', 'Нулевая длительность');

    const startMin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const startsAt = pragueMinToUtcIso(date, startMin);
    const endsAt = pragueMinToUtcIso(date, startMin + totalDuration);

    // проверка занятости мастера (часы салона админа не ограничивают, пересечения — да)
    const { busy } = await this.loadDayContexts([emp], date, date);
    const busyList = busy.get(date)?.get(emp.documentId) || [];
    const overlap = busyList.some((b) => b.startMin < startMin + totalDuration && startMin < b.endMin);
    if (overlap) throw new EngineError(409, 'slot_taken', 'Мастер занят в это время');

    const clientDoc = clientDocId
      ? await strapi.documents(CLIENT_UID).findOne({ documentId: clientDocId })
      : await this.findOrCreateClient(client || {});
    if (!clientDoc) throw new EngineError(404, 'client_not_found', 'Клиент не найден');

    const knex = strapi.db.connection;
    const clientRow = (await knex('clients').select('id').where('document_id', clientDoc.documentId))[0];
    const personalRowList = await this.personalRows(emp.documentId);
    const documentId = genDocumentId();
    const cancelToken = crypto.randomUUID();

    try {
      await knex.transaction(async (trx) => {
        await this.insertBookingRaw(trx, {
          documentId,
          clientRow,
          personalRowList,
          data: {
            clientName: clientDoc.name,
            date,
            startsAt,
            endsAt,
            services: snapshot,
            totalPrice,
            comment,
            origin: 'admin',
            cancelToken,
            employeeDocId: emp.documentId,
            createdByName: session?.username || '',
            priceOverride: priceOverride != null || serviceItems.some((i) => i.priceOverride != null),
          },
        });
      });
    } catch (e) {
      if (e?.code === PG_EXCLUSION_VIOLATION) throw new EngineError(409, 'slot_taken', 'Мастер занят в это время');
      throw e;
    }

    // чекбокс «отправить подтверждение» (роадмап §4.3): только письмо клиенту,
    // fire-and-forget — сбой письма не роняет уже созданную бронь
    if (notify) {
      strapi
        .service('api::booking-engine.booking-notify')
        .notifyBookingCreatedByAdmin(documentId)
        .catch((e) => strapi.log.error(`booking-notify admin-created failed: ${e.message}`));
    }

    return { bookingId: documentId, date, time, startsAt, endsAt, totalPrice, services: snapshot, employee: { documentId: emp.documentId, name: emp.name }, client: { documentId: clientDoc.documentId, name: clientDoc.name } };
  },

  // ── админ: изменение брони (перенос / статус / коммент / цена) ──

  async adminPatchBooking(bookingDocId, patch, session) {
    const booking = await strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      populate: { employee: { fields: ['documentId', 'name'] } },
    });
    if (!booking) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');

    // снимок старого термина (для письма о переносе «Původní termín: …»)
    const fromInfo = {
      startsAt: booking.startsAt,
      date: String(booking.date),
      time: booking.startsAt ? minToHHMM(utcToPragueMinClamped(booking.startsAt, String(booking.date))) : '',
      employeeName: booking.employee?.name || booking.employeeNameRaw || '',
    };

    const knex = strapi.db.connection;
    const upd = { updated_at: new Date() };

    if (patch.status) {
      if (!['active', 'checkedOut', 'cancelled', 'noshow'].includes(patch.status)) {
        throw new EngineError(400, 'bad_status', 'Недопустимый статус');
      }
      upd.status = patch.status;
    }
    if (patch.comment != null) upd.comment = String(patch.comment);
    if (patch.totalPrice != null) {
      upd.total_price = Number(patch.totalPrice);
      upd.price_override = true;
    }
    // кастомный лейбл (снапшот {name, color}); label: null → снять
    if ('label' in patch) {
      if (patch.label == null) {
        upd.label = null;
      } else if (patch.label.name && patch.label.color) {
        upd.label = JSON.stringify({ name: String(patch.label.name), color: String(patch.label.color) });
      } else {
        throw new EngineError(400, 'bad_label', 'label должен быть {name, color} или null');
      }
    }

    // смена услуги (админ-календарь): новый снапшот services + пересчёт цены и
    // длительности (endsAt пересчитается в блоке переноса ниже, с валидацией пересечений)
    let newDuration = null;
    if (patch.serviceItems != null) {
      if (!Array.isArray(patch.serviceItems) || !patch.serviceItems.length) {
        throw new EngineError(400, 'services_required', 'Нужна минимум одна услуга');
      }
      const empDocIdForPricing = patch.employee || booking.employee?.documentId || booking.engineEmployeeId;
      if (!empDocIdForPricing) throw new EngineError(400, 'employee_required', 'У брони нет мастера');
      const empForPricing = await this.getEmployee(empDocIdForPricing);
      const snapshot = [];
      let computedPrice = 0;
      let totalDuration = 0;
      for (const item of patch.serviceItems) {
        const svc = await this.resolveService(item.service);
        const { variant, modifiers } = this.resolveVariantAndModifiers(svc, item.variant, item.modifiers);
        const pricing = computePricing({
          basePrice: svc.price,
          baseDurationMin: svc.durationMin,
          variant,
          modifiers,
          tier: empForPricing.tier === 'junior' ? 'junior' : 'senior',
        });
        const price = item.priceOverride != null ? Number(item.priceOverride) : pricing.price;
        snapshot.push({ ...this.buildServiceSnapshot(svc, variant, modifiers, pricing)[0], price });
        computedPrice += price;
        totalDuration += pricing.durationMin;
      }
      if (totalDuration <= 0) throw new EngineError(400, 'bad_duration', 'Нулевая длительность');
      upd.services = JSON.stringify(snapshot);
      // явный patch.totalPrice (обработан выше) побеждает пересчитанную цену
      if (patch.totalPrice == null) {
        upd.total_price = computedPrice;
        upd.price_override = patch.serviceItems.some((i) => i.priceOverride != null);
      }
      newDuration = totalDuration;
    }

    // перенос: новые дата/время/мастер и/или новая длительность (смена услуги)
    let newPersonalRows = null;
    const moving = patch.date != null || patch.time != null || patch.employee != null || newDuration != null;
    if (moving) {
      const date = patch.date ?? String(booking.date);
      if (!isDateStr(date)) throw new EngineError(400, 'bad_date', 'date должен быть YYYY-MM-DD');
      const curStartMin = booking.startsAt ? utcToPragueMinClamped(booking.startsAt, date) : 0;
      const startMin = patch.time != null ? Number(patch.time.slice(0, 2)) * 60 + Number(patch.time.slice(3, 5)) : curStartMin;
      const durationMin =
        newDuration ??
        (booking.startsAt && booking.endsAt
          ? Math.round((new Date(booking.endsAt) - new Date(booking.startsAt)) / 60000)
          : 0);
      if (durationMin <= 0) throw new EngineError(400, 'bad_duration', 'У брони нет длительности');

      const empDocId = patch.employee || booking.employee?.documentId || booking.engineEmployeeId;
      if (!empDocId) throw new EngineError(400, 'employee_required', 'У брони нет мастера — укажите employee');
      const emp = await this.getEmployee(empDocId);

      const { busy } = await this.loadDayContexts([emp], date, date);
      const busyList = (busy.get(date)?.get(emp.documentId) || []).filter(
        // свою бронь из занятости исключаем (перенос в пределах своего слота)
        (b) => !(booking.startsAt && b.startMin === utcToPragueMinClamped(booking.startsAt, date) && b.endMin === utcToPragueMinClamped(booking.endsAt, date))
      );
      const overlap = busyList.some((b) => b.startMin < startMin + durationMin && startMin < b.endMin);
      if (overlap) throw new EngineError(409, 'slot_taken', 'Мастер занят в это время');

      upd.date = date;
      upd.starts_at = new Date(pragueMinToUtcIso(date, startMin));
      upd.ends_at = new Date(pragueMinToUtcIso(date, startMin + durationMin));
      if (patch.employee) {
        newPersonalRows = await this.personalRows(emp.documentId);
        const pub = newPersonalRows.find((r) => r.published_at) || newPersonalRows[0];
        upd.engine_employee_id = emp.documentId;
        upd.noona_employee_id = pub.noona_employee_id || '';
        upd.employee_name_raw = pub.name || '';
      }
    }

    const bookingRow = (await knex('bookings').select('id').where('document_id', bookingDocId))[0];
    try {
      await knex.transaction(async (trx) => {
        await trx('bookings').where('id', bookingRow.id).update(upd);
        if (newPersonalRows) {
          await trx('bookings_employee_lnk').where('booking_id', bookingRow.id).del();
          for (const p of newPersonalRows) {
            await trx('bookings_employee_lnk').insert({ booking_id: bookingRow.id, personal_id: p.id });
          }
        }
      });
    } catch (e) {
      if (e?.code === PG_EXCLUSION_VIOLATION) throw new EngineError(409, 'slot_taken', 'Мастер занят в это время');
      throw e;
    }
    strapi.log.info(`booking-engine: admin ${session?.username || '?'} patched booking ${bookingDocId} ${JSON.stringify(Object.keys(patch))}`);

    // чекбокс «уведомить клиента» при отмене админом (роадмап §4.2):
    // только письмо клиенту, fire-and-forget — отмена уже применена
    if (patch.notify && patch.status === 'cancelled') {
      strapi
        .service('api::booking-engine.booking-notify')
        .notifyBookingCancelledByAdmin(bookingDocId)
        .catch((e) => strapi.log.error(`booking-notify admin-cancelled failed: ${e.message}`));
    }

    // чекбокс «уведомить клиента» при переносе админом: письмо с новыми деталями + ICS
    if (moving && patch.notifyClient) {
      strapi
        .service('api::booking-engine.booking-notify')
        .notifyBookingRescheduledByAdmin(bookingDocId, fromInfo)
        .catch((e) => strapi.log.error(`booking-notify admin-rescheduled failed: ${e.message}`));
    }

    return strapi.documents(BOOKING_UID).findOne({ documentId: bookingDocId, populate: { employee: { fields: ['name'] }, client: { fields: ['name', 'phone'] } } });
  },

  // Полное удаление брони (корзина в drawer). ЖЁСТКОЕ удаление записи, НЕ отмена:
  // бронь исчезает из БД (link-строки чистит FK cascade). Зеркальные (Noona) брони
  // при включённом синке удалять нельзя — реконсайл их воскресит.
  async adminDeleteBooking(bookingDocId, session) {
    const booking = await strapi.documents(BOOKING_UID).findOne({ documentId: bookingDocId });
    if (!booking) throw new EngineError(404, 'booking_not_found', 'Бронь не найдена');
    if (booking.noonaEventId && String(process.env.MIRROR_SYNC_ENABLED || '').toLowerCase() === 'true') {
      throw new EngineError(409, 'mirror_booking', 'Бронь из зеркала Noona — синк её восстановит, удалять в Noona');
    }
    await strapi.documents(BOOKING_UID).delete({ documentId: bookingDocId });
    strapi.log.info(
      `booking-engine: admin ${session?.username || '?'} DELETED booking ${bookingDocId} (${booking.clientNameRaw || ''} ${booking.date})`
    );
    return { deleted: 1 };
  },

  // ── админ: блоки времени ──

  // Разворачивает серию блоков в список дат (YYYY-MM-DD).
  // recurrence: {freq:'daily'|'weekly', until:'YYYY-MM-DD', weekdays?:number[]} (weekday 0=Ne..6=So, как getUTCDay).
  // Без recurrence → одна дата. Кап — 1 год от старта.
  _expandBlockDates(startDate, rec) {
    if (!rec || (rec.freq !== 'daily' && rec.freq !== 'weekly')) return [startDate];
    const until = isDateStr(rec.until) ? rec.until : startDate;
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${until}T00:00:00Z`);
    if (end < start) return [startDate];
    const MAX_MS = 366 * 24 * 3600 * 1000;
    const cappedEnd = end.getTime() - start.getTime() > MAX_MS ? new Date(start.getTime() + MAX_MS) : end;
    const weekdays =
      Array.isArray(rec.weekdays) && rec.weekdays.length
        ? rec.weekdays.map(Number).filter((n) => n >= 0 && n <= 6)
        : [start.getUTCDay()];
    const out = [];
    for (let t = new Date(start); t <= cappedEnd; t.setUTCDate(t.getUTCDate() + 1)) {
      if (rec.freq === 'daily' || weekdays.includes(t.getUTCDay())) out.push(t.toISOString().slice(0, 10));
    }
    return out.length ? out : [startDate];
  },

  async adminCreateBlock({ session, employee, date, startMin, endMin, title, recurrence }) {
    if (!isDateStr(date)) throw new EngineError(400, 'bad_date', 'date должен быть YYYY-MM-DD');
    if (!(Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin)) {
      throw new EngineError(400, 'bad_interval', 'startMin/endMin некорректны');
    }
    const emp = await this.getEmployee(employee);
    // общий ключ на всю серию (уникальный uuid) — каждый день = отдельная строка, но одна группа
    const key = `${OWN_BLOCK_PREFIX}${crypto.randomUUID()}`;
    const titleStr = String(title || '').trim() || 'Blokace';
    const dates = this._expandBlockDates(date, recurrence);

    const created = [];
    for (const d of dates) {
      created.push(
        await strapi.documents(TIME_BLOCK_UID).create({
          data: {
            noonaKey: key,
            noonaBlockedId: '',
            noonaEmployeeId: emp.noonaEmployeeId || '',
            employee: emp.documentId,
            employeeNameRaw: emp.name,
            date: d,
            startsAt: pragueMinToUtcIso(d, startMin),
            endsAt: pragueMinToUtcIso(d, endMin),
            title: titleStr,
            theme: '',
          },
        })
      );
    }
    strapi.log.info(
      `booking-engine: admin ${session?.username || '?'} created ${created.length} block(s) ${key} (${date}${
        dates.length > 1 ? `..${dates[dates.length - 1]}` : ''
      } ${minToHHMM(startMin)}–${minToHHMM(endMin)} ${emp.name})`
    );
    return { documentId: created[0]?.documentId, count: created.length };
  },

  // Зеркальные (Noona) блоки можно трогать ТОЛЬКО при выключенном синке —
  // иначе реконсайл их воскресит. Own-блоки управляемы всегда.
  _assertBlockManageable(block) {
    if (String(block.noonaKey || '').startsWith(OWN_BLOCK_PREFIX)) return;
    if (String(process.env.MIRROR_SYNC_ENABLED || '').toLowerCase() === 'true') {
      throw new EngineError(409, 'mirror_block', 'Блок из зеркала Noona — управляется синком, менять в Noona');
    }
  },

  // PATCH блока: время (в рамках его дня) и/или название. Только этот конкретный блок.
  async adminPatchBlock(blockDocId, { startMin, endMin, title }, session) {
    const block = await strapi.documents(TIME_BLOCK_UID).findOne({ documentId: blockDocId });
    if (!block) throw new EngineError(404, 'block_not_found', 'Блок не найден');
    this._assertBlockManageable(block);
    const data = {};
    if (startMin != null || endMin != null) {
      const s = Number(startMin);
      const e = Number(endMin);
      if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) {
        throw new EngineError(400, 'bad_interval', 'startMin/endMin некорректны');
      }
      data.startsAt = pragueMinToUtcIso(String(block.date), s);
      data.endsAt = pragueMinToUtcIso(String(block.date), e);
    }
    if (title != null) data.title = String(title).trim() || 'Blokace';
    if (!Object.keys(data).length) return block;
    const updated = await strapi.documents(TIME_BLOCK_UID).update({ documentId: blockDocId, data });
    strapi.log.info(`booking-engine: admin ${session?.username || '?'} patched block ${block.noonaKey} (${block.date})`);
    return updated;
  },

  // series=true → удалить все повторения: own-серия делит noonaKey,
  // зеркальная rrule-серия делит noonaBlockedId (noonaKey у них per-date `id|date`).
  async adminDeleteBlock(blockDocId, { series = false } = {}) {
    const block = await strapi.documents(TIME_BLOCK_UID).findOne({ documentId: blockDocId });
    if (!block) throw new EngineError(404, 'block_not_found', 'Блок не найден');
    this._assertBlockManageable(block);

    if (!series) {
      await strapi.documents(TIME_BLOCK_UID).delete({ documentId: blockDocId });
      return { deleted: 1 };
    }
    const isOwn = String(block.noonaKey || '').startsWith(OWN_BLOCK_PREFIX);
    const filters = isOwn ? { noonaKey: block.noonaKey } : { noonaBlockedId: block.noonaBlockedId || '__none__' };
    const all = await strapi.documents(TIME_BLOCK_UID).findMany({ filters, limit: 1000 });
    for (const b of all) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
    strapi.log.info(`booking-engine: deleted block series ${block.noonaKey} (${all.length} rows)`);
    return { deleted: all.length };
  },

  // ── отмена клиентом по токену ──

  async bookingByCancelToken(token) {
    const found = await strapi.documents(BOOKING_UID).findMany({
      filters: { cancelToken: token },
      populate: { employee: { fields: ['name'] } },
      limit: 1,
    });
    if (!found.length) throw new EngineError(404, 'booking_not_found', 'Rezervace nenalezena');
    return found[0];
  },

  cancelInfo(booking) {
    const startsMs = booking.startsAt ? new Date(booking.startsAt).getTime() : 0;
    const cancellable = booking.status === 'active' && startsMs - Date.now() > CANCEL_MIN_HOURS * 3600000;
    return {
      date: booking.date,
      time: booking.startsAt ? minToHHMM(utcToPragueMinClamped(booking.startsAt, String(booking.date))) : null,
      startsAt: booking.startsAt,
      status: booking.status,
      employeeName: booking.employee?.name || booking.employeeNameRaw || '',
      services: booking.services,
      totalPrice: booking.totalPrice != null ? Number(booking.totalPrice) : null,
      cancellable,
      cancelMinHours: CANCEL_MIN_HOURS,
    };
  },

  async getCancel(token) {
    const booking = await this.bookingByCancelToken(token);
    return this.cancelInfo(booking);
  },

  async postCancel(token) {
    const booking = await this.bookingByCancelToken(token);
    const info = this.cancelInfo(booking);
    if (booking.status !== 'active') throw new EngineError(409, 'not_active', 'Rezervace už není aktivní');
    if (!info.cancellable) {
      throw new EngineError(409, 'too_late', `Rezervaci lze zrušit nejpozději ${CANCEL_MIN_HOURS} h předem`);
    }
    await strapi.documents(BOOKING_UID).update({ documentId: booking.documentId, data: { status: 'cancelled' } });

    // письмо клиенту + Telegram салону (fire-and-forget — отмена уже применена)
    strapi
      .service('api::booking-engine.booking-notify')
      .notifyBookingCancelled(booking.documentId)
      .catch((e) => strapi.log.error(`booking-notify cancelled failed: ${e.message}`));

    return { cancelled: true, ...info, status: 'cancelled' };
  },

  // ── крон: чистка протухших холдов ──

  async cleanupHolds() {
    const knex = strapi.db.connection;
    try {
      const n = await knex('slot_holds').where('expires_at', '<', new Date()).del();
      if (n > 0) strapi.log.info(`booking-engine: cleaned ${n} expired holds`);
      return n;
    } catch (e) {
      // до первого schema-sync таблицы может не быть — не шумим
      return 0;
    }
  },
};
