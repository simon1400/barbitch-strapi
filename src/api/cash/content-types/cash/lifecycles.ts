const UID = 'api::cash.cash';
const RELATION = 'flow';
const FLOW_UID = 'items.money-flow';
const SKIP_PROFIT = '__skipProfitRecalc';

import { errors } from '@strapi/utils';
const { ValidationError } = errors;

function isPreviousMonth(date1: string | Date, date2: string | Date) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  let pm = d1.getMonth() - 1;
  let py = d1.getFullYear();
  if (pm < 0) { pm = 11; py -= 1; }
  return d2.getMonth() === pm && d2.getFullYear() === py;
}

async function recalcProfit(event: any) {
  const id = event.result?.documentId;
  if (!id) return;

  const currentDoc = await strapi.documents(UID).findOne({
    documentId: id,
    populate: { [RELATION]: { fields: ['sum'] } },
    fields: ['date','profit'],
  });

  const lastDoc = await strapi.documents(UID).findFirst({
    sort: { date: 'desc' },
    fields: ['date','sum','profit'],
    filters: { documentId: { $ne: id }, date: { $lt: event.params.data.date } },
  });

  const lastProfit = lastDoc && !isPreviousMonth(currentDoc.date, lastDoc.date)
    ? Number(lastDoc.profit ?? 0)
    : 0;

    console.log(lastProfit)

  const totalCurrent = (currentDoc?.[RELATION] ?? [])
    .filter((o: any) => Number(o?.sum) >= 0)
    .reduce((acc: number, o: any) => acc + Number(o.sum), 0);

  const totalUpdatedCurrent = lastProfit + totalCurrent;

  const ctx = strapi.requestContext.get?.();
  if (ctx) ctx.state[SKIP_PROFIT] = true;

  await strapi.documents(UID).update({
    documentId: id,
    data: { profit: `${totalUpdatedCurrent}` },
  });

  if (ctx) delete ctx.state[SKIP_PROFIT];
}

async function getFlowItemsSum(data: any) {
  const ids = data.flow?.map((x: any) => x.id).filter(Boolean) ?? [];
  if (!ids.length) return 0;

  const rows = await (strapi.db as any).query(FLOW_UID).findMany({
    where: { id: { $in: ids } },
    select: ['sum'],
  });

  return (rows ?? []).reduce((acc: number, o: any) => acc + Number(o?.sum ?? 0), 0);
}

async function validateSum(event: any) {
  const issues: { path: string[]; message: string }[] = [];

  const flowMoneySum = await getFlowItemsSum(event.params.data);
  const currentId = event.params.data.documentId ?? null;

  const lastDoc = await strapi.documents(UID).findFirst({
    sort: { date: 'desc' },
    fields: ['sum'],
    filters: { documentId: { $ne: currentId }, date: { $lt: event.params.data.date } },
  });

  const calc = Number(lastDoc?.sum ?? 0) + flowMoneySum;

  if (calc !== Number(event.params.data.sum)) {
    issues.push({ path: ['sum'], message: 'Остаток в кассе не сходится с потоком денег.' });
  }

  if (issues.length) {
    throw new ValidationError('Ошибка заполнения', { errors: issues });
  }
}

export default {
  async beforeCreate(event: any) {
    await validateSum(event);
  },
  async beforeUpdate(event: any) {
    const ctx = strapi.requestContext.get?.();
    if (ctx?.state?.[SKIP_PROFIT]) return;
    await validateSum(event);
  },
  async afterCreate(event: any) {
    const ctx = strapi.requestContext.get?.();
    if (ctx?.state?.[SKIP_PROFIT]) return;
    await recalcProfit(event);
  },
  async afterUpdate(event: any) {
    const ctx = strapi.requestContext.get?.();
    if (ctx?.state?.[SKIP_PROFIT]) return;
    await recalcProfit(event);
  },
};