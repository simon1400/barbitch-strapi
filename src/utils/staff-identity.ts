/**
 * Карточка сотрудника текущей сессии (s229, план «Карточка сотрудника» §5а.1).
 *
 * До s229 «кто я» искалось строкой имени: `session.username` = `personals.name`
 * (память master-rename-invariant). Переименование карточки или логина молча отрывало
 * мастера от его броней и кабинета. Теперь учётка несёт `personalDocId` — documentId
 * карточки; middleware читает его из базы (не из токена), `sessionFromCtx` кладёт в сессию.
 *
 * Связь есть → карточка ищется ТОЛЬКО по ней (на имя не откатываемся: иначе учётка,
 * связанная с одной карточкой, по совпадению имени получила бы другую).
 * Связи нет (учётка заведена в панели Strapi мимо карточки) → прежний поиск по имени.
 */

const PERSONAL_UID = 'api::personal.personal';

export const sessionPersonalDocId = (session: any): string => {
  const v = session?.personalDocId;
  return typeof v === 'string' ? v.trim() : '';
};

/** Фильтр карточки «это я» для document service. null — искать нечем. */
export const sessionPersonalFilter = (session: any): Record<string, any> | null => {
  const docId = sessionPersonalDocId(session);
  if (docId) return { documentId: { $eq: docId } };
  const name = String(session?.username ?? '').trim();
  return name ? { name: { $eqi: name } } : null;
};

export const findSessionPersonal = async (
  strapi: any,
  session: any,
  {
    fields = ['name'],
    filters = {},
    status,
    populate,
  }: { fields?: string[]; filters?: Record<string, any>; status?: 'draft' | 'published'; populate?: Record<string, any> } = {}
): Promise<any | null> => {
  const own = sessionPersonalFilter(session);
  if (!own) return null;
  const rows = await strapi.documents(PERSONAL_UID).findMany({
    ...(status ? { status } : {}),
    filters: { ...filters, ...own },
    fields,
    ...(populate ? { populate } : {}),
    limit: 1,
  });
  return rows?.[0] || null;
};
