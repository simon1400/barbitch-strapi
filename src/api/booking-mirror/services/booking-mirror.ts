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

const sameTs = (a, b): boolean => {
  const ta = a ? new Date(a).getTime() : null;
  const tb = b ? new Date(b).getTime() : null;
  return ta === tb;
};

// Изменилась ли зеркальная запись (relations сравниваются отдельно по noona-id)
const bookingChanged = (existing, mapped): boolean =>
  existing.clientNameRaw !== mapped.clientNameRaw ||
  (existing.employeeNameRaw ?? '') !== mapped.employeeNameRaw ||
  (existing.noonaEmployeeId ?? '') !== mapped.noonaEmployeeId ||
  String(existing.date || '') !== String(mapped.date || '') ||
  !sameTs(existing.startsAt, mapped.startsAt) ||
  !sameTs(existing.endsAt, mapped.endsAt) ||
  existing.status !== mapped.status ||
  (existing.noonaStatus ?? '') !== mapped.noonaStatus ||
  stableStringify(existing.services ?? []) !== stableStringify(mapped.services) ||
  Number(existing.totalPrice ?? null) !== Number(mapped.totalPrice ?? null) ||
  (existing.comment ?? '') !== mapped.comment ||
  (existing.customerComment ?? '') !== mapped.customerComment ||
  (existing.origin ?? '') !== mapped.origin ||
  (existing.bsChannel ?? '') !== mapped.bsChannel ||
  (existing.bsGroup ?? '') !== mapped.bsGroup ||
  !sameTs(existing.noonaCreatedAt, mapped.noonaCreatedAt);

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

    // Существующие зеркальные записи окна — по noonaEventId (для change-detect нужны все поля)
    const existing = await strapi.documents(BOOKING_UID).findMany({
      filters: { noonaEventId: { $in: (events || []).map((e) => e.id).filter(Boolean) } },
      populate: {
        client: { fields: ['noonaCustomerId'] },
        employee: { fields: ['noonaEmployeeId'] },
      },
      limit: 100000,
    });
    const byEventId = new Map(existing.map((b) => [b.noonaEventId, b]));

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];
    for (const e of events || []) {
      if (!e?.id) continue;
      const mapped = mapEvent(e);
      const clientDocId = e.customer ? clientByNoona.get(e.customer) || null : null;
      const employeeDocId = e.employee ? personalByNoona.get(e.employee) || null : null;
      const cur = byEventId.get(e.id);
      try {
        if (!cur) {
          await strapi.documents(BOOKING_UID).create({
            data: { ...mapped, client: clientDocId, employee: employeeDocId },
          });
          created += 1;
        } else {
          // Сравниваем с РЕЗОЛВАБЕЛЬНЫМ значением: мастер без personal-записи
          // (бывшие сотрудники) даёт employee=null в зеркале — это не «изменение»
          // (сырой id сохранён в noonaEmployeeId)
          const expClient = e.customer && clientByNoona.has(e.customer) ? e.customer : null;
          const expEmployee = e.employee && personalByNoona.has(e.employee) ? e.employee : null;
          const relChanged =
            (cur.client?.noonaCustomerId || null) !== expClient ||
            (cur.employee?.noonaEmployeeId || null) !== expEmployee;
          if (bookingChanged(cur, mapped) || relChanged) {
            await strapi.documents(BOOKING_UID).update({
              documentId: cur.documentId,
              data: { ...mapped, client: clientDocId, employee: employeeDocId },
            });
            updated += 1;
          } else {
            skipped += 1;
          }
        }
      } catch (err) {
        errors.push(`event ${e.id}: ${err.message}`);
      }
    }
    return { total: (events || []).length, created, updated, skipped, errors };
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
    };
    strapi.log.info(`booking-mirror sync: ${JSON.stringify(summary)}`);
    if (customers.errors.length) strapi.log.warn(`booking-mirror customer errors: ${customers.errors.slice(0, 5).join(' | ')}`);
    if (events.errors.length) strapi.log.warn(`booking-mirror event errors: ${events.errors.slice(0, 5).join(' | ')}`);
    return { ...summary, customerErrors: customers.errors, eventErrors: events.errors };
  },
};
