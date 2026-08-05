// @ts-nocheck
/**
 * Дубли клиентов: поиск групп, слияние карточек, правка контактов, блэклист.
 *
 * Почему отдельный сервис, а не REST из админки:
 *  - слияние = хирургия по link-таблицам (bookings/loyalty/redemptions/login-tokens)
 *    в ОДНОЙ транзакции; через Document API это не сделать безопасно;
 *  - у link-таблиц UNIQUE(other_id, client_id) → перед UPDATE надо снести
 *    конфликтующие строки, иначе 23505;
 *  - карточка клиента удаляется, а её noonaCustomerId живёт в Noona → без
 *    tombstone create-only синк (booking-mirror) заведёт дубль заново.
 *
 * Ключи сравнения (те же, что в разовом скрипте backup/find_client_duplicates.mjs):
 *   email  — lowercase+trim, точное совпадение;
 *   phone  — последние 9 цифр (ловит +420…/+0…/+4200… у одного номера);
 *   name   — только ПОЛНОЕ имя (2+ слова) без диакритики; одиночное «Tereza»
 *            ничего не доказывает — в базе десятки разных Терез.
 * Группа «надёжная» = связана e-mail'ом или телефоном; «вероятная» = только имя.
 */

const CLIENT_UID = 'api::client.client';
const LOG_UID = 'api::client-merge-log.client-merge-log';

// link-таблицы, ссылающиеся на clients(id) (FK ON DELETE CASCADE — потому
// строки надо ПЕРЕВЕСИТЬ до удаления дубля, иначе данные уедут вместе с ним)
const LINK_TABLES = [
  { table: 'bookings_client_lnk', other: 'booking_id', label: 'bookings' },
  { table: 'loyalty_transactions_client_lnk', other: 'loyalty_transaction_id', label: 'loyaltyTx' },
  { table: 'redemptions_client_lnk', other: 'redemption_id', label: 'redemptions' },
  { table: 'client_login_tokens_client_lnk', other: 'client_login_token_id', label: 'loginTokens' },
];

export class DedupeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const stripAccents = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const normName = (s) => stripAccents(s).toLowerCase().replace(/\s+/g, ' ').trim();

const emailKey = (r) => {
  const e = String(r.email || '').trim().toLowerCase();
  return e.includes('@') ? `E:${e}` : null;
};
const phoneKey = (r) => {
  const d = String(r.phone || '').replace(/\D/g, '');
  return d.length >= 9 ? `P:${d.slice(-9)}` : null;
};
const nameKey = (r) => {
  const n = normName(r.name);
  return n.split(' ').filter(Boolean).length >= 2 ? `N:${n}` : null;
};

/** union-find по списку ключевых функций; возвращает только группы 2+ */
const clusterBy = (rows, keyFns) => {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of rows) {
    const id = `C:${r.id}`;
    if (!parent.has(id)) parent.set(id, id);
    for (const fn of keyFns) {
      const k = fn(r);
      if (k) union(id, k);
    }
  }
  const byRoot = new Map();
  for (const r of rows) {
    const root = find(`C:${r.id}`);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(r);
  }
  return [...byRoot.values()].filter((g) => g.length > 1);
};

const matchReasons = (g) => {
  const dup = (fn) => {
    const m = new Map();
    for (const r of g) {
      const k = fn(r);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.values()].some((c) => c > 1);
  };
  const out = [];
  if (dup(nameKey)) out.push('name');
  if (dup(emailKey)) out.push('email');
  if (dup(phoneKey)) out.push('phone');
  return out;
};

/** стабильный ключ группы = отсортированные documentId через | */
export const groupKeyOf = (docIds) => [...docIds].sort().join('|');

const shapeRow = (r) => ({
  id: r.id,
  documentId: r.document_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  blacklisted: Boolean(r.blacklisted),
  blacklistReason: r.blacklist_reason || null,
  noonaCustomerId: r.noona_customer_id || null,
  source: r.source || null,
  notes: r.notes || null,
  birthday: r.birthday ? String(r.birthday).slice(0, 10) : null,
  emailVerifiedAt: r.email_verified_at || null,
  cabinetLastLoginAt: r.cabinet_last_login_at || null,
  marketingConsent: Boolean(r.marketing_consent),
  reminderOptOut: Boolean(r.reminder_opt_out),
  createdAt: r.created_at || null,
  bookings: Number(r.bookings) || 0,
  lastVisit: r.last_date || null,
  futureActive: Number(r.future_active) || 0,
  loyaltyTx: Number(r.loyalty_tx) || 0,
  redemptions: Number(r.redemptions) || 0,
});

export default {
  knex() {
    return strapi.db.connection;
  },

  /** все клиенты со счётчиками (1900 строк — тянем целиком, кластеризуем в JS) */
  async loadClients() {
    const rows = await this.knex().raw(`
      select c.id, c.document_id, c.name, c.email, c.phone, c.blacklisted, c.blacklist_reason,
             c.noona_customer_id, c.source, c.notes, c.created_at, c.birthday,
             c.email_verified_at, c.cabinet_last_login_at, c.marketing_consent, c.reminder_opt_out,
             coalesce(bk.cnt, 0) as bookings,
             bk.last_date,
             coalesce(bk.future_active, 0) as future_active,
             coalesce(lt.cnt, 0) as loyalty_tx,
             coalesce(rd.cnt, 0) as redemptions
      from clients c
      left join (
        select l.client_id, count(*) as cnt, max(b.date)::text as last_date,
               count(*) filter (where b.date >= current_date and b.status = 'active') as future_active
        from bookings_client_lnk l join bookings b on b.id = l.booking_id
        group by l.client_id
      ) bk on bk.client_id = c.id
      left join (select client_id, count(*) as cnt from loyalty_transactions_client_lnk group by client_id) lt on lt.client_id = c.id
      left join (select client_id, count(*) as cnt from redemptions_client_lnk group by client_id) rd on rd.client_id = c.id
    `);
    return (rows.rows || rows).map(shapeRow);
  },

  async ignoredKeys() {
    const logs = await strapi.documents(LOG_UID).findMany({
      filters: { action: 'ignore' },
      fields: ['groupKey'],
      limit: 5000,
    });
    const unignored = await strapi.documents(LOG_UID).findMany({
      filters: { action: 'unignore' },
      fields: ['groupKey', 'createdAt'],
      limit: 5000,
    });
    // «вернуть в список» = запись unignore позже последнего ignore
    const lastIgnore = new Map();
    for (const l of logs) lastIgnore.set(l.groupKey, l.createdAt || '');
    const out = new Set();
    for (const [key, at] of lastIgnore) {
      const back = unignored.filter((u) => u.groupKey === key).map((u) => u.createdAt || '');
      if (!back.some((b) => b > at)) out.add(key);
    }
    return out;
  },

  /** группы дублей: { strong, weak, ignored, stats } */
  async findGroups() {
    const clients = await this.loadClients();
    const ignored = await this.ignoredKeys();

    const strongRaw = clusterBy(clients, [emailKey, phoneKey]);
    const inStrong = new Set(strongRaw.flat().map((r) => r.id));
    const weakRaw = clusterBy(
      clients.filter((r) => !inStrong.has(r.id)),
      [nameKey]
    );

    const bookingsOf = (g) => g.reduce((s, r) => s + r.bookings, 0);
    const shapeGroup = (g, tier) => {
      const rows = [...g].sort((a, b) => b.bookings - a.bookings || a.id - b.id);
      const docIds = rows.map((r) => r.documentId);
      return {
        key: groupKeyOf(docIds),
        tier,
        matchedOn: matchReasons(g),
        blacklistConflict: rows.some((r) => r.blacklisted) && rows.some((r) => !r.blacklisted),
        futureActive: rows.reduce((s, r) => s + r.futureActive, 0),
        totalBookings: bookingsOf(g),
        clients: rows,
      };
    };

    const sortG = (a, b) => b.totalBookings - a.totalBookings || b.clients.length - a.clients.length;
    const all = [
      ...strongRaw.map((g) => shapeGroup(g, 'strong')),
      ...weakRaw.map((g) => shapeGroup(g, 'weak')),
    ];
    const visible = all.filter((g) => !ignored.has(g.key)).sort(sortG);
    const hidden = all.filter((g) => ignored.has(g.key)).sort(sortG);

    const strong = visible.filter((g) => g.tier === 'strong');
    const weak = visible.filter((g) => g.tier === 'weak');
    return {
      strong,
      weak,
      ignored: hidden,
      stats: {
        clientsTotal: clients.length,
        strongGroups: strong.length,
        weakGroups: weak.length,
        extraRecords: visible.reduce((s, g) => s + g.clients.length - 1, 0),
        blacklistConflicts: visible.filter((g) => g.blacklistConflict).length,
        withFutureBookings: visible.filter((g) => g.futureActive > 0).length,
        ignoredGroups: hidden.length,
      },
    };
  },

  async rowsByDocIds(docIds) {
    const rows = await this.knex()('clients').whereIn('document_id', docIds).select('*');
    return rows;
  },

  /**
   * Слияние: все связи дублей переезжают на primary, скаляры домерживаются,
   * дубли удаляются. Необратимо — снимок удалённых карточек уходит в лог.
   */
  async merge({ primaryDocId, docIds, actorName, renameBookings = true }) {
    const dups = [...new Set((docIds || []).filter((d) => d && d !== primaryDocId))];
    if (!primaryDocId) throw new DedupeError(400, 'primary_required', 'Не выбрана главная карточка');
    if (dups.length === 0) throw new DedupeError(400, 'nothing_to_merge', 'Не выбраны карточки для слияния');

    const rows = await this.rowsByDocIds([primaryDocId, ...dups]);
    const primary = rows.find((r) => r.document_id === primaryDocId);
    if (!primary) throw new DedupeError(404, 'client_not_found', 'Главная карточка не найдена');
    const dupRows = rows.filter((r) => r.document_id !== primaryDocId);
    if (dupRows.length === 0) throw new DedupeError(404, 'client_not_found', 'Карточки для слияния не найдены');

    const dupIds = dupRows.map((r) => r.id);
    const moved = {};
    const knex = this.knex();

    await knex.transaction(async (trx) => {
      for (const { table, other, label } of LINK_TABLES) {
        // UNIQUE(other_id, client_id): если та же сущность уже привязана к primary — дубль-строку сносим
        await trx.raw(
          `delete from ${table} d
             where d.client_id = any(?)
               and exists (select 1 from ${table} p where p.${other} = d.${other} and p.client_id = ?)`,
          [dupIds, primary.id]
        );
        const n = await trx(table).whereIn('client_id', dupIds).update({ client_id: primary.id });
        moved[label] = n;
      }

      // скаляры: пустое у primary дозаполняем из дублей, флаги — по ИЛИ
      const firstOf = (field) => {
        if (primary[field] !== null && primary[field] !== undefined && String(primary[field]).trim() !== '')
          return primary[field];
        const hit = dupRows.find(
          (r) => r[field] !== null && r[field] !== undefined && String(r[field]).trim() !== ''
        );
        return hit ? hit[field] : primary[field];
      };
      const maxDate = (field) => {
        const vals = [primary[field], ...dupRows.map((r) => r[field])].filter(Boolean).map((v) => new Date(v));
        return vals.length ? new Date(Math.max(...vals.map((d) => d.getTime()))) : null;
      };
      const minDate = (field) => {
        const vals = [primary[field], ...dupRows.map((r) => r[field])].filter(Boolean).map((v) => new Date(v));
        return vals.length ? new Date(Math.min(...vals.map((d) => d.getTime()))) : null;
      };

      const mergeNote = dupRows
        .map(
          (r) =>
            `Sloučeno ${new Date().toISOString().slice(0, 10)}: ${r.name || '—'} · ${r.email || '—'} · ${r.phone || '—'} (id=${r.id})`
        )
        .join('\n');
      const notes = [primary.notes, ...dupRows.map((r) => r.notes)]
        .map((n) => (n || '').trim())
        .filter(Boolean);
      const uniqueNotes = [...new Set(notes)];

      // дубли удаляем ДО апдейта primary: noona_customer_id UNIQUE — иначе перенос упал бы
      await trx('clients').whereIn('id', dupIds).del();

      await trx('clients')
        .where('id', primary.id)
        .update({
          email: firstOf('email'),
          phone: firstOf('phone'),
          birthday: firstOf('birthday'),
          noona_customer_id: firstOf('noona_customer_id'),
          blacklisted: primary.blacklisted || dupRows.some((r) => r.blacklisted),
          blacklist_reason: firstOf('blacklist_reason'),
          marketing_consent: primary.marketing_consent || dupRows.some((r) => r.marketing_consent),
          marketing_consent_at: minDate('marketing_consent_at'),
          reminder_opt_out: primary.reminder_opt_out || dupRows.some((r) => r.reminder_opt_out),
          email_verified_at: minDate('email_verified_at'),
          cabinet_last_login_at: maxDate('cabinet_last_login_at'),
          notes: [...uniqueNotes, mergeNote].join('\n').slice(0, 5000),
          updated_at: new Date(),
        });

      // календарь рисует СНИМОК имени в брони (bookings.client_name_raw) —
      // без этого на перенесённых бронях останется старое имя дубля
      if (renameBookings && primary.name) {
        const n = await trx('bookings')
          .whereIn(
            'id',
            trx('bookings_client_lnk').select('booking_id').where('client_id', primary.id)
          )
          .update({ client_name_raw: primary.name });
        moved.bookingsRenamed = n;
      }

      // строковые ссылки на клиента (не relation)
      if (await trx.schema.hasTable('comeback_reminder_logs')) {
        const n = await trx('comeback_reminder_logs')
          .whereIn(
            'client_doc_id',
            dupRows.map((r) => r.document_id)
          )
          .update({ client_doc_id: primary.document_id });
        moved.comebackLogs = n;
      }
    });

    // tombstone: noonaCustomerId удалённых карточек, которые НЕ достались primary —
    // иначе create-only синк (booking-mirror) заведёт дубль заново
    const kept = new Set([primary.noona_customer_id, ...dupRows.map((r) => r.noona_customer_id)].filter(Boolean));
    const primaryAfter = (await this.rowsByDocIds([primaryDocId]))[0];
    const stillUsed = primaryAfter?.noona_customer_id || null;
    const tombstones = [...kept].filter((id) => id && id !== stillUsed);
    if (tombstones.length) {
      try {
        const store = strapi.store({ type: 'api', name: 'booking-mirror' });
        const prev = (await store.get({ key: 'mergedCustomerIds' })) || [];
        const next = [...new Set([...(Array.isArray(prev) ? prev : []), ...tombstones])];
        await store.set({ key: 'mergedCustomerIds', value: next });
      } catch (e) {
        strapi.log.warn(`client-dedupe: tombstone write failed: ${e.message}`);
      }
    }

    await this.log('merge', {
      groupKey: groupKeyOf([primaryDocId, ...dups]),
      primaryDocId,
      primaryName: primary.name,
      mergedDocIds: dups,
      actorName,
      details: {
        moved,
        tombstones,
        removed: dupRows.map((r) => ({
          id: r.id,
          documentId: r.document_id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          noonaCustomerId: r.noona_customer_id,
          source: r.source,
          blacklisted: Boolean(r.blacklisted),
        })),
      },
    });

    // баланс копилки клиента изменился — пересчитать награды (тихо, если программа выключена)
    try {
      const loyalty = strapi.service('api::loyalty.loyalty');
      if (loyalty?.enabled?.()) await loyalty.recomputeClientRewards(primaryDocId, new Date().getFullYear());
    } catch (e) {
      strapi.log.warn(`client-dedupe: loyalty recompute failed: ${e.message}`);
    }

    return { ok: true, primaryDocId, merged: dups.length, moved };
  },

  /** правка контактов карточки + распространение имени на брони календаря */
  async updateClient({ docId, patch, actorName, renameBookings = true }) {
    const row = (await this.rowsByDocIds([docId]))[0];
    if (!row) throw new DedupeError(404, 'client_not_found', 'Карточка не найдена');

    const data = {};
    const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
    if ('name' in patch) {
      const n = str(patch.name);
      if (!n) throw new DedupeError(400, 'name_required', 'Имя не может быть пустым');
      data.name = n;
    }
    if ('phone' in patch) data.phone = str(patch.phone);
    if ('email' in patch) {
      const e = str(patch.email);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        throw new DedupeError(400, 'bad_email', 'Некорректный e-mail');
      data.email = e ? e.toLowerCase() : null;
    }
    if ('notes' in patch) data.notes = str(patch.notes);
    if ('blacklisted' in patch) data.blacklisted = Boolean(patch.blacklisted);
    if ('blacklistReason' in patch) data.blacklist_reason = str(patch.blacklistReason);
    if (Object.keys(data).length === 0) return { ok: true, renamedBookings: 0 };
    data.updated_at = new Date();

    const knex = this.knex();
    let renamed = 0;
    await knex.transaction(async (trx) => {
      await trx('clients').where('id', row.id).update(data);
      if (renameBookings && data.name) {
        renamed = await trx('bookings')
          .whereIn('id', trx('bookings_client_lnk').select('booking_id').where('client_id', row.id))
          .update({ client_name_raw: data.name });
      }
    });

    await this.log('blacklist', {
      groupKey: null,
      primaryDocId: docId,
      primaryName: data.name || row.name,
      mergedDocIds: [],
      actorName,
      details: { patch: data, before: { name: row.name, email: row.email, phone: row.phone, blacklisted: Boolean(row.blacklisted) }, renamedBookings: renamed },
    });

    return { ok: true, renamedBookings: renamed };
  },

  /** одним махом выставить блэклист всей группе (закрывает обход блокировки через дубль) */
  async setBlacklist({ docIds, blacklisted, reason, actorName }) {
    const ids = (docIds || []).filter(Boolean);
    if (!ids.length) throw new DedupeError(400, 'nothing_selected', 'Не выбраны карточки');
    const rows = await this.rowsByDocIds(ids);
    if (!rows.length) throw new DedupeError(404, 'client_not_found', 'Карточки не найдены');

    const patch = { blacklisted: Boolean(blacklisted), updated_at: new Date() };
    if (blacklisted) {
      const r = String(reason || '').trim();
      if (r) patch.blacklist_reason = r;
    }
    const n = await this.knex()('clients')
      .whereIn('id', rows.map((r) => r.id))
      .update(patch);

    await this.log('blacklist', {
      groupKey: groupKeyOf(ids),
      primaryDocId: null,
      primaryName: rows[0]?.name || null,
      mergedDocIds: ids,
      actorName,
      details: { blacklisted: Boolean(blacklisted), reason: patch.blacklist_reason || null, affected: n },
    });
    return { ok: true, affected: n };
  },

  async ignore({ docIds, actorName, note }) {
    const key = groupKeyOf((docIds || []).filter(Boolean));
    if (!key) throw new DedupeError(400, 'nothing_selected', 'Не выбрана группа');
    await this.log('ignore', { groupKey: key, mergedDocIds: docIds, actorName, details: { note: note || null } });
    return { ok: true, key };
  },

  async unignore({ groupKey, actorName }) {
    if (!groupKey) throw new DedupeError(400, 'nothing_selected', 'Не выбрана группа');
    await this.log('unignore', { groupKey, mergedDocIds: groupKey.split('|'), actorName, details: {} });
    return { ok: true, key: groupKey };
  },

  async log(action, { groupKey = null, primaryDocId = null, primaryName = null, mergedDocIds = [], details = {}, actorName = null }) {
    try {
      await strapi.documents(LOG_UID).create({
        data: { action, groupKey, primaryDocId, primaryName, mergedDocIds, details, actorName },
      });
    } catch (e) {
      strapi.log.warn(`client-dedupe: log write failed: ${e.message}`);
    }
  },

  async history(limit = 50) {
    return strapi.documents(LOG_UID).findMany({
      filters: { action: { $in: ['merge', 'blacklist'] } },
      sort: { createdAt: 'desc' },
      limit,
    });
  },
};
