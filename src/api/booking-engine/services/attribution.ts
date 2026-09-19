// @ts-nocheck
// Отчёт владельца «Источники броней» (s200): откуда пришли брони за период, сколько из
// них сделали НОВЫЕ клиенты и сколько эти новые клиенты принесли за всё время.
//
// Период — по дате СОЗДАНИЯ брони (как считает реклама) или по дате визита.
// Канал брони: админские и Noona-брони — свой канал, брони с сайта — по касанию
// (first = первый заход, last = последний не прямой, см. attribution-core).
//
// «Новый клиент»: у брони с s200 — флаг is_new_client, посчитанный в момент брони по
// телефону/e-mail. У старых броней флага нет — считаем тут же, по id клиента: нет более
// ранних неотменённых броней. Строка помечает, откуда взят признак (flag / computed).

import { CHANNEL_LABEL, bookingChannel, campaignOf } from './attribution-core';

const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const MAX_DAYS = 400;

class ReportError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const jsonObj = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const touchText = (t) => {
  if (!t) return '';
  const parts = [];
  if (t.utm_source || t.utm_medium) parts.push([t.utm_source, t.utm_medium].filter(Boolean).join('/'));
  if (t.utm_campaign) parts.push(t.utm_campaign);
  if (t.gclid || t.gbraid || t.wbraid) parts.push('gclid');
  if (t.gad_campaignid) parts.push(`gad ${t.gad_campaignid}`);
  if (t.fbclid) parts.push('fbclid');
  if (t.sznclid) parts.push('sznclid');
  if (t.referrer) {
    try {
      parts.push(new URL(t.referrer).hostname.replace(/^www\./, ''));
    } catch {
      parts.push(t.referrer);
    }
  }
  if (!parts.length) parts.push('прямой');
  return parts.join(' · ');
};

const emptyAgg = (key) => ({
  key,
  label: CHANNEL_LABEL[key] || key,
  bookings: 0,
  newClients: 0,
  checkedOut: 0,
  active: 0,
  cancelled: 0,
  noshow: 0,
  revenue: 0,
  newClientsLifetimeRevenue: 0,
  newClientsLifetimeVisits: 0,
});

export default {
  async report({ from, to, basis = 'created', touch = 'first' }) {
    if (!isDateStr(from) || !isDateStr(to)) throw new ReportError(400, 'bad_range', 'from/to должны быть YYYY-MM-DD');
    if (from > to) throw new ReportError(400, 'bad_range', 'from позже to');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (days > MAX_DAYS) throw new ReportError(400, 'range_too_long', `Период не длиннее ${MAX_DAYS} дней`);
    if (!['created', 'visit'].includes(basis)) throw new ReportError(400, 'bad_basis', 'basis: created | visit');
    if (!['first', 'last'].includes(touch)) throw new ReportError(400, 'bad_touch', 'touch: first | last');

    const knex = strapi.db.connection;
    const createdExpr = `((coalesce(b.noona_created_at, b.created_at) at time zone 'UTC') at time zone 'Europe/Prague')`;
    const periodExpr = basis === 'created' ? `(${createdExpr})::date` : 'b.date';

    const { rows } = await knex.raw(
      `
      select
        b.id,
        b.document_id,
        to_char(b.date, 'YYYY-MM-DD') as date,
        to_char((b.starts_at at time zone 'UTC') at time zone 'Europe/Prague', 'HH24:MI') as time,
        to_char(${createdExpr}, 'YYYY-MM-DD HH24:MI') as created,
        coalesce(b.noona_created_at, b.created_at) as created_raw,
        b.status,
        b.origin,
        nullif(b.created_by_name, '') as created_by,
        b.total_price::float as price,
        b.attribution,
        b.is_new_client,
        b.discount->>'type' as discount_type,
        b.employee_name_raw as master,
        cl.id as client_id,
        coalesce(nullif(cl.name, ''), b.client_name_raw) as client_name
      from bookings b
      left join lateral (
        select c.id, c.name from bookings_client_lnk bc join clients c on c.id = bc.client_id
        where bc.booking_id = b.id limit 1
      ) cl on true
      where ${periodExpr} between ?::date and ?::date
      order by coalesce(b.noona_created_at, b.created_at)
      `,
      [from, to]
    );

    // старые брони без флага: есть ли у клиента более ранняя неотменённая бронь
    const needCompute = rows.filter((r) => r.is_new_client == null && r.client_id);
    const computed = new Map();
    if (needCompute.length) {
      const ids = needCompute.map((r) => r.id);
      const res = await knex.raw(
        `
        select b.id,
          not exists (
            select 1 from bookings_client_lnk bc2 join bookings b2 on b2.id = bc2.booking_id
            where bc2.client_id = bc.client_id and b2.id <> b.id and b2.status <> 'cancelled'
              and coalesce(b2.noona_created_at, b2.created_at) < coalesce(b.noona_created_at, b.created_at)
          ) as is_new
        from bookings b join bookings_client_lnk bc on bc.booking_id = b.id
        where b.id = any(?)
        `,
        [ids]
      );
      for (const r of res.rows) computed.set(r.id, r.is_new);
    }

    // выручка новых клиентов за всё время (все их состоявшиеся визиты, любой канал)
    const out = rows.map((r) => {
      const attribution = jsonObj(r.attribution);
      const channel = bookingChannel(r.origin, attribution, touch);
      const t = attribution ? (touch === 'first' ? attribution.first || attribution.last : attribution.last || attribution.first) : null;
      const flag = r.is_new_client;
      // отменённая бронь нового клиента новым клиентом не считается — он не пришёл и,
      // возможно, ещё придёт позже другой бронью
      const isNew = r.status === 'cancelled' ? false : flag != null ? flag : Boolean(computed.get(r.id));
      return {
        id: r.id,
        documentId: r.document_id,
        created: r.created,
        date: r.date,
        time: r.time,
        status: r.status,
        origin: r.origin,
        createdBy: r.created_by,
        master: r.master || '',
        clientId: r.client_id,
        clientName: r.client_name || '',
        price: Number(r.price) || 0,
        isNewClient: isNew,
        newClientSource: flag != null ? 'flag' : 'computed',
        rebook: r.discount_type === 'rebook',
        channel,
        channelLabel: CHANNEL_LABEL[channel],
        campaign: campaignOf(t),
        firstTouch: touchText(attribution?.first),
        lastTouch: touchText(attribution?.last),
        landing: t?.landing || '',
        hasAttribution: Boolean(attribution),
      };
    });

    const newClientIds = [...new Set(out.filter((r) => r.isNewClient && r.clientId).map((r) => r.clientId))];
    const lifetime = new Map();
    if (newClientIds.length) {
      const res = await knex.raw(
        `
        select bc.client_id, count(*)::int as visits, coalesce(sum(b.total_price), 0)::float as revenue
        from bookings b join bookings_client_lnk bc on bc.booking_id = b.id
        where bc.client_id = any(?) and b.status = 'checkedOut'
        group by bc.client_id
        `,
        [newClientIds]
      );
      for (const r of res.rows) lifetime.set(r.client_id, { visits: r.visits, revenue: Number(r.revenue) || 0 });
    }

    const byChannel = new Map();
    const byCampaign = new Map();
    const countedLifetime = new Set();
    for (const r of out) {
      const a = byChannel.get(r.channel) || emptyAgg(r.channel);
      a.bookings += 1;
      if (r.status in a) a[r.status] += 1;
      if (r.status === 'checkedOut') a.revenue += r.price;
      if (r.isNewClient) {
        a.newClients += 1;
        // один клиент — одна выручка за всё время, даже если в периоде у него 2 новые брони
        const key = `${r.channel}|${r.clientId}`;
        if (!countedLifetime.has(key)) {
          countedLifetime.add(key);
          const lt = lifetime.get(r.clientId);
          if (lt) {
            a.newClientsLifetimeRevenue += lt.revenue;
            a.newClientsLifetimeVisits += lt.visits;
          }
        }
      }
      byChannel.set(r.channel, a);

      if (r.channel !== 'admin' && r.channel !== 'noona' && r.channel !== 'no_data' && r.channel !== 'direct') {
        const ck = `${r.channel}|${r.campaign}`;
        const c = byCampaign.get(ck) || { channel: r.channel, channelLabel: r.channelLabel, campaign: r.campaign || '—', bookings: 0, newClients: 0, checkedOut: 0, cancelled: 0, revenue: 0 };
        c.bookings += 1;
        if (r.isNewClient) c.newClients += 1;
        if (r.status === 'checkedOut') {
          c.checkedOut += 1;
          c.revenue += r.price;
        }
        if (r.status === 'cancelled') c.cancelled += 1;
        byCampaign.set(ck, c);
      }
    }

    const site = out.filter((r) => r.origin === 'site');
    return {
      from,
      to,
      basis,
      touch,
      totals: {
        bookings: out.length,
        newClients: out.filter((r) => r.isNewClient).length,
        site: site.length,
        siteWithSource: site.filter((r) => r.hasAttribution).length,
        admin: out.filter((r) => r.channel === 'admin').length,
        revenue: out.filter((r) => r.status === 'checkedOut').reduce((s, r) => s + r.price, 0),
      },
      channels: [...byChannel.values()].sort((a, b) => b.bookings - a.bookings),
      campaigns: [...byCampaign.values()].sort((a, b) => b.bookings - a.bookings),
      rows: out,
    };
  },
};
