// @ts-nocheck
// Ежедневный Telegram-дайджест владельцу. ОТДЕЛЬНЫЙ бот (не чатовый):
// env TELEGRAM_DIGEST_BOT_TOKEN + TELEGRAM_DIGEST_CHAT_ID.
// Данные Noona: env NOONA_TOKEN + NOONA_COMPANY_ID.
// Без какого-либо из env — тихо пропускает (лог + {skipped}).
//
// Прибыль/разница = ТЕ ЖЕ формулы, что «Результат за месяц» и «Разниця» в админке
// (порт fetchMonthlyResult: getMoney + getAllWorks + getAdminsHours из admin).
// «Смена вчера» = дельта месячного результата против снапшота прошлого дайджеста
// (снапшот в core store) — ровно как «Čistý zisk směny» при закрытии смены.

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
const fmtSigned = (n: number): string => `${n >= 0 ? '+' : ''}${fmtMoney(n)}`;
const fmtH = (min: number): string => `${Math.round((min / 60) * 10) / 10} ч`;

const num = (v): number => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─── порт getRateInfoForMonth (allAdminsHours.ts) ────────────────────────────
const MAX_DATE = new Date(8640000000000000);
const rateForMonth = (rates, monthStart, monthEnd): number => {
  if (!rates || !rates.length) return 115;
  const found = rates.find((r) => {
    const from = r.from ? new Date(r.from) : new Date(0);
    const to = r.to ? new Date(r.to) : MAX_DATE;
    return from <= monthEnd && to >= monthStart;
  });
  if (!found) return 115;
  // hpp: rate = фикс. месячная (НЕ используется), hourlyRate = почасовая; dpp: rate = почасовая
  const raw = found.typeWork === 'hpp' ? found.hourlyRate : found.rate;
  const n = num(raw);
  return n || 115;
};

// summarizeGeneric (fetchHelpers.ts): добавляет sum только СУЩЕСТВУЮЩИМ в map
const addGeneric = (map, items, field, excludeNames = []) => {
  for (const item of items) {
    const name = item.personal?.name;
    if (!name || !map.has(name) || excludeNames.includes(name)) continue;
    map.get(name)[field] += num(item.sum);
  }
};

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

  // ─── «Результат за месяц» + «Разниця» — порт fetchMonthlyResult ────────────
  async computeMonthlyResult() {
    // Месяц по Праге; границы UTC — как getMonthRange в админке
    const [py, pm] = pragueDateStr(0).split('-').map(Number);
    const firstDay = new Date(Date.UTC(py, pm - 1, 1, 0, 0, 0, 0));
    const lastDay = new Date(Date.UTC(py, pm, 0, 23, 59, 59, 999));
    const dateFilter = { $gte: firstDay.toISOString(), $lte: lastDay.toISOString() };

    const find = (uid, params = {}) =>
      strapi.documents(uid).findMany({ status: 'published', limit: 5000, ...params });

    const withPersonal = { filters: { date: dateFilter }, fields: ['sum'], populate: { personal: { fields: ['name'] } } };

    const [
      services,
      penalties,
      extras,
      payrolls,
      advances,
      salaries,
      taxes,
      workTimes,
      costs,
      cardProfits,
      cashs,
      qrPays,
      vouchersRealized,
      vouchersPayed,
      extraProfits,
    ] = await Promise.all([
      find('api::service-provided.service-provided', {
        filters: { date: dateFilter },
        fields: ['staffSalaries', 'salonSalaries', 'tip', 'cash'],
        populate: { personal: { fields: ['name'] } },
      }),
      find('api::penalty.penalty', withPersonal),
      find('api::add-money.add-money', withPersonal),
      find('api::payroll.payroll', withPersonal),
      find('api::avans.avans', withPersonal),
      find('api::salary.salary', withPersonal),
      find('api::tax.tax', withPersonal),
      find('api::work-time.work-time', {
        filters: { start: dateFilter },
        fields: ['sum'],
        populate: {
          personal: {
            fields: ['name'],
            populate: { rates: { fields: ['rate', 'hourlyRate', 'from', 'to', 'typeWork'] } },
          },
        },
      }),
      find('api::cost.cost', { filters: { date: dateFilter }, fields: ['sum', 'noDph'] }),
      find('api::card-profit.card-profit', { filters: { date: dateFilter }, fields: ['sum', 'extraIncome'] }),
      find('api::cash.cash', { filters: { date: dateFilter }, fields: ['profit'] }),
      find('api::qr-pay.qr-pay', { filters: { date: dateFilter }, fields: ['sum'] }),
      find('api::voucher.voucher', { filters: { dateRealized: dateFilter }, fields: ['sum'] }),
      find('api::voucher.voucher', { filters: { datePay: dateFilter }, fields: ['sum'] }),
      find('api::extra-profit.extra-profit', { filters: { date: dateFilter }, fields: ['sum'] }),
    ]);

    // ── getAllWorks: мастера ──
    const masters = new Map();
    let globalFlow = 0;
    for (const s of services) {
      const name = s.personal?.name;
      if (!name) continue;
      const staff = num(s.staffSalaries);
      const tip = num(s.tip);
      globalFlow += staff + num(s.salonSalaries) + tip;
      if (!masters.has(name)) {
        masters.set(name, { sum: 0, sumTip: 0, penalty: 0, extraProfit: 0, payrolls: 0, advance: 0, salaries: 0, taxes: 0 });
      }
      const m = masters.get(name);
      m.sum += staff;
      m.sumTip += tip;
    }
    const exclMasters = ['Oleksandra Fishchuk'];
    addGeneric(masters, penalties, 'penalty', exclMasters);
    addGeneric(masters, extras, 'extraProfit', exclMasters);
    addGeneric(masters, payrolls, 'payrolls', exclMasters);
    addGeneric(masters, advances, 'advance', exclMasters);
    addGeneric(masters, salaries, 'salaries', exclMasters);
    addGeneric(masters, taxes, 'taxes');
    let sumMasters = 0;
    let visitCount = 0;
    for (const m of masters.values()) {
      sumMasters += m.sum + m.sumTip + m.extraProfit - m.penalty - m.payrolls;
    }
    visitCount = services.length;

    // ── getAdminsHours: администраторы ──
    const admins = new Map();
    for (const w of workTimes) {
      const name = w.personal?.name;
      if (!name) continue;
      if (!admins.has(name)) {
        admins.set(name, {
          sum: 0,
          penalty: 0,
          extraProfit: 0,
          payrolls: 0,
          advance: 0,
          salaries: 0,
          taxes: 0,
          rate: rateForMonth(w.personal?.rates, firstDay, lastDay),
        });
      }
      admins.get(name).sum += num(w.sum);
    }
    const exclAdmins = ['Mariia Medvedeva'];
    addGeneric(admins, penalties, 'penalty', exclAdmins);
    addGeneric(admins, extras, 'extraProfit', exclAdmins);
    addGeneric(admins, payrolls, 'payrolls', exclAdmins);
    addGeneric(admins, advances, 'advance', exclAdmins);
    addGeneric(admins, salaries, 'salaries', exclAdmins);
    addGeneric(admins, taxes, 'taxes');
    let sumAdmins = 0;
    for (const a of admins.values()) {
      sumAdmins += a.sum * a.rate + a.extraProfit - a.penalty - a.payrolls;
    }

    // ── getMoney ──
    const sumOf = (arr, field = 'sum') => arr.reduce((acc, x) => acc + num(x[field]), 0);
    const cashMoney = cashs.reduce((max, c) => Math.max(max, num(c.profit)), 0); // кумулятив в месяце → max
    const cardMoney = sumOf(cardProfits);
    const cardExtraIncome = sumOf(cardProfits, 'extraIncome');
    const qrMoney = sumOf(qrPays);
    const sumNoDphCosts = sumOf(costs, 'noDph');
    const taxesSum = sumOf(taxes);
    const payrollSum = sumOf(payrolls);
    const voucherRealizedSum = sumOf(vouchersRealized);
    const voucherPayedSum = sumOf(vouchersPayed);
    const extraMoneySum = sumOf(extraProfits);

    const result =
      cashMoney + cardExtraIncome + (cardMoney + qrMoney) / 1.21 - sumMasters - sumAdmins - sumNoDphCosts - taxesSum;

    const difference =
      cardMoney + cardExtraIncome + cashMoney + payrollSum + voucherRealizedSum + qrMoney -
      globalFlow - extraMoneySum - voucherPayedSum;

    return {
      monthKey: `${py}-${String(pm).padStart(2, '0')}`,
      result: Math.round(result),
      difference: Math.round(difference),
      visitCount,
    };
  },

  // ─── снапшот для дневных дельт (core store) ────────────────────────────────
  store() {
    return strapi.store({ type: 'api', name: 'digest' });
  },

  async buildDigest(updateSnapshot = true): Promise<string> {
    const yesterday = pragueDateStr(-1);
    const today = pragueDateStr(0);
    const weekEnd = pragueDateStr(6);
    const dayAfterWeekEnd = pragueDateStr(7);

    // ── Финансы: месячный результат + дельты против прошлого дайджеста ──
    let financeLines = [];
    try {
      const current = await this.computeMonthlyResult();
      const snap = await this.store().get({ key: 'snapshot' });

      if (snap && snap.monthKey === current.monthKey && snap.date < today) {
        const dayProfit = current.result - snap.result;
        const dayDiff = current.difference - snap.difference;
        const dayVisits = current.visitCount - (snap.visitCount ?? 0);
        financeLines = [
          `💰 Смена вчера: <b>${fmtSigned(dayProfit)}</b>${dayVisits > 0 ? ` · ${dayVisits} визитов` : ''}`,
          `📈 Результат месяца: <b>${fmtMoney(current.result)}</b>`,
          `⚖️ Разница (недостача): <b>${fmtMoney(current.difference)}</b>${
            Math.round(dayDiff) !== 0 ? ` (за вчера ${fmtSigned(dayDiff)})` : ' (без изменений)'
          }`,
        ];
      } else {
        financeLines = [
          `📈 Результат месяца: <b>${fmtMoney(current.result)}</b>`,
          `⚖️ Разница (недостача): <b>${fmtMoney(current.difference)}</b>`,
          snap && snap.monthKey !== current.monthKey
            ? '(новый месяц — дельты смены появятся завтра)'
            : '(первый дайджест — дельты смены появятся завтра)',
        ];
      }

      // снапшот обновляем максимум раз в день — повторные ручные вызовы не сбивают дельты
      if (updateSnapshot && (!snap || snap.date < today || snap.monthKey !== current.monthKey)) {
        await this.store().set({ key: 'snapshot', value: { date: today, ...current } });
      }
    } catch (e) {
      strapi.log.warn(`digest: finance failed: ${e.message}`);
      financeLines = ['💰 Финансы: не удалось посчитать'];
    }

    // ── Noona: сотрудники + события [вчера .. +7 дней] + история год назад ──
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

    const yearAgo = pragueDateStr(-365);
    const eventsParams = new URLSearchParams();
    eventsParams.append(
      'filter',
      JSON.stringify({
        from: `${yearAgo}T00:00:00.000Z`,
        to: `${dayAfterWeekEnd}T23:59:59.999Z`,
      })
    );
    for (const f of [
      'customer',
      'customer_name',
      'employee',
      'status',
      'event_date',
      'starts_at',
      'ends_at',
      'created_at',
      'event_types.price',
    ]) {
      eventsParams.append('select', f);
    }
    const events = (await this.noonaGet(`events?${eventsParams.toString()}`)) || [];

    // ── Сегодня: брони по мастерам + оценка оборота/доли салона ──
    const todayByMaster = new Map();
    let todayCount = 0;
    let todayTurnover = 0;
    let todaySalonShare = 0;
    let weekBookedMin = 0;
    const todayBookings = []; // для проверки подозрительных
    const historyByCustomer = new Map(); // customer → [{date, status}]
    const activeByCustomer = new Map(); // customer → Set активных дат (не cancelled, будущее окно)

    // карта мастер → ratePercent из Strapi (для доли салона)
    const rateByEmployee = new Map();
    try {
      const personals = await strapi.documents('api::personal.personal').findMany({
        status: 'published',
        limit: 200,
        fields: ['noonaEmployeeId', 'ratePercent'],
      });
      for (const p of personals) {
        if (p.noonaEmployeeId) rateByEmployee.set(p.noonaEmployeeId, num(p.ratePercent) || 40);
      }
    } catch (e) {
      strapi.log.warn(`digest: personals failed: ${e.message}`);
    }

    for (const e of events) {
      const d = e.event_date;
      if (!d) continue;
      const price = e.event_types?.[0]?.price?.amount ?? 0;
      const durMin =
        e.starts_at && e.ends_at
          ? Math.max(0, (new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000)
          : 0;

      // история клиента (прошлое, без отменённых — для проверки no-show)
      if (e.customer && d < today && e.status !== 'cancelled') {
        if (!historyByCustomer.has(e.customer)) historyByCustomer.set(e.customer, []);
        historyByCustomer.get(e.customer).push({ date: d, status: e.status });
      }
      // активные брони рядом с сегодня (для дублей ±3 дня)
      if (e.customer && e.status !== 'cancelled' && d >= pragueDateStr(-3) && d <= pragueDateStr(3)) {
        if (!activeByCustomer.has(e.customer)) activeByCustomer.set(e.customer, new Set());
        activeByCustomer.get(e.customer).add(d);
      }

      if (d === today && e.status !== 'cancelled') {
        todayCount++;
        todayTurnover += price;
        const rate = rateByEmployee.get(e.employee) ?? 40;
        todaySalonShare += price * (1 - rate / 100);
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
        todayBookings.push(e);
      }

      if (d >= today && d <= weekEnd && e.status !== 'cancelled' && activeIds.has(e.employee)) {
        weekBookedMin += durMin;
      }
    }

    // ── Подозрительные записи на сегодня ──
    let suspiciousLines = [];
    try {
      // телефоны из customers (все одним запросом)
      const customersRaw = await this.noonaGet(
        'customers?select=id&select=phone_country_code&select=phone_number'
      );
      const phoneById = new Map();
      for (const c of customersRaw || []) {
        if (c.id && c.phone_number) {
          phoneById.set(c.id, `+${c.phone_country_code || '420'}${c.phone_number}`);
        }
      }

      const seen = new Set();
      const msDay = 86400000;
      for (const b of todayBookings) {
        if (!b.customer || seen.has(b.customer)) continue;
        const reasons = [];

        // 1) no-show среди ПОСЛЕДНИХ 5 визитов (прошлый раз — главный флаг)
        const hist = (historyByCustomer.get(b.customer) || []).sort((a, x) =>
          a.date < x.date ? -1 : 1
        );
        if (hist.length) {
          const last5 = hist.slice(-5);
          const last = last5[last5.length - 1];
          const noshowCount = last5.filter((h) => h.status === 'noshow').length;
          if (last.status === 'noshow') {
            reasons.push(
              `прошлый раз no-show${noshowCount > 1 ? ` (${noshowCount}× из последних ${last5.length})` : ''}`
            );
          } else if (noshowCount >= 2) {
            reasons.push(`${noshowCount}× no-show из последних ${last5.length} визитов`);
          }
        }

        // 2) бронь создана > 10 дней назад
        if (b.created_at) {
          const ageDays = Math.floor((Date.now() - new Date(b.created_at).getTime()) / msDay);
          if (ageDays > 10) reasons.push(`бронь создана ${ageDays} дн. назад`);
        }

        // 3) есть ещё активная запись в ±3 дня
        const near = [...(activeByCustomer.get(b.customer) || [])].filter((d) => d !== today);
        if (near.length) {
          reasons.push(`ещё запись ${near.map((d) => fmtDateCz(d).slice(0, 5)).join(', ')}`);
        }

        if (reasons.length) {
          seen.add(b.customer);
          const phone = phoneById.get(b.customer);
          const time = b.starts_at ? ` ${pragueTime(b.starts_at)}` : '';
          suspiciousLines.push(
            `• ${b.customer_name || '—'}${time}${phone ? ` · ${phone}` : ''} — ${reasons.join('; ')}`
          );
        }
      }
      suspiciousLines = suspiciousLines.slice(0, 12);
    } catch (e) {
      strapi.log.warn(`digest: suspicious failed: ${e.message}`);
    }

    // ── Неделя: капацита (часы салона − блоки) по активным мастерам ──
    let weekCapacityMin = 0;
    try {
      const opParams = new URLSearchParams();
      opParams.append('filter', JSON.stringify({ from: today, to: weekEnd }));
      const opening = await this.noonaGet(`opening_hours?${opParams.toString()}`);
      const blocked = await this.noonaGet(`blocked_times?from=${today}&to=${weekEnd}`);

      const hm = (s) => {
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
        const sum = sold.reduce((a, v) => a + num(v.sum), 0);
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
    const weekPct = weekCapacityMin ? Math.round((weekBookedMin / weekCapacityMin) * 100) : null;

    const masterLines = [...todayByMaster.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, m]) => `• ${name}: ${m.count}${m.first ? ` (${m.first}–${m.last})` : ''}`)
      .join('\n');

    const lines = [
      `<b>Bar.Bitch — дайджест ${fmtDateCz(today)}</b>`,
      '',
      ...financeLines,
      '',
      `💅 Сегодня броней: ${todayCount} · оборот ~${fmtMoney(todayTurnover)} · салону ~${fmtMoney(todaySalonShare)}`,
      masterLines || '• записей нет',
    ];
    if (suspiciousLines.length) {
      lines.push('', '🚩 Подозрительные записи сегодня:', ...suspiciousLines);
    }
    if (weekPct !== null) {
      lines.push(
        '',
        `📊 Загрузка на 7 дней: ${weekPct} % (занято ${fmtH(weekBookedMin)} из ${fmtH(weekCapacityMin)})`
      );
    }
    return lines.join('\n') + vouchersLine + errorsLine;
  },

  async sendDigest(updateSnapshot = true) {
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

    const text = await this.buildDigest(updateSnapshot);
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
