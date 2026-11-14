// @ts-nocheck
/**
 * Публичные данные главной страницы сайта (s286): «Nejoblíbenější služby»,
 * цены «od …» в секции с рукой и «Náš tým». Только чтение, без личных данных.
 *
 *  • popular-services — услуги, которые чаще всего бронировали за последние
 *    POPULAR_DAYS дней (решение владельца 13.11: 30 дней, не больше 2 из одной
 *    группы каталога). Наружу — только порядок, без счётчиков и сумм.
 *  • service-prices — минимальная цена по трём услугам сайта (manikura / oboci /
 *    rasy = продление). Сопоставление группы каталога с разделом /book — та же
 *    логика, что client/src/lib/bookSection.ts (GROUP_PREFIXES продублированы,
 *    тест tests/home.test.mjs).
 *  • team — мастера для главной: имя (первое слово), фото, подпись. Ни ставок,
 *    ни `oficial`, ни дат.
 *
 * Ответы кэшируются в памяти процесса (популярные — 6 ч, цены и команда — 1 ч:
 * они дешёвые, а галочку «на главной» владелец ждёт увидеть быстрее). Сайт
 * поверх ещё держит ISR 1 ч.
 *
 * Верх файла — чистые функции (tests/home.test.mjs), ниже — сервис.
 */

import { WORKS_AS_MASTER_FILTER } from '../../../utils/works-as-master';

const SALON_SERVICE_UID = 'api::salon-service.salon-service';
const BOOKING_UID = 'api::booking.booking';
const PERSONAL_UID = 'api::personal.personal';

/** Окно подсчёта популярности, дней (решение владельца 13.11). */
export const POPULAR_DAYS = 30;
/** Не больше стольких услуг из одной группы каталога (решение владельца 13.11). */
export const POPULAR_PER_CATEGORY = 2;
export const POPULAR_DEFAULT_LIMIT = 4;
export const POPULAR_MAX_LIMIT = 8;

export const POPULAR_TTL_MS = 6 * 60 * 60 * 1000;
export const LIGHT_TTL_MS = 60 * 60 * 1000;

/** Брони, которые считаются спросом: всё, кроме отменённых (enum booking.status). */
export const COUNTED_STATUSES = ['active', 'checkedOut', 'noshow'];

/** Разделы /book (= content.galery-item.bookingSection) — как в client/src/lib/bookSection.ts. */
export const GROUP_PREFIXES = {
  Nehty: ['nehty', 'manikura'],
  Oboci: ['oboci'],
  Rasy_barveni_a_pece: ['rasy barveni', 'barveni ras', 'lash lifting'],
  Prodluzovani_ras: ['prodluzovani ras', 'prodlouzeni ras'],
};

/** Раздел /book → услуга сайта (коллекция `service`, слаг). */
export const SITE_SERVICE_OF_SECTION = {
  Nehty: 'manikura',
  Oboci: 'oboci',
  Rasy_barveni_a_pece: 'rasy',
  Prodluzovani_ras: 'rasy',
};

/** Подпись мастера: какие разделы дают какую часть; порядок = порядок в строке. */
const SPECIALIZATION_ORDER = [
  [['Nehty'], 'Manikúra'],
  [['Rasy_barveni_a_pece', 'Prodluzovani_ras'], 'Řasy'],
  [['Oboci'], 'Obočí'],
];

export const normalizeTitle = (title) =>
  String(title || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Группа каталога («Řasy – barvení a péče ☁️») → раздел /book или null. */
export const sectionOfCategory = (category) => {
  const n = normalizeTitle(category);
  if (!n) return null;
  for (const [section, prefixes] of Object.entries(GROUP_PREFIXES)) {
    if (prefixes.some((p) => n.startsWith(p))) return section;
  }
  return null;
};

/** Человеческое название группы: без эмодзи и хвостовых знаков («Nehty 💅💅💅» → «Nehty»). */
export const cleanCategory = (category) =>
  String(category || '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Служебные позиции каталога, которые не показываются как «популярная услуга». */
export const isServiceRow = (title) => /^(sundani|korekce)\b/.test(normalizeTitle(title));

/** Для цены «od» не годятся ещё и доплнения (цена «od» продления — это новое продление). */
export const isPriceRow = (title) => !/^(sundani|korekce|doplneni)\b/.test(normalizeTitle(title));

/**
 * Базовая цена и флаг «od»: варианты меняют цену — показываем минимум и `from`.
 * Варианты каталога в основном доплаты (+200), бывают и бесплатные (Pánská, 0).
 */
export const priceOf = (svc) => {
  const base = Number(svc?.price) || 0;
  const diffs = (svc?.variants || []).map((v) => Number(v?.priceDiff) || 0);
  const min = diffs.length ? Math.min(0, ...diffs) : 0;
  return { price: base + min, from: diffs.some((d) => d !== 0) };
};

/**
 * Сколько броней за окно приходится на каждую услугу каталога (documentId).
 * Не считаются: отменённые, интерные (`internal`), бесплатные корекции (`korekce`).
 * Одна бронь даёт услуге максимум +1, доплаты отдельной услугой не считаются
 * (в снимке брони они — `variant`/`modifiers` того же пункта).
 */
export const countServiceUsage = (bookings) => {
  const counts = new Map();
  for (const b of bookings || []) {
    if (!b || !COUNTED_STATUSES.includes(b.status)) continue;
    if (b.internal === true || b.korekce === true) continue;
    const items = Array.isArray(b.services) ? b.services : [];
    const seen = new Set();
    for (const it of items) {
      const id = it?.serviceDocId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
};

/**
 * Выбор популярных: по числу броней (при равенстве — порядок каталога), не больше
 * `perCategory` из одной группы. Не хватило услуг с бронями — добор по порядку
 * каталога с тем же лимитом на группу, потом уже без лимита.
 * `catalog` — уже отсортирован (categoryOrder, order, title) и отфильтрован.
 */
export const pickPopular = (catalog, counts, { limit = POPULAR_DEFAULT_LIMIT, perCategory = POPULAR_PER_CATEGORY } = {}) => {
  const eligible = (catalog || []).filter((s) => s && (Number(s.price) || 0) > 0 && !isServiceRow(s.title));
  const order = new Map(eligible.map((s, i) => [s.documentId, i]));
  const byCount = eligible
    .filter((s) => (counts.get(s.documentId) || 0) > 0)
    .sort((a, b) => (counts.get(b.documentId) || 0) - (counts.get(a.documentId) || 0) || order.get(a.documentId) - order.get(b.documentId));

  const picked = [];
  const perCat = new Map();
  const take = (list, capped) => {
    for (const s of list) {
      if (picked.length >= limit) return;
      if (picked.includes(s)) continue;
      const cat = s.category || '';
      if (capped && (perCat.get(cat) || 0) >= perCategory) continue;
      picked.push(s);
      perCat.set(cat, (perCat.get(cat) || 0) + 1);
    }
  };
  take(byCount, true);
  take(eligible, true);
  take(eligible, false);
  return picked;
};

export const shapePopular = (svc) => {
  const section = sectionOfCategory(svc.category);
  const { price, from } = priceOf(svc);
  return {
    id: svc.documentId,
    title: svc.title,
    category: cleanCategory(svc.category),
    price,
    from,
    durationMin: Number(svc.durationMin) || null,
    bookingSection: section,
    // /book/<documentId> — шаг выбора мастера этой услуги (middleware пускает этот вид)
    bookHref: `/book/${svc.documentId}`,
  };
};

/**
 * Минимальная цена «od» по услугам сайта: manikura — группа Nehty, oboci — Obočí,
 * rasy — ТОЛЬКО продление (в макете «prodloužení od …»), без снятия/коррекции/доплнения.
 */
export const minPrices = (catalog) => {
  const out = { manikura: null, oboci: null, rasy: null };
  const keyOf = { Nehty: 'manikura', Oboci: 'oboci', Prodluzovani_ras: 'rasy' };
  for (const s of catalog || []) {
    const key = keyOf[sectionOfCategory(s?.category)];
    if (!key || !isPriceRow(s.title)) continue;
    const { price } = priceOf(s);
    if (price <= 0) continue;
    if (out[key] === null || price < out[key]) out[key] = price;
  }
  return out;
};

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** «Manikúra» / «Řasy a obočí» / «Manikúra, řasy a obočí» по разделам услуг мастера. */
export const specializationOf = (categories) => {
  const sections = new Set((categories || []).map(sectionOfCategory).filter(Boolean));
  const parts = SPECIALIZATION_ORDER.filter(([keys]) => keys.some((k) => sections.has(k))).map(([, label]) => label);
  if (!parts.length) return '';
  const words = parts.map((p, i) => (i === 0 ? p : p.toLowerCase()));
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} a ${words[words.length - 1]}`;
};

/** Ушёл ли сотрудник к дате `today` (YYYY-MM-DD): `leftAt` в прошлом или сегодня. */
export const hasLeft = (leftAt, today) => !!leftAt && String(leftAt).slice(0, 10) <= today;

const photoOf = (photo) => {
  if (!photo?.url) return null;
  return { url: photo.url, width: Number(photo.width) || null, height: Number(photo.height) || null };
};

/**
 * Мастер для главной. Только эти поля — остальное (ставки, договоры, `oficial`,
 * даты, телефоны) сюда не попадает даже случайно: объект строится с нуля.
 */
export const shapeTeamMember = (p) => ({
  id: p.documentId,
  name: firstName(p.name),
  photo: photoOf(p.photo),
  specialization: (p.publicNote && String(p.publicNote).trim()) || specializationOf((p.services || []).map((s) => s?.category)),
  bookHref: '/book',
});

/** Мастера главной: работает как мастер, активен, не ушёл, галочка не снята; порядок calendarOrder. */
export const pickTeam = (personals, today) =>
  (personals || [])
    .filter((p) => p && p.isActive !== false && p.showOnHomepage !== false && !hasLeft(p.leftAt, today))
    .sort((a, b) => (Number(a.calendarOrder) || 0) - (Number(b.calendarOrder) || 0) || String(a.name).localeCompare(String(b.name)))
    .map(shapeTeamMember)
    .filter((m) => m.name);

export const clampLimit = (raw) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return POPULAR_DEFAULT_LIMIT;
  return Math.min(n, POPULAR_MAX_LIMIT);
};

export const pragueToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const addDaysYmd = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
};

// ── кэш в памяти процесса ──

const cache = new Map();
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
};
export const clearHomeCache = () => cache.clear();

// ── сервис ──

const loadCatalog = () =>
  strapi.documents(SALON_SERVICE_UID).findMany({
    filters: { active: true, onlineBookable: true },
    sort: ['categoryOrder:asc', 'order:asc', 'title:asc'],
    fields: ['title', 'category', 'price', 'durationMin', 'categoryOrder', 'order'],
    populate: { variants: true },
    limit: 500,
  });

export default {
  async popularServices(limitRaw) {
    const limit = clampLimit(limitRaw);
    return cached(`popular:${limit}`, POPULAR_TTL_MS, async () => {
      const today = pragueToday();
      const [catalog, bookings] = await Promise.all([
        loadCatalog(),
        strapi.documents(BOOKING_UID).findMany({
          filters: { date: { $gte: addDaysYmd(today, -POPULAR_DAYS), $lte: today }, status: { $in: COUNTED_STATUSES } },
          fields: ['services', 'status', 'internal', 'korekce'],
          limit: 20000,
        }),
      ]);
      const counts = countServiceUsage(bookings);
      return { days: POPULAR_DAYS, services: pickPopular(catalog, counts, { limit }).map(shapePopular) };
    });
  },

  async servicePrices() {
    return cached('prices', LIGHT_TTL_MS, async () => minPrices(await loadCatalog()));
  },

  async team() {
    return cached('team', LIGHT_TTL_MS, async () => {
      const personals = await strapi.documents(PERSONAL_UID).findMany({
        status: 'published',
        filters: { isActive: true, ...WORKS_AS_MASTER_FILTER },
        fields: ['name', 'isActive', 'leftAt', 'calendarOrder', 'showOnHomepage', 'publicNote'],
        populate: { photo: { fields: ['url', 'width', 'height'] }, services: { fields: ['category'] } },
        limit: 100,
      });
      return { team: pickTeam(personals, pragueToday()) };
    });
  },
};
