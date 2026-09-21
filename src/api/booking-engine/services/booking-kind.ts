/**
 * Вид брони: обычная клиентская или «интерная» (Interní rezervace, s203) —
 * запись сотрудника салона на услугу к мастеру, которая НЕ занимает время мастера:
 * на этот слот по общим правилам может записаться реальный клиент (сайт и админка).
 *
 * Здесь живёт ЕДИНСТВЕННОЕ определение занятости. Его импортируют все, кто строит
 * busy-интервалы или считает загрузку: loadDayContexts, employeeLoadWindow,
 * rebook._anchorContext, upsell._dayBookings/report. Одно место — чтобы «свободно»
 * не разъехалось между сайтом, холдами, переносом клиентом и дозаписями.
 *
 * ВАЖНО: модуль самодостаточен (ни одного импорта) — юнит-тесты транспилируют его
 * в изоляции без БД/Strapi (strapi/tests/booking-kind.test.mjs).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🟥 ПОЧЕМУ ФИЛЬТР НЕ `{ internal: { $ne: true } }`
 *
 * Strapi компилирует `$ne` в `where "internal" <> true` (@strapi/database
 * query/helpers/where.js, case '$ne'), а в SQL `NULL <> true` = NULL, то есть
 * строка НЕ попадает в выборку. schema-sync же заводит boolean-колонку nullable
 * и БЕЗ db-default: проверено на проде 21.09 — у `arrived` (в схеме "default": false)
 * 4187 NULL из 4854 строк. Значит сразу после деплоя `internal` будет NULL у ВСЕХ
 * существующих броней, и `$ne: true` не вернёт НИ ОДНОЙ из них: занятость станет
 * пустой, и каждый слот на сайте покажется свободным.
 *
 * Поэтому «не интерная» всегда выражается явно через NULL-безопасное условие,
 * и оно остаётся верным ДО миграции (`UPDATE … SET internal=false WHERE internal IS NULL`),
 * ПОСЛЕ неё и для строк, созданных в промежутке.
 * В сыром SQL — эквивалент `coalesce(internal, false) = false`.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const ACTIVE = 'active';

/** Строка брони в том виде, в каком её отдаёт Strapi (поля опциональны). */
export interface BookingKindRow {
  status?: string | null;
  internal?: boolean | null;
}

/** Интерная бронь. NULL/undefined (старые строки) — обычная. */
export const isInternal = (row: BookingKindRow | null | undefined): boolean => row?.internal === true;

/**
 * Занимает ли бронь время мастера. Активная клиентская — да; интерная — нет
 * (на её время можно записать клиента); отменённая/noshow/закрытая — нет.
 */
export const isOccupying = (row: BookingKindRow | null | undefined): boolean =>
  row?.status === ACTIVE && row?.internal !== true;

/**
 * NULL-безопасное «не интерная» для filters Strapi. Отдаётся как значение ключа
 * `$or`, потому что другого способа поймать NULL в document API нет:
 * `$in: [false, null]` → `IN (false, null)` мимо NULL, `$not:{$eq:true}` → `NOT (x = true)`
 * тоже NULL. Работает только `IS NULL OR = false`.
 */
export const NOT_INTERNAL_OR: Array<Record<string, unknown>> = [
  { internal: { $null: true } },
  { internal: { $eq: false } },
];

/** То же условие для сырого SQL (attribution, admin-analytics). */
export const NOT_INTERNAL_SQL = 'coalesce(internal, false) = false';

/**
 * Дописать «не интерная» к готовым filters. Если у вызывающего уже есть свой `$or`,
 * оба условия уезжают в `$and` — иначе один молча затёр бы другой.
 */
export const withoutInternal = (filters: Record<string, any>): Record<string, any> => {
  if (filters && '$or' in filters) {
    const { $or, ...rest } = filters;
    return { ...rest, $and: [{ $or }, { $or: NOT_INTERNAL_OR }] };
  }
  return { ...filters, $or: NOT_INTERNAL_OR };
};

/** Фильтр занятости: активные клиентские брони. `extra` — дата/мастер и т. п. */
export const occupancyFilters = (extra: Record<string, any>): Record<string, any> =>
  withoutInternal({ ...extra, status: ACTIVE });
