// @ts-nocheck
// Синк-зеркало Noona → локальные коллекции client/booking (фаза 1 own-booking).
// Noona остаётся мастером; здесь ТОЛЬКО read-only GET к Noona + upsert в свою БД.
// Env: NOONA_TOKEN + NOONA_COMPANY_ID (те же, что у digest). Без них — тихий skip.
//
// Маппинг события (полный объект events, без select):
//   noonaEventId=id, clientNameRaw=customer_name (снимок на момент брони, s97),
//   status = нормализация (cancelled/noshow/checkedOut → как есть, остальное → active),
//   noonaStatus = сырой статус (lossless: '', 'showedUp', 'old-price' и т.п.),
//   bsChannel/bsGroup = booking_source.{channel,group} (top-level channel/source в
//   событиях всегда null — замер s98), origin = сырой origin.
// Клиент матчится по noonaCustomerId, мастер — по personal.noonaEmployeeId.

const NOONA_BASE = 'https://api.noona.is/v1/hq/companies';

const CLIENT_UID = 'api::client.client';
const BOOKING_UID = 'api::booking.booking';
const PERSONAL_UID = 'api::personal.personal';
const SALON_HOUR_UID = 'api::salon-hour.salon-hour';
const TIME_BLOCK_UID = 'api::time-block.time-block';

// 'YYYY-MM-DD' в Праге со смещением дней (сервер в UTC)
const pragueDate = (offsetDays = 0): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
    new Date(Date.now() + offsetDays * 86400000)
  );
const hhmmToMin = (s: string): number => {
  const [h, m] = (s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const normalizeStatus = (raw: string | undefined): string => {
  if (raw === 'cancelled' || raw === 'noshow' || raw === 'checkedOut') return raw;
  return 'active';
};

// Телефон в едином виде: +<код><номер>; без кода — как есть
const buildPhone = (c): string => {
  const num = String(c.phone_number || '').replace(/\s+/g, '');
  if (!num) return '';
  const code = String(c.phone_country_code || '').replace(/\D/g, '');
  return code ? `+${code}${num}` : num;
};

const mapCustomer = (c, blacklistGroupId: string | null) => ({
  name: (c.name || '').trim() || 'Bez jména',
  phone: buildPhone(c),
  email: (c.email || '').trim(),
  noonaCustomerId: c.id,
  blacklisted: Boolean(blacklistGroupId && (c.groups || []).includes(blacklistGroupId)),
  notes: c.notes || '',
  tags: c.groups && c.groups.length ? { noonaGroups: c.groups } : null,
  source: 'import',
});

const mapEvent = (e) => ({
  noonaEventId: e.id,
  clientNameRaw: e.customer_name || '',
  employeeNameRaw: e.employee_name || '',
  noonaEmployeeId: e.employee || '',
  date: e.event_date || (e.starts_at ? String(e.starts_at).slice(0, 10) : null),
  startsAt: e.starts_at || null,
  endsAt: e.ends_at || null,
  status: normalizeStatus(e.status),
  noonaStatus: e.status ?? '',
  services: (e.event_types || []).map((t) => ({
    title: t.title || '',
    price: t.price?.amount ?? null,
    durationMin: t.duration ?? t.minutes ?? null,
  })),
  totalPrice: e.price?.amount ?? null,
  comment: e.comment || '',
  customerComment: e.customer_comment || '',
  origin: e.origin || '',
  bsChannel: e.booking_source?.channel || '',
  bsGroup: e.booking_source?.group || '',
  noonaCreatedAt: e.created_at || null,
});

// jsonb в Postgres пересортировывает ключи объектов → сравнивать json-поля
// можно только канонично (сортировка ключей рекурсивно)
const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
      : v;
const stableStringify = (v) => JSON.stringify(sortKeys(v ?? null));

const clientChanged = (existing, mapped): boolean =>
  existing.name !== mapped.name ||
  (existing.phone ?? '') !== mapped.phone ||
  (existing.email ?? '') !== mapped.email ||
  Boolean(existing.blacklisted) !== mapped.blacklisted ||
  (existing.notes ?? '') !== mapped.notes ||
  stableStringify(existing.tags) !== stableStringify(mapped.tags);

export default {
  hasEnv(): boolean {
    return Boolean(process.env.NOONA_TOKEN && process.env.NOONA_COMPANY_ID);
  },

  async noonaGet(path: string) {
    const token = process.env.NOONA_TOKEN;
    const cid = process.env.NOONA_COMPANY_ID;
    const res = await fetch(`${NOONA_BASE}/${cid}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Noona ${path} → ${res.status}`);
    return res.json();
  },

  async fetchNoonaEvents(fromIso: string, toIso: string) {
    const params = new URLSearchParams();
    params.append('filter', JSON.stringify({ from: fromIso, to: toIso }));
    return this.noonaGet(`events?${params.toString()}`);
  },

  // blocked_times ограничен ≤31 днём на запрос (span 45 → 400) → чанкуем по 30д.
  // `to` у эндпоинта ИСКЛЮЧАЮЩИЙ → передаём границу+1 день.
  async fetchBlockedRange(fromDate: string, toDate: string) {
    const addDays = (d: string, n: number): string => {
      const [y, m, dd] = d.split('-').map(Number);
      const x = new Date(Date.UTC(y, m - 1, dd + n));
      return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
    };
    const out = [];
    let cursor = fromDate;
    let guard = 0;
    while (cursor <= toDate && guard < 40) {
      guard += 1;
      let chunkEnd = addDays(cursor, 29);
      if (chunkEnd > toDate) chunkEnd = toDate;
      const toExcl = addDays(chunkEnd, 1);
      const part = await this.noonaGet(`blocked_times?from=${cursor}&to=${toExcl}`);
      if (Array.isArray(part)) out.push(...part);
      cursor = addDays(chunkEnd, 1);
    }
    return out;
  },

  // Все customers Noona отдаются одним запросом (~1800), limit/skip игнорируются
  async syncCustomers() {
    const groups = await this.noonaGet('customer_groups');
    const blacklistGroupId =
      (groups || []).find((g) => (g.title || '').toLowerCase() === 'blacklist')?.id || null;
    const customers = await this.noonaGet('customers');

    const existing = await strapi.documents(CLIENT_UID).findMany({
      fields: ['noonaCustomerId', 'name', 'phone', 'email', 'blacklisted', 'notes', 'tags'],
      limit: 100000,
    });
    const byNoonaId = new Map(existing.filter((c) => c.noonaCustomerId).map((c) => [c.noonaCustomerId, c]));

    let created = 0;
    let updated = 0;
    const errors = [];
    for (const c of customers || []) {
      if (!c?.id) continue;
      const mapped = mapCustomer(c, blacklistGroupId);
      const cur = byNoonaId.get(c.id);
      try {
        if (!cur) {
          await strapi.documents(CLIENT_UID).create({ data: mapped });
          created += 1;
        } else if (clientChanged(cur, mapped)) {
          await strapi.documents(CLIENT_UID).update({ documentId: cur.documentId, data: mapped });
          updated += 1;
        }
      } catch (e) {
        errors.push(`customer ${c.id}: ${e.message}`);
      }
    }
    return { total: (customers || []).length, created, updated, errors };
  },

  async syncEvents(fromIso: string, toIso: string) {
    const events = await this.fetchNoonaEvents(fromIso, toIso);

    // Карты для relations: client по noonaCustomerId, personal по noonaEmployeeId
    const clients = await strapi.documents(CLIENT_UID).findMany({
      fields: ['noonaCustomerId'],
      limit: 100000,
    });
    const clientByNoona = new Map(
      clients.filter((c) => c.noonaCustomerId).map((c) => [c.noonaCustomerId, c.documentId])
    );
    const personals = await strapi.documents(PERSONAL_UID).findMany({
      fields: ['noonaEmployeeId'],
      status: 'published',
      limit: 1000,
    });
    const personalByNoona = new Map(
      personals.filter((p) => p.noonaEmployeeId).map((p) => [p.noonaEmployeeId, p.documentId])
    );

    // Что из окна у нас уже есть — нужен только noonaEventId (синк = create-only,
    // существующие брони не сравниваем и не трогаем)
    const existing = await strapi.documents(BOOKING_UID).findMany({
      filters: { noonaEventId: { $in: (events || []).map((e) => e.id).filter(Boolean) } },
      fields: ['noonaEventId'],
      limit: 100000,
    });
    const byEventId = new Set(existing.map((b) => b.noonaEventId));

    // ТОЛЬКО ДОЗАПИСЬ: заводим брони, которых у нас ещё нет (чтобы не терять записи,
    // сделанные через noona.app), и НИЧЕГО не трогаем у уже существующих. После cutover
    // мастер данных — наш календарь: статус (Dorazila/Proběhla/Nepřišla), цена, услуги,
    // комментарии и термин правит админ, и синк из Noona их затирал бы каждые 10 минут.
    let created = 0;
    let skipped = 0;
    const errors = [];
    for (const e of events || []) {
      if (!e?.id) continue;
      if (byEventId.has(e.id)) {
        skipped += 1;
        continue;
      }
      const mapped = mapEvent(e);
      const clientDocId = e.customer ? clientByNoona.get(e.customer) || null : null;
      const employeeDocId = e.employee ? personalByNoona.get(e.employee) || null : null;
      try {
        await strapi.documents(BOOKING_UID).create({
          data: { ...mapped, client: clientDocId, employee: employeeDocId },
        });
        created += 1;
      } catch (err) {
        errors.push(`event ${e.id}: ${err.message}`);
      }
    }
    return { total: (events || []).length, created, updated: 0, skipped, errors };
  },

  // Расписание: opening_hours + blocked_times за окно дат ['YYYY-MM-DD'..].
  // blocked_times: `to` у эндпоинта ИСКЛЮЧАЮЩИЙ → передаём day+1; повторяющиеся
  // блоки (rrule) разворачиваются по датам с тем же id → ключ дедупа = `id|date`.
  async syncSchedule(fromDate: string, toDate: string) {
    const openingParams = new URLSearchParams();
    openingParams.append('filter', JSON.stringify({ from: fromDate, to: toDate }));
    const [opening, blocked] = await Promise.all([
      this.noonaGet(`opening_hours?${openingParams.toString()}`),
      this.fetchBlockedRange(fromDate, toDate),
    ]);

    // ── salon-hours upsert по дате ──
    const existingHours = await strapi.documents(SALON_HOUR_UID).findMany({
      filters: { date: { $gte: fromDate, $lte: toDate } },
      limit: 100000,
    });
    const hoursByDate = new Map(existingHours.map((h) => [h.date, h]));
    let hoursCreated = 0;
    let hoursUpdated = 0;
    const hErrors = [];
    for (const [date, wins] of Object.entries(opening || {})) {
      const windows = (wins as Array<{ starts_at?: string; ends_at?: string }>) || [];
      const starts = windows.map((w) => (w.starts_at ? hhmmToMin(w.starts_at) : null)).filter((v) => v != null);
      const ends = windows.map((w) => (w.ends_at ? hhmmToMin(w.ends_at) : null)).filter((v) => v != null);
      const openMin = starts.length ? Math.min(...starts) : null;
      const closeMin = ends.length ? Math.max(...ends) : null;
      const data = { date, openMin, closeMin, windows };
      const cur = hoursByDate.get(date);
      try {
        if (!cur) {
          await strapi.documents(SALON_HOUR_UID).create({ data });
          hoursCreated += 1;
        } else if (cur.openMin !== openMin || cur.closeMin !== closeMin) {
          await strapi.documents(SALON_HOUR_UID).update({ documentId: cur.documentId, data });
          hoursUpdated += 1;
        }
      } catch (e) {
        hErrors.push(`hours ${date}: ${e.message}`);
      }
    }

    // ── time-block upsert + reconcile (удаляем исчезнувшие в окне) ──
    const personals = await strapi.documents(PERSONAL_UID).findMany({
      fields: ['noonaEmployeeId'],
      status: 'published',
      limit: 1000,
    });
    const personalByNoona = new Map(
      personals.filter((p) => p.noonaEmployeeId).map((p) => [p.noonaEmployeeId, p.documentId])
    );

    const freshRaw = (Array.isArray(blocked) ? blocked : []).filter(
      (b) => b?.employee && b?.date && b.date >= fromDate && b.date <= toDate
    );
    // dedup по id|date (rrule-инстанс может прийти в двух смежных чанках)
    const freshBlocks = [...new Map(freshRaw.map((b) => [`${b.id}|${b.date}`, b])).values()];
    const freshKeys = new Set(freshBlocks.map((b) => `${b.id}|${b.date}`));

    const existingBlocks = await strapi.documents(TIME_BLOCK_UID).findMany({
      filters: { date: { $gte: fromDate, $lte: toDate } },
      limit: 100000,
    });
    const blockByKey = new Map(existingBlocks.map((b) => [b.noonaKey, b]));

    let blCreated = 0;
    let blUpdated = 0;
    let blDeleted = 0;
    const blErrors = [];
    for (const b of freshBlocks) {
      const key = `${b.id}|${b.date}`;
      const data = {
        noonaKey: key,
        noonaBlockedId: b.id,
        noonaEmployeeId: b.employee,
        employee: personalByNoona.get(b.employee) || null,
        date: b.date,
        startsAt: b.starts_at || null,
        endsAt: b.ends_at || null,
        title: b.title || '',
        theme: b.theme || '',
      };
      const cur = blockByKey.get(key);
      try {
        if (!cur) {
          await strapi.documents(TIME_BLOCK_UID).create({ data });
          blCreated += 1;
        } else if (
          cur.startsAt !== data.startsAt ||
          cur.endsAt !== data.endsAt ||
          (cur.title ?? '') !== data.title ||
          (cur.noonaEmployeeId ?? '') !== data.noonaEmployeeId
        ) {
          await strapi.documents(TIME_BLOCK_UID).update({ documentId: cur.documentId, data });
          blUpdated += 1;
        }
      } catch (e) {
        blErrors.push(`block ${key}: ${e.message}`);
      }
    }
    // Reconcile: блоки зеркала в окне, которых больше нет в Noona → удалить.
    // Блоки нашего движка (noonaKey 'own|…', booking-engine adminCreateBlock)
    // Noona не знает — их реконсайл НЕ трогает.
    for (const b of existingBlocks) {
      if (String(b.noonaKey || '').startsWith('own|')) continue;
      if (!freshKeys.has(b.noonaKey)) {
        try {
          await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
          blDeleted += 1;
        } catch (e) {
          blErrors.push(`block-del ${b.noonaKey}: ${e.message}`);
        }
      }
    }

    return {
      hours: { created: hoursCreated, updated: hoursUpdated, errors: hErrors },
      blocks: { total: freshBlocks.length, created: blCreated, updated: blUpdated, deleted: blDeleted, errors: blErrors },
    };
  },

  // Инкрементальный синк: окно [сегодня−30д, сегодня+90д] + все customers (дёшево)
  async syncRecent() {
    if (!this.hasEnv()) {
      strapi.log.info('booking-mirror: NOONA env missing, skip');
      return { skipped: true };
    }
    const now = Date.now();
    const fromIso = new Date(now - 30 * 86400000).toISOString();
    const toIso = new Date(now + 90 * 86400000).toISOString();

    const customers = await this.syncCustomers();
    const events = await this.syncEvents(fromIso, toIso);
    const schedule = await this.syncSchedule(pragueDate(-30), pragueDate(90));

    const summary = {
      window: { from: fromIso, to: toIso },
      customers: { created: customers.created, updated: customers.updated, errors: customers.errors.length },
      events: {
        total: events.total,
        created: events.created,
        updated: events.updated,
        skipped: events.skipped,
        errors: events.errors.length,
      },
      schedule: {
        hours: schedule.hours.created + schedule.hours.updated,
        blocks: `+${schedule.blocks.created}/~${schedule.blocks.updated}/-${schedule.blocks.deleted}`,
      },
    };
    strapi.log.info(`booking-mirror sync: ${JSON.stringify(summary)}`);
    if (customers.errors.length) strapi.log.warn(`booking-mirror customer errors: ${customers.errors.slice(0, 5).join(' | ')}`);
    if (events.errors.length) strapi.log.warn(`booking-mirror event errors: ${events.errors.slice(0, 5).join(' | ')}`);
    return { ...summary, customerErrors: customers.errors, eventErrors: events.errors };
  },
};
