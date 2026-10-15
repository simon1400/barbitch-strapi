/**
 * «Кто администратор» — один источник для задач (s262, owner-tasks) и смены (s263, smena).
 *
 * Работающие учётки роли `administrator` со связанной карточкой (совместители-мастера тоже:
 * роль — у учётки, не `position`). Связь — `personalDocId`, иначе по имени (как
 * `staff-identity.findSessionPersonal`). Без карточки или с неактивной карточкой — не в списке.
 */

const ADMIN_UID = 'api::admin-user.admin-user';
const PERSONAL_UID = 'api::personal.personal';

export type AdminPerson = { documentId: string; name: string; login: string };

export const findWorkingAdmins = async (strapi: any): Promise<AdminPerson[]> => {
  const accounts = (
    await strapi.documents(ADMIN_UID).findMany({ filters: { role: { $eq: 'administrator' } }, fields: ['username', 'isActive', 'personalDocId'], limit: 50 })
  ).filter((a: any) => a.isActive !== false);
  if (!accounts.length) return [];
  const ids = accounts.map((a: any) => String(a.personalDocId ?? '').trim()).filter(Boolean);
  const names = accounts
    .filter((a: any) => !String(a.personalDocId ?? '').trim())
    .map((a: any) => String(a.username ?? '').trim())
    .filter(Boolean);
  const or = [...(ids.length ? [{ documentId: { $in: ids } }] : []), ...(names.length ? [{ name: { $in: names } }] : [])];
  if (!or.length) return [];
  const cards = await strapi.documents(PERSONAL_UID).findMany({ status: 'draft', filters: { $or: or }, fields: ['name', 'isActive'], limit: 100 });
  const out = new Map<string, AdminPerson>();
  for (const a of accounts) {
    const link = String(a.personalDocId ?? '').trim();
    const login = String(a.username ?? '').trim();
    const card = link
      ? cards.find((c: any) => c.documentId === link)
      : cards.find((c: any) => String(c.name ?? '').trim().toLowerCase() === login.toLowerCase());
    if (!card || card.isActive === false || out.has(card.documentId)) continue;
    out.set(card.documentId, { documentId: card.documentId, name: String(card.name ?? '').trim() || login, login });
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name, 'cs'));
};
