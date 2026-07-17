// @ts-nocheck
// Синк Noona → наш календарь. ПОСЛЕ CUTOVER мастер данных — НАШ календарь,
// поэтому весь синк CREATE-ONLY (только дозапись, НИКОГДА не обновляет и не
// удаляет существующее): новые клиенты (регистрация в noona.app), их новые
// брони, отсутствующие даты часов салона (нужны движку доступности слотов).
// Блоки (blocked_times) НЕ синкаются вообще — нерабочее время ведётся только
// в нашем календаре, админы свободно создают/правят/удаляют любые блоки.
// Env: NOONA_TOKEN + NOONA_COMPANY_ID. Без них — тихий skip.
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

  // Все customers Noona отдаются одним запросом (~1800), limit/skip игнорируются.
  // CREATE-ONLY: заводим только НОВЫХ клиентов (регистрация в noona.app).
  // Существующих не трогаем вообще — имя/телефон/email/блэклист правит наш календарь.
  async syncCustomers() {
    const groups = await this.noonaGet('customer_groups');
    const blacklistGroupId =
      (groups || []).find((g) => (g.title || '').toLowerCase() === 'blacklist')?.id || null;
    const customers = await this.noonaGet('customers');

    const existing = await strapi.documents(CLIENT_UID).findMany({
      fields: ['noonaCustomerId'],
      limit: 100000,
    });
    const known = new Set(existing.map((c) => c.noonaCustomerId).filter(Boolean));

    let created = 0;
    const errors = [];
    for (const c of customers || []) {
      if (!c?.id || known.has(c.id)) continue;
      try {
        await strapi.documents(CLIENT_UID).create({ data: mapCustomer(c, blacklistGroupId) });
        created += 1;
      } catch (e) {
        errors.push(`customer ${c.id}: ${e.message}`);
      }
    }
    return { total: (customers || []).length, created, updated: 0, errors };
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

    // Tombstones: noonaEventId броней, которые админ УДАЛИЛ из нашего календаря
    // (adminDeleteBooking пишет их в core store) — их никогда не заводим заново.
    let deadIds = new Set();
    try {
      const dead = await strapi.store({ type: 'api', name: 'booking-mirror' }).get({ key: 'deletedEventIds' });
      deadIds = new Set(Array.isArray(dead) ? dead : []);
    } catch (e) {
      strapi.log.warn(`booking-mirror: tombstone read failed: ${e.message}`);
    }

    // ТОЛЬКО ДОЗАПИСЬ: заводим брони, которых у нас ещё нет (чтобы не терять записи,
    // сделанные через noona.app), и НИЧЕГО не трогаем у уже существующих. После cutover
    // мастер данных — наш календарь: статус (Dorazila/Proběhla/Nepřišla), цена, услуги,
    // комментарии и термин правит админ, и синк из Noona их затирал бы каждые 10 минут.
    let created = 0;
    let skipped = 0;
    const errors = [];
    for (const e of events || []) {
      if (!e?.id) continue;
      if (byEventId.has(e.id) || deadIds.has(e.id)) {
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

  // Часы салона: CREATE-ONLY дозапись ОТСУТСТВУЮЩИХ дат (движку доступности нужны
  // openMin/closeMin будущих дней, иначе на сайте не будет слотов). Существующие
  // записи НЕ трогаем никогда — правки владельца в Strapi всегда выигрывают.
  // Блоки (blocked_times) НЕ синкаются: нерабочее время ведётся ТОЛЬКО у нас.
  async syncSalonHours(fromDate: string, toDate: string) {
    const params = new URLSearchParams();
    params.append('filter', JSON.stringify({ from: fromDate, to: toDate }));
    const opening = await this.noonaGet(`opening_hours?${params.toString()}`);

    const existing = await strapi.documents(SALON_HOUR_UID).findMany({
      filters: { date: { $gte: fromDate, $lte: toDate } },
      fields: ['date'],
      limit: 100000,
    });
    const known = new Set(existing.map((h) => h.date));

    let created = 0;
    const errors = [];
    for (const [date, wins] of Object.entries(opening || {})) {
      if (known.has(date)) continue;
      const windows = (wins as Array<{ starts_at?: string; ends_at?: string }>) || [];
      const starts = windows.map((w) => (w.starts_at ? hhmmToMin(w.starts_at) : null)).filter((v) => v != null);
      const ends = windows.map((w) => (w.ends_at ? hhmmToMin(w.ends_at) : null)).filter((v) => v != null);
      const openMin = starts.length ? Math.min(...starts) : null;
      const closeMin = ends.length ? Math.max(...ends) : null;
      try {
        await strapi.documents(SALON_HOUR_UID).create({ data: { date, openMin, closeMin, windows } });
        created += 1;
      } catch (e) {
        errors.push(`hours ${date}: ${e.message}`);
      }
    }
    return { created, errors };
  },

  // Инкрементальный синк (весь CREATE-ONLY): окно [сегодня−30д, сегодня+90д]
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
    const hours = await this.syncSalonHours(pragueDate(0), pragueDate(90));

    const summary = {
      window: { from: fromIso, to: toIso },
      customers: { created: customers.created, errors: customers.errors.length },
      events: {
        total: events.total,
        created: events.created,
        skipped: events.skipped,
        errors: events.errors.length,
      },
      hours: { created: hours.created, errors: hours.errors.length },
    };
    strapi.log.info(`booking-mirror sync: ${JSON.stringify(summary)}`);
    if (customers.errors.length) strapi.log.warn(`booking-mirror customer errors: ${customers.errors.slice(0, 5).join(' | ')}`);
    if (events.errors.length) strapi.log.warn(`booking-mirror event errors: ${events.errors.slice(0, 5).join(' | ')}`);
    return { ...summary, customerErrors: customers.errors, eventErrors: events.errors };
  },
};
