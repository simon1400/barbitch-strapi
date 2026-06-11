// @ts-nocheck
// Ежедневный Telegram-дайджест владельцу. ОТДЕЛЬНЫЙ бот (не чатовый):
// env TELEGRAM_DIGEST_BOT_TOKEN + TELEGRAM_DIGEST_CHAT_ID.
// Данные Noona: env NOONA_TOKEN + NOONA_COMPANY_ID.
// Без какого-либо из env — тихо пропускает (лог + {skipped}).

const TELEGRAM_API = 'https://api.telegram.org/bot';
const NOONA_BASE = 'https://api.noona.is/v1/hq/companies';

// 'YYYY-MM-DD' в часовом поясе Праги
const pragueDateStr = (offsetDays = 0): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
    new Date(Date.now() + offsetDays * 86400000)
  );

const pragueTime = (iso: string): string =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const fmtDateCz = (d: string): string => {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
};

const fmtMoney = (n: number): string => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
const fmtH = (min: number): string => `${Math.round((min / 60) * 10) / 10} ч`;

export default {
  async noonaGet(path: string) {
    const token = process.env.NOONA_TOKEN;
    const cid = process.env.NOONA_COMPANY_ID;
    const res = await fetch(`${NOONA_BASE}/${cid}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Noona ${path} → ${res.status}`);
    return res.json();
  },

  async buildDigest(): Promise<string> {
    const yesterday = pragueDateStr(-1);
    const today = pragueDateStr(0);
    const weekEnd = pragueDateStr(6);
    const dayAfterWeekEnd = pragueDateStr(7);

    // ── Noona: сотрудники + события одним окном [вчера .. +7 дней] ──
    const employeesRaw = await this.noonaGet(
      'employees?select=id&select=name&select=available_for_bookings'
    );
    const empNames = new Map();
    const activeIds = new Set();
    for (const e of employeesRaw || []) {
      if (!e.id) continue;
      empNames.set(e.id, (e.name || e.id).trim());
      if (e.available_for_bookings === true) activeIds.add(e.id);
    }

    const eventsParams = new URLSearchParams();
    eventsParams.append(
      'filter',
      JSON.stringify({
        from: `${yesterday}T00:00:00.000Z`,
        to: `${dayAfterWeekEnd}T23:59:59.999Z`,
      })
    );
    for (const f of [
      'employee',
      'status',
      'event_date',
      'starts_at',
      'ends_at',
      'event_types.price',
    ]) {
      eventsParams.append('select', f);
    }
    const events = (await this.noonaGet(`events?${eventsParams.toString()}`)) || [];

    // ── Вчера: выручка по визитам, кол-во, no-show ──
    let yRevenue = 0;
    let yVisits = 0;
    let yNoshow = 0;
    // ── Сегодня: брони по мастерам ──
    const todayByMaster = new Map(); // name → { count, first, last }
    let todayCount = 0;
    // ── Неделя: занято минут (активные мастера) ──
    let weekBookedMin = 0;

    for (const e of events) {
      const d = e.event_date;
      if (!d) continue;
      const price = e.event_types?.[0]?.price?.amount ?? 0;
      const durMin =
        e.starts_at && e.ends_at
          ? Math.max(0, (new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000)
          : 0;

      if (d === yesterday) {
        if (e.status === 'noshow') yNoshow++;
        else if (e.status !== 'cancelled') {
          yVisits++;
          yRevenue += price;
        }
      }

      if (d === today && e.status !== 'cancelled') {
        todayCount++;
        const name = empNames.get(e.employee) || '—';
        let m = todayByMaster.get(name);
        if (!m) {
          m = { count: 0, first: '', last: '' };
          todayByMaster.set(name, m);
        }
        m.count++;
        if (e.starts_at) {
          const t = pragueTime(e.starts_at);
          if (!m.first || t < m.first) m.first = t;
        }
        if (e.ends_at) {
          const t = pragueTime(e.ends_at);
          if (!m.last || t > m.last) m.last = t;
        }
      }

      if (d >= today && d <= weekEnd && e.status !== 'cancelled' && activeIds.has(e.employee)) {
        weekBookedMin += durMin;
      }
    }

    // ── Неделя: капацита (часы салона − блоки) по активным мастерам ──
    let weekCapacityMin = 0;
    try {
      const opParams = new URLSearchParams();
      opParams.append('filter', JSON.stringify({ from: today, to: weekEnd }));
      const opening = await this.noonaGet(`opening_hours?${opParams.toString()}`);
      const blocked = await this.noonaGet(`blocked_times?from=${today}&to=${weekEnd}`);

      const hm = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const openMin = {};
      for (const [date, ws] of Object.entries(opening || {})) {
        openMin[date] = (ws || []).reduce(
          (a, w) => a + Math.max(0, hm(w.ends_at || '0:0') - hm(w.starts_at || '0:0')),
          0
        );
      }
      const blockedMin = new Map();
      for (const b of blocked || []) {
        if (!b.employee || !b.date) continue;
        const key = `${b.employee}|${b.date}`;
        blockedMin.set(key, (blockedMin.get(key) || 0) + (b.duration || 0));
      }
      for (const empId of activeIds) {
        for (const [date, open] of Object.entries(openMin)) {
          const bl = Math.min(blockedMin.get(`${empId}|${date}`) || 0, open);
          weekCapacityMin += Math.max(0, open - bl);
        }
      }
    } catch (e) {
      strapi.log.warn(`digest: week capacity failed: ${e.message}`);
    }

    // ── Strapi: ваучеры, проданные вчера ──
    let vouchersLine = '';
    try {
      const sold = await strapi.documents('api::voucher.voucher').findMany({
        filters: { datePay: yesterday },
        status: 'published',
        limit: 100,
      });
      if (sold.length) {
        const sum = sold.reduce((a, v) => a + (Number(v.sum) || 0), 0);
        vouchersLine = `\n🎁 Ваучеры вчера: ${sold.length} шт · ${fmtMoney(sum)}`;
      }
    } catch (e) {
      strapi.log.warn(`digest: vouchers failed: ${e.message}`);
    }

    // ── Strapi: ошибки на сайте за 24 часа (production) ──
    let errorsLine = '';
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const errs = await strapi.documents('api::client-error-log.client-error-log').findMany({
        filters: { lastSeen: { $gte: since }, environment: 'production' },
        limit: 100,
      });
      if (errs.length) {
        errorsLine = `\n⚠️ Ошибки на сайте за 24ч: ${errs.length}`;
      }
    } catch (e) {
      strapi.log.warn(`digest: error-logs failed: ${e.message}`);
    }

    // ── Сборка сообщения ──
    const weekPct = weekCapacityMin
      ? Math.round((weekBookedMin / weekCapacityMin) * 100)
      : null;

    const masterLines = [...todayByMaster.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, m]) => `• ${name}: ${m.count}${m.first ? ` (${m.first}–${m.last})` : ''}`)
      .join('\n');

    const lines = [
      `<b>Bar.Bitch — дайджест ${fmtDateCz(today)}</b>`,
      '',
      `📅 Вчера (${fmtDateCz(yesterday)}): ${yVisits} визитов · ${fmtMoney(yRevenue)}${
        yNoshow ? ` · no-show: ${yNoshow}` : ''
      }`,
      '',
      `💅 Сегодня броней: ${todayCount}`,
      masterLines || '• записей нет',
    ];
    if (weekPct !== null) {
      lines.push(
        '',
        `📊 Загрузка на 7 дней: ${weekPct} % (занято ${fmtH(weekBookedMin)} из ${fmtH(
          weekCapacityMin
        )})`
      );
    }
    return lines.join('\n') + vouchersLine + errorsLine;
  },

  async sendDigest() {
    const botToken = process.env.TELEGRAM_DIGEST_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_DIGEST_CHAT_ID;
    if (!botToken || !chatId) {
      strapi.log.info('digest: TELEGRAM_DIGEST_BOT_TOKEN/CHAT_ID not set — skipping');
      return { skipped: 'telegram env not configured' };
    }
    if (!process.env.NOONA_TOKEN || !process.env.NOONA_COMPANY_ID) {
      strapi.log.info('digest: NOONA_TOKEN/NOONA_COMPANY_ID not set — skipping');
      return { skipped: 'noona env not configured' };
    }

    const text = await this.buildDigest();
    const res = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) {
      strapi.log.error(`digest: telegram send failed: ${JSON.stringify(data)}`);
      return { ok: false, error: data.description };
    }
    strapi.log.info('digest: sent');
    return { ok: true };
  },
};
