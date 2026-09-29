/**
 * «Мой месяц» — данные кабинета мастера (s229, план «Карточка сотрудника» §15.4).
 *
 * 🟥 ЗАЧЕМ. Кабинет мастера (`admin/src/pages/dashboard/fetch/works.ts`) читал свою
 * карточку с услугами, штрафы, доплаты и выплаты ПРЯМЫМ REST (`/api/personals`,
 * `/api/penalties`, `/api/add-moneys`, `/api/payrolls`), а фильтр «только мои» ставил
 * браузер — мастер своей сессией снимал его и читал деньги коллег. Теперь сервер сам
 * определяет карточку сессии (по связи учётки, без связи — по имени, utils/staff-identity),
 * а эти коллекции роли master закрыты в middleware admin-session.
 *
 * Отдаются РОВНО те строки, что раньше приходили из REST (опубликованные версии, те же
 * фильтры дат и поля) — расчёт денег остаётся в админке прежним, побайтово.
 * Границы месяца присылает админка (`getMonthRange` в часовом поясе браузера, как было):
 * сервер их лишь проверяет — чужие данные ими не достать, это всегда своя карточка.
 */
import { findSessionPersonal } from '../../../utils/staff-identity';
import { EngineError } from './booking-engine';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** Окно — месяц кабинета; с запасом на часовой пояс браузера. */
export const MAX_SPAN_DAYS = 32;

export const parseRange = (from: unknown, to: unknown): { from: string; to: string } => {
  const f = String(from ?? '').trim();
  const t = String(to ?? '').trim();
  if (!ISO_RE.test(f) || !ISO_RE.test(t)) throw new EngineError(400, 'bad_range', 'Očekáván rozsah from/to v ISO');
  const fm = Date.parse(f);
  const tm = Date.parse(t);
  if (!Number.isFinite(fm) || !Number.isFinite(tm) || tm < fm) throw new EngineError(400, 'bad_range', 'Neplatný rozsah');
  if (tm - fm > MAX_SPAN_DAYS * 86_400_000) throw new EngineError(400, 'bad_range', 'Rozsah je delší než měsíc');
  return { from: f, to: t };
};

export default ({ strapi }: { strapi: any }) => ({
  async get({ session, from, to }: { session: any; from: unknown; to: unknown }) {
    const range = parseRange(from, to);
    const date = { $gte: range.from, $lte: range.to };
    const personal = await findSessionPersonal(strapi, session, {
      status: 'published',
      fields: ['name', 'noonaEmployeeId'],
      populate: {
        offersDone: {
          sort: ['date:desc'],
          filters: { date },
          fields: ['date', 'clientName', 'staffSalaries', 'tip'],
        },
      },
    });
    if (!personal) return { personal: null, penalties: [], extra: [], payrolls: [] };
    const mine = { personal: { documentId: { $eq: personal.documentId } }, date };
    const [penalties, extra, payrolls] = await Promise.all([
      strapi.documents('api::penalty.penalty').findMany({ status: 'published', filters: mine, fields: ['sum'] }),
      strapi.documents('api::add-money.add-money').findMany({ status: 'published', filters: mine, fields: ['sum', 'date', 'title'] }),
      strapi.documents('api::payroll.payroll').findMany({ status: 'published', filters: mine, fields: ['sum'] }),
    ]);
    return {
      personal: {
        name: personal.name,
        noonaEmployeeId: personal.noonaEmployeeId ?? null,
        offersDone: (personal.offersDone || []).map((o: any) => ({
          id: o.id,
          date: o.date,
          clientName: o.clientName,
          staffSalaries: o.staffSalaries,
          tip: o.tip,
        })),
      },
      penalties: penalties.map((r: any) => ({ sum: r.sum })),
      extra: extra.map((r: any) => ({ id: r.id, sum: r.sum, date: r.date, title: r.title })),
      payrolls: payrolls.map((r: any) => ({ sum: r.sum })),
    };
  },
});
