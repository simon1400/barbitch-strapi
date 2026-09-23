// Причина при добавлении клиента в blacklist (s208).
//
// Основной путь админки — ручка POST /api/client-dedupe/blacklist, она причину
// проверяет сама и пишет в базу через knex (этот lifecycle её не видит). Здесь
// закрыты ОБХОДНЫЕ пути: Content Manager и сырой REST `PUT /api/clients/:id`
// (так админка ставила флаг до s208 — без причины и без журнала).
//
// Проверяется только ПЕРЕХОД false→true: у 20 карточек, заблокированных до s208
// без причины, пересохранение других полей ломаться не должно. На create не
// вешаем — mirror-sync Noona создаёт карточки с флагом из группы Noona.

import { errors } from '@strapi/utils';

const { ValidationError } = errors;
const UID = 'api::client.client';

/** нарушение правила «в blacklist только с причиной»; null = сохранять можно */
export const blacklistReasonViolation = (
  prev: { blacklisted?: boolean | null; blacklistReason?: string | null } | null,
  data: { blacklisted?: unknown; blacklistReason?: unknown },
): string | null => {
  if (!data || data.blacklisted !== true) return null;
  if (prev?.blacklisted) return null;
  const reason = 'blacklistReason' in data ? data.blacklistReason : prev?.blacklistReason;
  if (String(reason ?? '').trim()) return null;
  return 'Při přidání na blacklist je nutné vyplnit důvod (pole blacklistReason).';
};

export default {
  async beforeUpdate(event: any) {
    const data = event.params?.data;
    if (!data || data.blacklisted !== true) return;
    const where = event.params?.where;
    const prev = where
      ? await (strapi.db as any).query(UID).findOne({ where, select: ['blacklisted', 'blacklistReason'] })
      : null;
    const violation = blacklistReasonViolation(prev, data);
    if (violation) throw new ValidationError(violation);
  },
};
