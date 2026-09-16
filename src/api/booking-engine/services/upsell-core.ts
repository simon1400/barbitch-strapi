// Общее ядро дозаписи: классификация услуг по категориям, отсев «не базовых»
// услуг и поиск свободного окна мастера рядом с визитом клиента.
//
// Чистый модуль БЕЗ глобала strapi — его гоняют node-тесты (tests/upsell-core.test.mjs).
// Им пользуются оба механизма дозаписи:
//   • thank-you (rebook.ts) — клиент сам, сразу после брони на сайте, −15 %;
//   • администратор (upsell.ts) — клиент в салоне или едет, −10 % + 5 % администратору.
//
// Перенесено из rebook.ts (s133) дословно, кроме правила отсева (s197, см. ниже).

import { subtractIntervals } from './slots-core';

// окно мастера должно начинаться не позже, чем через N минут после конца визита клиента
// (и для «перед» — заканчиваться не раньше, чем за N минут до начала визита)
export const UPSELL_GAP_TOLERANCE_MIN = 15;

// ── классификация категорий ──

export const BUCKETS = ['manicure', 'brows', 'lashes'];

// Порядок важен: «řas» (ресницы) до «obočí», маникюр последним.
// ⚠️ При новых категориях каталога — дополнить ключевые слова (копия в digest.ts).
export const classifyTitle = (raw) => {
  const t = String(raw || '').toLowerCase();
  if (t.includes('řas') || t.includes('rias') || t.includes('lash')) return 'lashes';
  if (
    t.includes('obočí') ||
    t.includes('oboci') ||
    t.includes('brow') ||
    t.includes('barvení a péče') ||
    t.includes('laminace') ||
    t.includes('úprava tvaru') ||
    t.includes('uprava tvaru')
  )
    return 'brows';
  const nailKeys = ['nehty', 'manikúra', 'manikura', 'gel lak', 'prodloužení neht', 'nano', 'sundání', 'hygienick', 'ibx'];
  if (nailKeys.some((k) => t.includes(k))) return 'manicure';
  return null;
};

// Не предлагаем снятия и доливы — только самостоятельные базовые услуги.
// s197: слово «korekce» из списка убрано. Оно отсекало платную «Úprava tvaru,
// korekce voskem / pinzetou» (350 Kč), а бесплатные «Korekce do 5 dnů» теперь
// отсекаются по цене 0 Kč — продавать бесплатную услугу со скидкой бессмысленно.
export const NON_BASE_KEYWORDS = ['sundání', 'sundani', 'odstranění', 'odstraneni', 'doplnění', 'doplneni'];
export const isExcludedOfferService = (title, price) => {
  const t = String(title || '').toLowerCase();
  if (NON_BASE_KEYWORDS.some((k) => t.includes(k))) return true;
  return !(Number(price) > 0);
};

// ── окна мастера ──

// «Сразу после»: свободное окно мастера, начинающееся не позже чем через
// UPSELL_GAP_TOLERANCE_MIN минут после конца визита клиента (anchorEndMin).
// Возвращает { startMin, availMin } либо null. Влезает ли услуга — решает вызывающий.
export const windowAfter = (hourRow, busyList, anchorEndMin, isToday, nowMin) => {
  const openMin = hourRow?.openMin ?? null;
  const closeMin = hourRow?.closeMin ?? null;
  if (openMin == null || closeMin == null || closeMin <= openMin) return null;
  const free = subtractIntervals({ startMin: openMin, endMin: closeMin }, busyList);
  for (const gap of free) {
    if (gap.endMin <= anchorEndMin) continue;
    const startMin = Math.max(gap.startMin, anchorEndMin);
    if (startMin > anchorEndMin + UPSELL_GAP_TOLERANCE_MIN) return null; // free отсортирован — дальше только позже
    if (isToday && startMin < nowMin) return null; // якорь уже в прошлом — дозапись не предлагаем
    const availMin = gap.endMin - startMin;
    if (availMin <= 0) continue;
    return { startMin, availMin };
  }
  return null;
};

// «Сразу перед»: услуга длиной durationMin ставится как можно позже и заканчивается
// не раньше чем за UPSELL_GAP_TOLERANCE_MIN минут до начала визита (anchorStartMin).
// minStartMin — самый ранний допустимый старт (сегодня: «сейчас» + запас на дорогу;
// другой день: null — ограничения нет). Возвращает { startMin, endMin } либо null.
export const windowBefore = (hourRow, busyList, anchorStartMin, durationMin, minStartMin) => {
  const openMin = hourRow?.openMin ?? null;
  const closeMin = hourRow?.closeMin ?? null;
  if (openMin == null || closeMin == null || closeMin <= openMin) return null;
  if (!(durationMin > 0)) return null;
  const free = subtractIntervals({ startMin: openMin, endMin: closeMin }, busyList);
  for (const gap of free) {
    const latestEnd = Math.min(gap.endMin, anchorStartMin);
    if (latestEnd <= gap.startMin) continue;
    if (anchorStartMin - latestEnd > UPSELL_GAP_TOLERANCE_MIN) continue; // окно кончается слишком рано
    const startMin = latestEnd - durationMin;
    if (startMin < gap.startMin) continue; // не влезает до следующей занятости
    if (minStartMin != null && startMin < minStartMin) continue; // клиент не успеет
    return { startMin, endMin: latestEnd };
  }
  return null;
};
