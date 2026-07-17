// @ts-nocheck
// Самопроверка смены для АДМИНИСТРАТОРОВ (виджет на дашборде Strapi).
//
// Read-only: показывает только то, что админ может ИСПРАВИТЬ в своих записях за
// СЕГОДНЯ — без публикации, без ввода карты, без финметрик владельца (зарплаты/
// прибыль/оборот). Это «облегчённая» проверка, повторяющая check-часть модуля
// «Uzavření směny» (admin/.../shiftClose.ts) — но всё считается из сегодняшних
// черновиков + броней НАШЕГО календаря (booking), БЕЗ месячного финансового движка.
//
// Что показывает:
//   1. rozdil  — Σ по сегодняшним услугам (staff+salon − offerPrice×(1−sleva)).
//                ≥0 → «v pořádku» (показываем 0), <0 → недостача (показываем минус).
//   2. flagged — записи с неверными суммами (ztrata/salon_up/mistr_up/mistr_down) + Δ Kč.
//   3. calendar — клиенты, которых не записали в Strapi / лишние-опечатки
//                 (сверка календарь↔services-provided).
//   4. service — услуга в записи ≠ услуга клиента в календаре.
//   5. missing — нет записей кассы / часов / услуг за сегодня.

const SP_UID = 'api::service-provided.service-provided';
const CASH_UID = 'api::cash.cash';
const WORKTIME_UID = 'api::work-time.work-time';
const BOOKING_UID = 'api::booking.booking';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' в часовом поясе Праги (сервер в UTC).
const pragueToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());

// --- Money math: 1:1 зеркало lifecycles.ts / shiftClose.ts -------------------

// Цены строками; junior-цены (−20%) бывают с запятой ("237,6"). Number("237,6")=NaN.
const toNum = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Скидка → доля 0..1 от полной цены. Процент ("20%","20","0.2") или кроны ("400"):
// процент не может быть >100, поэтому значения >100 трактуем как кроны.
const parseSaleRate = (raw: unknown, offerPrice: number): number => {
  let n = 0;
  if (typeof raw === 'number') n = Number.isFinite(raw) ? raw : 0;
  else if (typeof raw === 'string') {
    const m = raw.match(/(-?\d+(?:[.,]\d+)?)/);
    n = m ? parseFloat(m[1].replace(',', '.')) : 0;
  }
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return offerPrice > 0 ? Math.min(n / offerPrice, 1) : 0;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

const computeMustValues = (offerPrice: number, ratePercent: number, sale: unknown) => {
  const discountRate = parseSaleRate(sale, offerPrice);
  const hasSale = discountRate > 0;
  const mustStaff = offerPrice * (ratePercent / 100);
  const mustSalonNow = hasSale
    ? offerPrice * (1 - discountRate) - mustStaff
    : offerPrice - mustStaff;
  return { mustStaff, mustSalonNow, hasSale, discountRate };
};

type VerifyFlag = 'ok' | 'sleva' | 'ztrata' | 'salon_up' | 'mistr_up' | 'mistr_down' | 'internal';

// Проблемные флаги, которые админу нужно проверить (без ok/sleva/internal).
const PROBLEM_FLAGS: VerifyFlag[] = ['ztrata', 'salon_up', 'mistr_up', 'mistr_down'];

const FLAG_META: Record<VerifyFlag, { emoji: string; label: string }> = {
  ok: { emoji: '🟩', label: 'OK' },
  sleva: { emoji: '🟦', label: 'Sleva' },
  ztrata: { emoji: '🟥', label: 'Ztráta salonu' },
  salon_up: { emoji: '🟪', label: 'Salon dostal víc' },
  mistr_up: { emoji: '🟨', label: 'Mistr dostal víc' },
  mistr_down: { emoji: '🟨', label: 'Mistr dostal míň' },
  internal: { emoji: '🤝', label: 'Interní služba' },
};

const computeFlags = (
  offerPrice: number,
  ratePercent: number,
  staffSalaries: number,
  salonSalaries: number,
  sale: unknown,
  internal: boolean,
): VerifyFlag[] => {
  const { mustStaff, mustSalonNow, hasSale } = computeMustValues(offerPrice, ratePercent, sale);
  const rStaff = r2(staffSalaries);
  const rMustStaff = r2(mustStaff);
  if (internal) {
    const f: VerifyFlag[] = ['internal'];
    if (rStaff > rMustStaff) f.push('mistr_up');
    if (rStaff < rMustStaff) f.push('mistr_down');
    return f;
  }
  const rSalon = r2(salonSalaries);
  const rMustSalon = r2(mustSalonNow);
  const f: VerifyFlag[] = [];
  if (rStaff > rMustStaff) f.push('mistr_up');
  if (rStaff < rMustStaff) f.push('mistr_down');
  if (rSalon > rMustSalon) f.push('salon_up');
  if (rSalon < rMustSalon) f.push('ztrata');
  if (hasSale) f.push('sleva');
  if (f.length === 0) f.push('ok');
  return f;
};

const flagsOf = (item: any): VerifyFlag[] => {
  // Предпочитаем сохранённые verifyFlags (как getItemFlags в admin), иначе считаем.
  const stored = Array.isArray(item?.verifyFlags) ? item.verifyFlags : null;
  if (stored && stored.length > 0) {
    return stored.filter((x: unknown): x is VerifyFlag =>
      typeof x === 'string' && x in FLAG_META,
    );
  }
  const offerPrice = Number(item?.offer?.price);
  const ratePercent = Number(item?.personal?.ratePercent);
  if (Number.isFinite(offerPrice) && Number.isFinite(ratePercent) && offerPrice > 0) {
    return computeFlags(
      offerPrice,
      ratePercent,
      toNum(item?.staffSalaries),
      toNum(item?.salonSalaries),
      item?.sale,
      Boolean(item?.internal),
    );
  }
  return [];
};

// --- Name / title normalization (зеркало helpers.ts) -------------------------

const normalize = (name: string) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

const normalizeTitle = (t: string) =>
  normalize(t)
    .replace(/^юниор\s+/, '')
    .replace(/\s*\+\s*/g, ' + ');

// Multiset-разница имён клиентов: кто есть только в Strapi / только в календаре.
const diffByName = (strapiItems: any[], calendarEvents: any[]) => {
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    arr.forEach((n) => m.set(n, (m.get(n) || 0) + 1));
    return m;
  };
  const calendarNames = calendarEvents.map((e: any) => normalize(e.customer_name || ''));
  const strapiNames = strapiItems.map((i: any) => normalize(i.clientName || ''));
  const nCount = count(calendarNames);
  const sCount = count(strapiNames);

  const onlyStrapi: string[] = [];
  sCount.forEach((c, name) => {
    const diff = c - (nCount.get(name) || 0);
    for (let i = 0; i < diff; i++) onlyStrapi.push(name);
  });
  const onlyCalendar: string[] = [];
  nCount.forEach((c, name) => {
    const diff = c - (sCount.get(name) || 0);
    for (let i = 0; i < diff; i++) onlyCalendar.push(name);
  });

  // Возвращаем оригинальные (не нормализованные) имена для показа.
  const pickNames = (norms: string[], src: any[], key: string) => {
    const used = new Set<number>();
    return norms
      .map((nm) => {
        const idx = src.findIndex(
          (x: any, i: number) => !used.has(i) && normalize(x[key] || '') === nm,
        );
        if (idx >= 0) {
          used.add(idx);
          return (src[idx][key] || '').trim();
        }
        return nm;
      })
      .filter(Boolean);
  };

  return {
    strapiExtra: pickNames(onlyStrapi, strapiItems, 'clientName'),
    calendarExtra: pickNames(onlyCalendar, calendarEvents, 'customer_name'),
  };
};

// Услуга в записи ≠ услуга клиента в календаре (offer.title vs event_types[0].title).
const offerMismatches = (items: any[], events: any[]) => {
  const buckets = new Map<string, { title: string; used: boolean }[]>();
  for (const e of events) {
    const key = normalize(e.customer_name || '');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ title: e.event_types?.[0]?.title || '', used: false });
  }
  const out: { client: string; strapi: string; calendar: string }[] = [];
  for (const item of items) {
    const strapiTitle = item?.offer?.title || '';
    if (!strapiTitle) continue;
    const bucket = buckets.get(normalize(item.clientName || '')) || [];
    if (bucket.length === 0) continue; // «нет в календаре» уже ловится diffByName
    const want = normalizeTitle(strapiTitle);
    const hit = bucket.find((b) => !b.used && normalizeTitle(b.title) === want);
    if (hit) {
      hit.used = true;
      continue;
    }
    const fallback = bucket.find((b) => !b.used) || bucket[0];
    fallback.used = true;
    out.push({
      client: (item.clientName || '').trim(),
      strapi: strapiTitle,
      calendar: fallback.title,
    });
  }
  return out;
};

// --- Брони календаря (наша коллекция booking) --------------------------------
// Форма события историческая ({customer_name, event_types:[{title}]}) — на неё
// завязаны diffByName/offerMismatches. customer_name = ТЕКУЩЕЕ имя клиента
// (relation), фолбэк — снимок clientNameRaw.

const fetchCalendarBookings = async (dateStr: string) => {
  try {
    const bookings = await strapi.documents(BOOKING_UID).findMany({
      filters: { date: dateStr, status: { $notIn: ['cancelled', 'noshow'] } },
      fields: ['clientNameRaw', 'status', 'services'],
      populate: { client: { fields: ['name'] } },
      pagination: { pageSize: 200 },
    });
    const events = (bookings || []).map((b: any) => ({
      customer_name: b?.client?.name || b?.clientNameRaw || '',
      event_types: (Array.isArray(b?.services) ? b.services : []).map((s: any) => ({
        title: s?.title || '',
      })),
    }));
    return { available: true, events };
  } catch (e: any) {
    strapi.log.warn(`shift-selfcheck: bookings fetch failed — ${e.message}`);
    return { available: false, events: [] };
  }
};

// --- Main --------------------------------------------------------------------

export default {
  async runSelfCheck(dateRaw?: string) {
    const date = dateRaw && DATE_RE.test(dateRaw) ? dateRaw : pragueToday();

    // Сегодняшние черновики + брони календаря параллельно.
    const [services, cashCount, workCount, calendar] = await Promise.all([
      strapi.documents(SP_UID).findMany({
        filters: { date },
        status: 'draft',
        populate: {
          offer: { fields: ['title', 'price'] },
          personal: { fields: ['name', 'ratePercent'] },
        },
        fields: ['clientName', 'staffSalaries', 'salonSalaries', 'sale', 'internal', 'verifyFlags'],
        pagination: { pageSize: 200 },
      }),
      strapi.documents(CASH_UID).count({ filters: { date }, status: 'draft' }),
      strapi.documents(WORKTIME_UID).count({ filters: { date }, status: 'draft' }),
      fetchCalendarBookings(date),
    ]);

    // Внутренние услуги (мастер↔мастер) в календаре не существуют — исключаем из сверки.
    const comparable = (services || []).filter((s: any) => !s?.internal);

    // 1. Rozdíl за смену: Σ (staff+salon − offerPrice×(1−sleva)) по реальным услугам.
    //    Положительное (переплата/салон получил больше) → не показываем; отрицательное
    //    (недостача — клиент заплатил меньше, чем по прайсу) → показываем минус.
    let rozdil = 0;
    for (const s of comparable) {
      const offerPrice = Number(s?.offer?.price);
      if (!Number.isFinite(offerPrice) || offerPrice <= 0) continue;
      const { discountRate } = computeMustValues(offerPrice, 0, s?.sale);
      const expected = offerPrice * (1 - discountRate);
      const recorded = toNum(s?.staffSalaries) + toNum(s?.salonSalaries);
      rozdil += recorded - expected;
    }
    rozdil = Math.round(rozdil);
    // Правило отображения: только недостача (минус) — проблема.
    const rozdilDisplay = rozdil < 0 ? rozdil : 0;

    // 2. Записи с неверными суммами (verify-флаги) + Δ Kč.
    const flagged: {
      client: string;
      master: string;
      flags: { emoji: string; label: string }[];
      staffDelta: number | null;
      salonDelta: number | null;
    }[] = [];
    for (const s of services || []) {
      const flags = flagsOf(s);
      const problems = flags.filter((f) => PROBLEM_FLAGS.includes(f));
      if (problems.length === 0) continue;
      const offerPrice = Number(s?.offer?.price);
      const ratePercent = Number(s?.personal?.ratePercent);
      let staffDelta: number | null = null;
      let salonDelta: number | null = null;
      if (Number.isFinite(offerPrice) && offerPrice > 0 && Number.isFinite(ratePercent)) {
        const { mustStaff, mustSalonNow } = computeMustValues(offerPrice, ratePercent, s?.sale);
        staffDelta = r2(toNum(s?.staffSalaries) - mustStaff);
        salonDelta = r2(toNum(s?.salonSalaries) - mustSalonNow);
      }
      flagged.push({
        client: (s?.clientName || '').trim() || '—',
        master: s?.personal?.name || '—',
        flags: problems.map((f) => ({ emoji: FLAG_META[f].emoji, label: FLAG_META[f].label })),
        staffDelta,
        salonDelta,
      });
    }

    // 3-4. Календарь↔Strapi (только если брони прочитались).
    let calendarOnly: string[] = [];
    let strapiOnly: string[] = [];
    let serviceMismatch: { client: string; strapi: string; calendar: string }[] = [];
    if (calendar.available) {
      const diff = diffByName(comparable, calendar.events);
      strapiOnly = diff.strapiExtra;
      calendarOnly = diff.calendarExtra;
      serviceMismatch = offerMismatches(comparable, calendar.events);
    }

    // 5. Отсутствующие записи.
    const missing = {
      services: (services || []).length === 0,
      cash: cashCount === 0,
      workTime: workCount === 0,
    };

    // Rozdíl (rozdilDisplay) больше НЕ показывается в виджете (дублировал «Špatně
    // zadané platby» и путал) → НЕ учитываем его в problemCount. Поле rozdil остаётся
    // в ответе (не используется виджетом) на случай возврата позже.
    const problemCount =
      flagged.length +
      calendarOnly.length +
      strapiOnly.length +
      serviceMismatch.length +
      (missing.services ? 1 : 0) +
      (missing.cash ? 1 : 0) +
      (missing.workTime ? 1 : 0);

    return {
      date,
      ok: problemCount === 0,
      problemCount,
      rozdil: rozdilDisplay, // ≤ 0 всегда (плюс не показываем)
      counts: {
        services: (services || []).length,
        cash: cashCount,
        workTime: workCount,
        calendar: calendar.events.length,
      },
      calendarAvailable: calendar.available,
      flagged,
      calendarOnly, // клиенты в календаре, без записи в Strapi (не записали)
      strapiOnly, // записи в Strapi, без брони в календаре (лишняя / опечатка имени)
      serviceMismatch,
      missing,
    };
  },
};
