/**
 * «Работает как мастер» (s249): мастер ИЛИ управляющая с флагом `alsoMaster`.
 *
 * Управляющая (s213) — не мастер: колонки в календаре нет, на сайте её нет. С s249
 * она может параллельно принимать клиенток — тогда на карточке `alsoMaster = true`
 * и для календаря, сайта, rebook, дозаписей, отпусков, плана и карточки сотрудника
 * она такой же мастер. Роль входа и всё «управляющее» (výkaz, поручения, push) —
 * по-прежнему по `position = 'manager'`.
 *
 * 🟥 Кто мастер — решать ТОЛЬКО через этот файл (и его зеркало admin/src/lib/worksAsMaster.ts),
 * а не сравнением `position === 'master'`.
 * Флаг у другой должности игнорируется. NULL у старых строк = false
 * (фильтр `$eq: true` их не берёт — гоча `$ne` + NULL сюда не относится).
 */
export const worksAsMaster = (p: any): boolean =>
  p?.position === 'master' || (p?.position === 'manager' && p?.alsoMaster === true);

/** То же условием для `filters` Strapi (вкладывать рядом с остальными ключами). */
export const WORKS_AS_MASTER_FILTER = {
  $or: [{ position: { $eq: 'master' } }, { position: { $eq: 'manager' }, alsoMaster: { $eq: true } }],
};
