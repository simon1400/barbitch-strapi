const UID = 'api::cash.cash';
const FLOW_UID = 'items.money-flow';

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

async function getFlowItemsSum(data: any, validateSum: boolean = false) {
  const ids = data.flow?.map((x: any) => x.id).filter(Boolean) ?? [];
  if (!ids.length) return 0;

  const rows = await (strapi.db as any).query(FLOW_UID).findMany({
    where: { id: { $in: ids } },
    select: ['sum'],
  });

  if(validateSum) {
    return (rows ?? []).reduce((acc: number, o: any) => acc + Number(o?.sum ?? 0), 0);
  }

  return (rows ?? []).filter((o: any) => Number(o?.sum) >= 0).reduce((acc: number, o: any) => acc + Number(o?.sum ?? 0), 0);
  
}

async function computeProfit(data: any) {

  const lastDoc = await strapi.documents(UID).findFirst({
    sort: { date: 'desc' },
    fields: ['date', 'sum', 'profit'],
    filters: { documentId: { $ne: data.documentId ?? null }, date: { $lt: data.date } },
  });

  const lastProfit =
    lastDoc && !isPreviousMonth(data.date, lastDoc.date)
      ? Number(lastDoc.profit ?? 0)
      : 0;

  const totalCurrent = await getFlowItemsSum(data)

  return lastProfit + totalCurrent;
}

async function validateSum(event: any) {
  const issues: { path: string[]; message: string }[] = [];

  const flowMoneySum = await getFlowItemsSum(event.params.data, true);
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
    event.params.data.profit = String(await computeProfit(event.params.data));
  },
  async beforeUpdate(event: any) {
    await validateSum(event);
    event.params.data.profit = String(await computeProfit(event.params.data));
  },
};