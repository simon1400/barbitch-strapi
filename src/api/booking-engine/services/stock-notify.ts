// @ts-nocheck
/**
 * «Sklad — zásoby», Фаза 2 (s252): push и напоминания склада (план STOCK_NEXT_SESSION_PROMPT.md §5.2–§5.3;
 * решения владельца §0.6, §0.10).
 *
 * Кому что (§0.10 — «напоминание идёт тому, кто действует»):
 *   • управляющей (чешский): позиция «došlo» — сразу (если отметила не она сама); «málo» — не поштучно,
 *     а сводкой в 10:00 вместе с просроченными заказами (по понедельникам — ещё «давно не считали»);
 *     запрос на затрату от администратора ждёт её одобрения; понедельничная инвентура не сделана к 19:00
 *     (+ запись журнала `stock_inventory_missed` → строка «Systém zaznamenal» в её výkazu);
 *   • администраторам (чешский): понедельник 10:00 — «Rychlá inventura», сколько позиций пересчитать;
 *   • владельцу (русский): только просроченные заказы (раз в день) и затрата со склада на его ступени.
 *
 * «Уже сообщили» — `stock-item.notifiedStatus` (low | out): сводка 10:00 берёт только позиции, о статусе
 * которых управляющая ещё не знает, и не берёт те, что уже заказаны. Вернулась в «Skladem» — отметка
 * снимается (stock.ts, `_moveWithRetry`). s261: `soon` — «brzy dojde» по прогнозу расхода (ещё «Skladem»);
 * снимается приходом (`clearNotified`).
 *
 * Всё под env `STOCK_PUSH_ENABLED=true` (+ VAPID в push-notify): и события, и кроны, и запись
 * «inventura neprovedena». Без env — тишина, модуль работает как в Фазе 1.
 *
 * Верх файла — чистые функции (tests/stock-notify.test.mjs), ниже — сервис.
 */

import { pragueDateOf } from './slots-core';
import { dniText, mondayOf } from './stock';

const ADMIN_UID = 'api::admin-user.admin-user';
const ITEM_UID = 'api::stock-item.stock-item';

/** Строк в теле push (iOS на закрытом экране показывает ~4). */
export const MAX_BODY_LINES = 4;
/** «Давно не считали» в понедельничной сводке управляющей. */
export const STALE_DAYS = 30;
/** Имя в журнале для записей, которые делает сама система (не сотрудник). */
export const SYSTEM_ACTOR = 'Systém';

export const enabled = (): boolean => process.env.STOCK_PUSH_ENABLED === 'true';

const cut = (s: unknown, n: number): string => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/** Склонение чешского «položka». */
export const polozek = (n: number) => (n === 1 ? 'položka' : n >= 2 && n <= 4 ? 'položky' : 'položek');
const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ').replace(/\s/g, ' ')} Kč`;

const lines = (rows: string[]) =>
  rows.length <= MAX_BODY_LINES ? rows : [...rows.slice(0, MAX_BODY_LINES - 1), `… a další ${rows.length - (MAX_BODY_LINES - 1)}`];

/** Управляющей сразу: позиция закончилась. */
export const outPayload = (item: any) => ({
  title: `📦 Došlo: ${cut(item.name, 60)}`,
  body: `${cut(item.location, 40) || 'Sklad'} · objednat?`,
  url: '/stock?tab=order',
  tag: `stock-out-${item.documentId}`,
});

/**
 * Позиции для сводки 10:00: «málo» или «došlo», о которых управляющая ещё не знает
 * (`notifiedStatus` ≠ статус) и которые не покрыты открытым заказом. `items` — itemView.
 */
export const summaryCandidates = (items: any[]) =>
  items.filter((i) => i.active && (i.status === 'low' || i.status === 'out') && i.notifiedStatus !== i.status && i.toOrderPacks > 0);

/**
 * s261 (Фаза 3, §5.4): ещё «Skladem», но по расходу хватит на ≤ SOON_DAYS — управляющей в сводке 10:00
 * один раз (отметка `notifiedStatus: soon` снимается приходом), если ещё не заказано.
 */
export const soonCandidates = (items: any[]) => items.filter((i) => i.active && i.soon && i.notifiedStatus !== 'soon' && i.toOrderPacks > 0);

/**
 * Управляющей в 10:00: новые «dochází / došlo», просроченные заказы, по понедельникам — сколько
 * позиций не считали дольше STALE_DAYS. null — нечего сказать.
 */
export const managerDailyPayload = ({ items = [], soon = [], overdue = [], stale = 0 }: { items?: any[]; soon?: any[]; overdue?: any[]; stale?: number }) => {
  if (!items.length && !soon.length && !overdue.length && !stale) return null;
  const rows = [
    ...items.map((i) => `${i.status === 'out' ? 'Došlo' : 'Dochází'}: ${cut(i.name, 50)}`),
    ...soon.map((i) => `Brzy dojde: ${cut(i.name, 50)}${i.daysLeft != null ? ` (~${i.daysLeft} ${dniText(i.daysLeft)})` : ''}`),
    ...overdue.map((o) => `Nepřišlo: ${cut(o.supplier, 40) || 'objednávka'} (${o.days} dní)`),
    ...(stale ? [`Nepočítáno > ${STALE_DAYS} dní: ${stale} ${polozek(stale)}`] : []),
  ];
  const toOrder = items.length + soon.length;
  const parts = [
    toOrder ? `objednat ${toOrder}` : '',
    overdue.length ? `nepřišlo ${overdue.length}` : '',
  ].filter(Boolean);
  return {
    title: `📦 Sklad${parts.length ? `: ${parts.join(' · ')}` : ''}`,
    body: lines(rows).join('\n'),
    url: toOrder ? '/stock?tab=order' : overdue.length ? '/stock?tab=orders' : '/stock?tab=inventory',
    tag: 'stock-daily',
  };
};

/** Владельцу раз в день: заказы, которые не пришли в срок. */
export const ownerOverduePayload = (overdue: any[]) =>
  overdue.length
    ? {
        title: `📦 Заказ не пришёл: ${overdue.length}`,
        body: lines(overdue.map((o) => `${cut(o.supplier, 40) || 'без поставщика'} · ${o.days} дн. назад`)).join('\n'),
        url: '/stock?tab=orders',
        tag: 'stock-overdue',
      }
    : null;

/** Администраторам в понедельник 10:00: «Rychlá inventura». */
export const inventoryStartPayload = (remaining: number) => ({
  title: '🧮 Rychlá inventura',
  body: `Dnes přepočítat ${remaining} ${polozek(remaining)} — pár minut s telefonem u polic.`,
  url: '/stock?tab=inventory',
  tag: 'stock-inventory',
});

/** Управляющей в понедельник 19:00: инвентура не закончена. */
export const inventoryMissedPayload = (remaining: number) => ({
  title: '🧮 Inventura neprovedena',
  body: `Zbývá přepočítat ${remaining} ${polozek(remaining)}.`,
  url: '/stock?tab=inventory',
  tag: 'stock-inventory-missed',
});

/** Запрос на затрату со склада: управляющей (её ступень) или владельцу (после неё). */
export const costRequestPayload = (req: any, stage: 'manager' | 'owner') => {
  const c = req?.changes || {};
  const sum = Number(c.sum);
  const what = [cut(c.name, 60), Number.isFinite(sum) && sum > 0 ? kc(sum) : ''].filter(Boolean).join(' · ');
  return stage === 'manager'
    ? {
        title: '🧾 Náklad ke schválení',
        body: `${cut(req?.requestedBy, 40) || 'Administrátor'} přijal(a) objednávku\n${what}`,
        url: '/global/expenses',
        tag: `cost-request-${req?.documentId}`,
      }
    : {
        title: '🧾 Затрата со склада — одобрить',
        body: `${what}\nпринял(а) ${cut(req?.requestedBy, 40) || '—'}${req?.managerApprovedBy ? `, одобрила ${cut(req.managerApprovedBy, 40)}` : ''}`,
        url: '/global/expenses',
        tag: `cost-request-${req?.documentId}`,
      };
};

/** Позиции, которые не считали дольше STALE_DAYS (или никогда). */
export const staleCount = (items: any[]) => items.filter((i) => i.active && (i.daysSinceCount == null || i.daysSinceCount > STALE_DAYS)).length;

export default {
  _stock() {
    return strapi.service('api::booking-engine.stock');
  },
  _orders() {
    return strapi.service('api::booking-engine.stock-orders');
  },
  _mn() {
    return strapi.service('api::booking-engine.manager-notify');
  },

  /** Логины работающих администраторов (их подписки — с `employeeName` = логин). */
  async _adminNames() {
    const rows = await strapi.documents(ADMIN_UID).findMany({ filters: { role: { $eq: 'administrator' } }, fields: ['username', 'isActive'], limit: 50 });
    return rows.filter((a) => a.isActive !== false).map((a) => String(a.username ?? '').trim()).filter(Boolean);
  },

  async toAdmins(payload: any, kind: string) {
    const res = await strapi.service('api::booking-engine.push-notify').notifyByNames(await this._adminNames(), payload);
    if (!res?.skipped) strapi.log.info(`stock-notify: ${kind} → ${res?.sent ?? 0} device(s)`);
    return res;
  },

  async _mark(docIds: string[], status: string) {
    if (!docIds.length) return;
    await strapi.db.query(ITEM_UID).updateMany({ where: { documentId: { $in: docIds } }, data: { notifiedStatus: status } });
  },

  /** Позиция перешла в «došlo» (stock.ts). Отметила сама управляющая — не шлём, только помним. */
  async itemOut(item: any, { role }: { role: string }) {
    if (!enabled()) return { skipped: 'disabled' };
    if (role !== 'manager') {
      const res = await this._mn().toManagers(outPayload(item), 'stock_out');
      if (res?.skipped) return res;
    }
    await this._mark([item.documentId], 'out');
    return { sent: true };
  },

  /** Запрос на затрату со склада (costs.ts): управляющей — новый, владельцу — после её одобрения. */
  async costRequestEvent(req: any, stage: 'manager' | 'owner') {
    if (!enabled()) return { skipped: 'disabled' };
    const payload = costRequestPayload(req, stage);
    return stage === 'manager' ? this._mn().toManagers(payload, 'stock_cost_request') : this._mn().toOwner(payload, 'stock_cost_request_owner');
  },

  /** Крон 10:00: сводка управляющей (новые «málo/došlo», просроченные заказы, по понедельникам — давно не считали) и владельцу (просроченные). */
  async daily({ now = new Date() }: { now?: Date } = {}) {
    if (!enabled()) return { skipped: 'disabled' };
    const today = pragueDateOf(now);
    const [items, overdue] = await Promise.all([this._stock()._views(now, false), this._orders().overdue(now)]);
    const fresh = summaryCandidates(items);
    const soon = soonCandidates(items);
    const stale = mondayOf(today) === today ? staleCount(items) : 0;
    const out: any = { items: fresh.length, soon: soon.length, overdue: overdue.length, stale };
    const mp = managerDailyPayload({ items: fresh, soon, overdue, stale });
    if (mp) {
      const res = await this._mn().toManagers(mp, 'stock_daily');
      if (res?.skipped) return { ...out, skipped: res.skipped };
      out.sent = res.sent;
      // отметка — и когда устройств нет: иначе после подписки придёт пачка давно известного
      for (const status of ['low', 'out']) await this._mark(fresh.filter((i) => i.status === status).map((i) => i.documentId), status);
      await this._mark(soon.map((i) => i.documentId), 'soon');
    }
    const op = ownerOverduePayload(overdue);
    if (op) await this._mn().toOwner(op, 'stock_overdue_owner');
    return out;
  },

  /** Понедельник 10:00: администраторам — сколько позиций в «Rychlá inventura». */
  async inventoryStart({ now = new Date() }: { now?: Date } = {}) {
    if (!enabled()) return { skipped: 'disabled' };
    const remaining = (await this._stock()._views(now, false)).filter((i) => i.inventoryDue).length;
    if (!remaining) return { remaining };
    const res = await this.toAdmins(inventoryStartPayload(remaining), 'stock_inventory');
    return { remaining, ...res };
  },

  /**
   * Понедельник 19:00: инвентура не закончена → управляющей push и запись в журнал (от имени системы):
   * в её výkaz за день попадёт «Sklad — inventura neprovedena» (work-reports, SYSTEM_FACT_ACTIONS).
   */
  async inventoryEscalate({ now = new Date() }: { now?: Date } = {}) {
    if (!enabled()) return { skipped: 'disabled' };
    const remaining = (await this._stock()._views(now, false)).filter((i) => i.inventoryDue).length;
    if (!remaining) return { remaining };
    await strapi
      .service('api::calendar-log.calendar-log')
      .write({
        action: 'stock_inventory_missed',
        entityType: 'stock',
        actorName: SYSTEM_ACTOR,
        entityDocId: '',
        summary: `Sklad: inventura neprovedena — zbývá ${remaining} ${polozek(remaining)}`,
        details: { remaining, monday: mondayOf(pragueDateOf(now)) },
      })
      .catch((e) => strapi.log.error(`calendar-log stock_inventory_missed failed: ${e.message}`));
    const res = await this._mn().toManagers(inventoryMissedPayload(remaining), 'stock_inventory_missed');
    return { remaining, ...res };
  },
};
