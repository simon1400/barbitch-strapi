// @ts-nocheck

// После создания транзакции лояльности (в т.ч. ручной корректировки админа через
// REST /api/loyalty-transactions) — пересчитать награды клиента: пересечение
// порога должно создавать redemption сразу, не ждать ночного крона.
// В bulk-режиме (крон/бэкфил создаёт транзакции пачкой) пересчёт подавлен —
// сервис пересчитает один раз per клиент в конце (иначе бэкфил года = тысячи
// лишних пересчётов).

export default {
  async afterCreate(event) {
    const svc = strapi.service('api::loyalty.loyalty');
    if (!svc || svc.isBulk?.() || !svc.enabled?.()) return;
    const documentId = event?.result?.documentId;
    if (!documentId) return;
    try {
      const tx = await strapi
        .documents('api::loyalty-transaction.loyalty-transaction')
        .findOne({
          documentId,
          fields: ['cardYear'],
          populate: { client: { fields: ['name'] } },
        });
      if (!tx?.client?.documentId || !tx.cardYear) return;
      await svc.recomputeClientRewards(tx.client.documentId, Number(tx.cardYear));
    } catch (e) {
      strapi.log.error(`loyalty afterCreate recompute failed: ${e?.message || e}`);
    }
  },
};
