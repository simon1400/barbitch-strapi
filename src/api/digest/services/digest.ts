// @ts-nocheck
// Ежедневный Telegram-дайджест администратору. ОТДЕЛЬНЫЙ бот (не чатовый):
// env TELEGRAM_DIGEST_BOT_TOKEN + TELEGRAM_DIGEST_CHAT_ID.
// Данные Noona: env NOONA_TOKEN + NOONA_COMPANY_ID.
// Без какого-либо из env — тихо пропускает (лог + {skipped}).
//
// Дайджест ОПЕРАЦИОННЫЙ (для администратора в начале смены): рабочий день,
// брони по мастерам, новые клиенты, подозрительные записи, свободные окна для
// дозаписи, загрузка на неделю. Финансовых метрик владельца здесь НЕТ.

const TELEGRAM_API = 'https://api.telegram.org/bot';
const NOONA_BASE = 'https://api.noona.is/v1/hq/companies';

const MIN_GAP = 30; // минимальное окно (мин), которое показываем как «свободное» для дозаписи
const VIP_VISITS = 10; // ≥ стольких успешных визитов → клиент «постоянный»

// Экранирование для parse_mode=HTML (имена/комментарии — свободный текст)
const esc = (s): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

const fmtH = (min: number): string => `${Math.round((min / 60) * 10) / 10} год`;

const hhmmToMin = (s: string): number => {
  const [h, m] = (s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

// ISO → минуты от полуночи В ПРАГЕ. Сервер в UTC, поэтому через Intl (НЕ getHours).
const isoToMinPrague = (iso: string): number => hhmmToMin(pragueTime(iso));

const minToHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

// Категория услуги по названию (порт classifyTitle из admin/windowCrossSell.ts):
// «řas»→ресницы (проверяем ПЕРВЫМ), «obočí»/laminace…→брови, ногтевые ключи→ногти.
// ⚠️ При новых категориях в Noona — дополнить ключевые слова.
const NAIL_KEYS = ['nehty', 'manikúra', 'manikura', 'gel lak', 'prodloužení neht', 'nano', 'sundání', 'hygienick', 'ibx'];
const classifyCategory = (raw: string): string | null => {
  const t = (raw || '').toLowerCase();
  if (t.includes('řas') || t.includes('rias') || t.includes('lash')) return 'Вії';
  if (
    t.includes('obočí') || t.includes('oboci') || t.includes('brow') ||
    t.includes('barvení a péče') || t.includes('laminace') ||
    t.includes('úprava tvaru') || t.includes('uprava tvaru')
  )
    return 'Брови';
  if (NAIL_KEYS.some((k) => t.includes(k))) return 'Нігті';
  return null;
};

// Вычитание занятых интервалов из окна → свободные куски (минуты от полуночи)
const subtractBusy = (
  winStart: number,
  winEnd: number,
  busy: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> => {
  const sorted = busy
    .filter((b) => b.end > winStart && b.start < winEnd)
    .sort((a, b) => a.start - b.start);
  const free = [];
  let cursor = winStart;
  for (const b of sorted) {
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, winEnd) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= winEnd) break;
  }
  if (cursor < winEnd) free.push({ start: cursor, end: winEnd });
  return free;
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

  async buildDigest(): Promise<string> {
    const today = pragueDateStr(0);
    const weekEnd = pragueDateStr(6);
    const dayAfterWeekEnd = pragueDateStr(7);

    // ── Noona: сотрудники + события [год назад .. +7 дней] ──
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
      'event_types.title',
      'comment',
      'customer_comment',
    ]) {
      eventsParams.append('select', f);
    }
    const events = (await this.noonaGet(`events?${eventsParams.toString()}`)) || [];

    // ── Один проход по событиям ──
    const todayByMaster = new Map();
    let todayCount = 0;
    let weekBookedMin = 0;
    const todayBookings = []; // для проверки подозрительных + новых клиентов
    const busyTodayByEmp = new Map(); // empId → [{start,end}] брони сегодня (для окон)
    const historyByCustomer = new Map(); // customer → [{date, status}] (прошлое, без cancelled)
    const fullHistoryByCustomer = new Map(); // customer → [{date, status}] (прошлое, ВКЛ. cancelled)
    const activeByCustomer = new Map(); // customer → [{date, category}] активных броней (±3 дня)

    const near3From = pragueDateStr(-3);
    const near3To = pragueDateStr(3);

    for (const e of events) {
      const d = e.event_date;
      if (!d) continue;
      const durMin =
        e.starts_at && e.ends_at
          ? Math.max(0, (new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000)
          : 0;

      // история клиента (прошлое, без отменённых) — для no-show и «новых клиентов»
      if (e.customer && d < today && e.status !== 'cancelled') {
        if (!historyByCustomer.has(e.customer)) historyByCustomer.set(e.customer, []);
        historyByCustomer.get(e.customer).push({ date: d, status: e.status });
      }
      // полная история (вкл. отменённые) — для правила «последние 3 записи отменены»
      if (e.customer && d < today) {
        if (!fullHistoryByCustomer.has(e.customer)) fullHistoryByCustomer.set(e.customer, []);
        fullHistoryByCustomer.get(e.customer).push({ date: d, status: e.status });
      }
      // активные брони рядом с сегодня (для дублей ±3 дня в одной категории)
      if (e.customer && e.status !== 'cancelled' && d >= near3From && d <= near3To) {
        if (!activeByCustomer.has(e.customer)) activeByCustomer.set(e.customer, []);
        activeByCustomer.get(e.customer).push({ date: d, category: classifyCategory(e.event_types?.[0]?.title) });
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
        todayBookings.push(e);
        // занятый интервал мастера сегодня (для расчёта окон)
        if (e.employee && e.starts_at && e.ends_at) {
          if (!busyTodayByEmp.has(e.employee)) busyTodayByEmp.set(e.employee, []);
          busyTodayByEmp
            .get(e.employee)
            .push({ start: isoToMinPrague(e.starts_at), end: isoToMinPrague(e.ends_at) });
        }
      }

      if (d >= today && d <= weekEnd && e.status !== 'cancelled' && activeIds.has(e.employee)) {
        weekBookedMin += durMin;
      }
    }

    // ── Новые клиенты / постоянные (VIP) / комментарии — по сегодняшним броням ──
    const newClientLines = [];
    const vipLines = [];
    const commentLines = [];
    const seenNew = new Set();
    const seenVip = new Set();
    const seenComment = new Set();
    for (const b of todayBookings) {
      if (!b.customer) continue;
      const time = b.starts_at ? ` · <i>${pragueTime(b.starts_at)}</i>` : '';
      const name = esc(b.customer_name || '—');

      // новый клиент = нет визитов (без cancelled) за прошлый год
      if (!historyByCustomer.has(b.customer) && !seenNew.has(b.customer)) {
        seenNew.add(b.customer);
        newClientLines.push(`• <b>${name}</b>${time}`);
      }

      // постоянный = ≥ VIP_VISITS успешных визитов (не no-show)
      if (!seenVip.has(b.customer)) {
        const attended = (historyByCustomer.get(b.customer) || []).filter(
          (h) => h.status !== 'noshow'
        ).length;
        if (attended >= VIP_VISITS) {
          seenVip.add(b.customer);
          vipLines.push(`• <b>${name}</b>${time} · ${attended} візитів`);
        }
      }

      // комментарии к записи (заметка персонала + комментарий клиента)
      if (!seenComment.has(b.customer)) {
        const txt = [b.comment, b.customer_comment]
          .map((s) => (s ? String(s).trim() : ''))
          .filter(Boolean)
          .join(' / ');
        if (txt) {
          seenComment.add(b.customer);
          commentLines.push(`• <b>${name}</b>${time}\n      ${esc(txt.slice(0, 160))}`);
        }
      }
    }
    const commentLinesCapped = commentLines.slice(0, 15);

    // ── Подозрительные записи на сегодня ──
    let suspiciousLines = [];
    try {
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

        const hist = (historyByCustomer.get(b.customer) || []).sort((a, x) =>
          a.date < x.date ? -1 : 1
        );
        // успешные прошлые визиты = не no-show (история уже без cancelled)
        const successfulPast = hist.filter((h) => h.status !== 'noshow').length;

        // 1) no-show хотя бы раз среди ПОСЛЕДНИХ 3 визитов → флаг
        const last3 = hist.slice(-3);
        const noshow3 = last3.filter((h) => h.status === 'noshow').length;
        if (noshow3 > 0) {
          reasons.push(`неявка в останніх 3 візитах${noshow3 > 1 ? ` (${noshow3}×)` : ''}`);
        }

        // 2) бронь создана > 15 дней назад, НО не флагаем «надёжных» (≥2 успешных визита)
        if (b.created_at) {
          const ageDays = Math.floor((Date.now() - new Date(b.created_at).getTime()) / msDay);
          if (ageDays > 15 && successfulPast < 2) {
            reasons.push(`бронювання створено ${ageDays} дн. тому`);
          }
        }

        // 3) ещё активная запись ТОЙ ЖЕ категории в ±3 дня (Ногти/Брови/Ресницы)
        const bCat = classifyCategory(b.event_types?.[0]?.title);
        if (bCat) {
          const nearDates = [
            ...new Set(
              (activeByCustomer.get(b.customer) || [])
                .filter((x) => x.date !== today && x.category === bCat)
                .map((x) => x.date)
            ),
          ];
          if (nearDates.length) {
            reasons.push(
              `ще запис «${bCat}» ${nearDates.map((d) => fmtDateCz(d).slice(0, 5)).join(', ')}`
            );
          }
        }

        // 4) последние 3 записи клиента — все отменённые
        const allHist = (fullHistoryByCustomer.get(b.customer) || []).sort((a, x) =>
          a.date < x.date ? -1 : 1
        );
        const last3all = allHist.slice(-3);
        if (last3all.length === 3 && last3all.every((h) => h.status === 'cancelled')) {
          reasons.push('останні 3 записи скасовано');
        }

        // 5) частый отменщик — высокая доля отмен за всю историю (≥4 брони, >50%)
        const cancelledAll = allHist.filter((h) => h.status === 'cancelled').length;
        if (allHist.length >= 4 && cancelledAll / allHist.length > 0.5) {
          reasons.push(`часто скасовує (${cancelledAll} з ${allHist.length} записів)`);
        }

        if (reasons.length) {
          seen.add(b.customer);
          const phone = phoneById.get(b.customer);
          const time = b.starts_at ? ` · <i>${pragueTime(b.starts_at)}</i>` : '';
          suspiciousLines.push(
            `<b>${esc(b.customer_name || '—')}</b>${time}${phone ? ` · <code>${phone}</code>` : ''}\n      ⚠ ${reasons.join('; ')}`
          );
        }
      }
      suspiciousLines = suspiciousLines.slice(0, 12);
    } catch (e) {
      strapi.log.warn(`digest: suspicious failed: ${e.message}`);
    }

    // ── Кто сегодня не работает (отпуск/больничный) — Strapi time-off ──
    const offTodayLines = [];
    try {
      const TYPE_LABEL = { sick: 'лікарняний', vacation: 'відпустка', personal: 'особистий' };
      const offs = await strapi.documents('api::time-off.time-off').findMany({
        filters: { startDate: { $lte: today }, endDate: { $gte: today } },
        limit: 100,
        populate: { personal: { fields: ['name'] } },
      });
      for (const o of offs || []) {
        const name = o.personal?.name;
        if (!name) continue;
        offTodayLines.push(`• <b>${esc(name)}</b> — ${TYPE_LABEL[o.type] || o.type}`);
      }
    } catch (e) {
      strapi.log.warn(`digest: time-off failed: ${e.message}`);
    }

    // ── Часы салона + загрузка недели + свободные окна сегодня ──
    let workdayLine = '🕐 Робочий день: —';
    let weekCapacityMin = 0;
    const gapLines = [];
    try {
      const opParams = new URLSearchParams();
      opParams.append('filter', JSON.stringify({ from: today, to: weekEnd }));
      const opening = (await this.noonaGet(`opening_hours?${opParams.toString()}`)) || {};
      const blocked = (await this.noonaGet(`blocked_times?from=${today}&to=${weekEnd}`)) || [];

      // часы салона + капацита недели (по длительности блоков)
      const openMin = {};
      for (const [date, ws] of Object.entries(opening)) {
        openMin[date] = (ws || []).reduce(
          (a, w) => a + Math.max(0, hhmmToMin(w.ends_at || '0:0') - hhmmToMin(w.starts_at || '0:0')),
          0
        );
      }
      const blockedDurByEmp = new Map();
      for (const b of blocked) {
        if (!b.employee || !b.date) continue;
        const key = `${b.employee}|${b.date}`;
        blockedDurByEmp.set(key, (blockedDurByEmp.get(key) || 0) + (b.duration || 0));
      }
      for (const empId of activeIds) {
        for (const [date, open] of Object.entries(openMin)) {
          const bl = Math.min(blockedDurByEmp.get(`${empId}|${date}`) || 0, open);
          weekCapacityMin += Math.max(0, open - bl);
        }
      }

      // рабочий день сегодня (мин старт — макс конец часов салона)
      const todayWindows = opening[today] || [];
      if (todayWindows.length) {
        const starts = todayWindows.map((w) => hhmmToMin(w.starts_at || '0:0'));
        const ends = todayWindows.map((w) => hhmmToMin(w.ends_at || '0:0'));
        workdayLine = `🕐 Робочий день: ${minToHHMM(Math.min(...starts))}–${minToHHMM(Math.max(...ends))}`;
      } else {
        workdayLine = '🕐 Сьогодні немає робочих годин салону';
      }

      // свободные окна сегодня по активным мастерам (блоки + брони → дыры ≥ MIN_GAP)
      const blockIntervalsByEmp = new Map();
      for (const b of blocked) {
        if (b.date !== today || !b.employee || !b.starts_at || !b.ends_at) continue;
        if (!blockIntervalsByEmp.has(b.employee)) blockIntervalsByEmp.set(b.employee, []);
        blockIntervalsByEmp
          .get(b.employee)
          .push({ start: isoToMinPrague(b.starts_at), end: isoToMinPrague(b.ends_at) });
      }
      for (const empId of activeIds) {
        if (!todayWindows.length) break;
        const busy = [
          ...(busyTodayByEmp.get(empId) || []),
          ...(blockIntervalsByEmp.get(empId) || []),
        ];
        const gaps = [];
        for (const w of todayWindows) {
          if (!w.starts_at || !w.ends_at) continue;
          for (const f of subtractBusy(hhmmToMin(w.starts_at), hhmmToMin(w.ends_at), busy)) {
            if (f.end - f.start >= MIN_GAP) gaps.push(`${minToHHMM(f.start)}–${minToHHMM(f.end)}`);
          }
        }
        if (gaps.length) gapLines.push(`• <b>${empNames.get(empId) || empId}</b>: ${gaps.join(', ')}`);
      }
    } catch (e) {
      strapi.log.warn(`digest: schedule failed: ${e.message}`);
    }

    // ── Сборка сообщения ──
    const weekPct = weekCapacityMin ? Math.round((weekBookedMin / weekCapacityMin) * 100) : null;

    const masterLines = [...todayByMaster.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(
        ([name, m]) =>
          `• <b>${name}</b> — ${m.count} ${m.count === 1 ? 'запис' : m.count < 5 ? 'записи' : 'записів'}${
            m.first ? ` · <i>${m.first}–${m.last}</i>` : ''
          }`
      )
      .join('\n');

    const lines = [
      `<b>Bar.Bitch — дайджест ${fmtDateCz(today)}</b>`,
      '',
      workdayLine,
      `💅 Сьогодні записів: <b>${todayCount}</b>`,
      masterLines || '• записів немає',
    ];
    if (offTodayLines.length) {
      lines.push('', '🏖 <b>Сьогодні не працюють:</b>', offTodayLines.join('\n'));
    }
    if (newClientLines.length) {
      lines.push('', '✨ <b>Нові клієнти сьогодні:</b>', newClientLines.join('\n'));
    }
    if (vipLines.length) {
      lines.push('', '⭐ <b>Постійні клієнти сьогодні:</b>', vipLines.join('\n'));
    }
    if (commentLinesCapped.length) {
      lines.push('', '💬 <b>Записи з коментарем:</b>', commentLinesCapped.join('\n'));
    }
    if (suspiciousLines.length) {
      lines.push('', '🚩 <b>Підозрілі записи сьогодні:</b>', '', suspiciousLines.join('\n\n'));
    }
    if (gapLines.length) {
      lines.push('', '🪟 <b>Вільні вікна сьогодні (дозапис):</b>', gapLines.join('\n'));
    }
    if (weekPct !== null) {
      lines.push(
        '',
        `📊 Завантаження на 7 днів вперед (${fmtDateCz(today).slice(0, 5)}–${fmtDateCz(weekEnd).slice(0, 5)}): ${weekPct} % (зайнято ${fmtH(weekBookedMin)} з ${fmtH(weekCapacityMin)})`
      );
    }
    return lines.join('\n');
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
