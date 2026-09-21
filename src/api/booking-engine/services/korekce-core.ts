// Гейт бесплатной «Korekce do 5 dnů» на сайте (s203): бесплатную коррекцию клиент
// может забронировать онлайн только если у него был визит той же категории
// (ногти / ресницы) за последние KOREKCE_WINDOW_DAYS дней — к любому мастеру
// (гарантия салона, не мастера). Иначе 409 korekce_no_visit → «zavolejte do salonu».
//
// Чистый модуль БЕЗ глобала strapi — его гоняют node-тесты (tests/korekce-core.test.mjs).
// Выборка визитов и сам throw живут в booking-engine.ts (assertFreeKorekceAllowed).

import { classifyTitle } from './upsell-core';

export const KOREKCE_WINDOW_DAYS = 5;

// Название в каталоге: «Korekce do 5 dnů» (есть в двух категориях — ногти и ресницы).
export const isKorekceTitle = (title): boolean => /^korekce do 5 dn/i.test(String(title || '').trim());

// Гейт только для БЕСПЛАТНОЙ коррекции: вариант «mimo záruční podmínky» (150 Kč)
// клиент оплачивает, там проверять нечего. Снапшот холда/брони: item.base = название
// базовой услуги, item.title = комбо-название.
export const isFreeKorekceItem = (item, totalPrice): boolean =>
  !!item && isKorekceTitle(item.base || item.title) && !(Number(totalPrice) > 0);

// Первый день окна: дата коррекции минус KOREKCE_WINDOW_DAYS (календарная арифметика
// над строкой YYYY-MM-DD, без часовых поясов — как остальные даты движка).
export const korekceWindowStart = (dateStr: string): string => {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d - KOREKCE_WINDOW_DAYS);
  return new Date(t).toISOString().slice(0, 10);
};

// После чего коррекция не положена: сама коррекция, Hygienická manikúra
// (описание услуги: «*netýká se hygienické manikúry»), снятия.
const NON_QUALIFYING = [/^korekce/i, /^hygienick/i, /^sundání/i, /^sundani/i];

export interface VisitRow {
  status: string;
  startsAt: string | Date | null;
  serviceTitle: string | null;
  serviceCategory: string | null;
}

// Визит засчитывается, если: не отменён и не неявка, уже НАЧАЛСЯ (startsAt ≤ now),
// услуга не из NON_QUALIFYING и её категория совпадает с категорией коррекции.
export const isQualifyingVisit = (visit: VisitRow, bucket: string | null, nowMs: number): boolean => {
  if (!visit) return false;
  if (visit.status !== 'active' && visit.status !== 'checkedOut') return false;
  if (!visit.startsAt || new Date(visit.startsAt).getTime() > nowMs) return false;
  const title = String(visit.serviceTitle || '').trim();
  if (!title) return false;
  if (NON_QUALIFYING.some((re) => re.test(title))) return false;
  const b = classifyTitle(visit.serviceCategory) ?? classifyTitle(title);
  return !!bucket && b === bucket;
};
