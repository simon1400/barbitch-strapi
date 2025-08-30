const UID = 'api::client.client';
const RELATION = 'offers'; // имя relation-поля к service-provided

async function recalcAndPatchSum(event: any) {
  const ctx = strapi.requestContext.get?.();
  if (ctx?.state?.__skipClientSum) return;
  if (ctx) ctx.state.__skipClientSum = true;

  const id = event.result?.documentId

  const entity = await strapi.documents(UID).findOne({
    documentId: id,
    populate: [RELATION],
  });

  const total = (entity?.[RELATION] ?? []).reduce((acc: number, o: any) => {
    const salon = Number(o?.salonSalaries ?? 0);
    const staff = Number(o?.staffSalaries ?? 0);
    const tip   = Number(o?.tip ?? 0);
    return acc + salon + staff + tip;
  }, 0);

  if (Number(entity?.sum ?? 0) === total) return;

  await strapi.documents(UID).update({
    documentId: id,
    data: { sum: total },
  });
}

export default {
  async afterCreate(event: any) {
    await recalcAndPatchSum(event);
  },
  async afterUpdate(event: any) {
    await recalcAndPatchSum(event);
  },
};