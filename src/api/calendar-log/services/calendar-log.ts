import { factories } from '@strapi/strapi';

const UID = 'api::calendar-log.calendar-log';

// Расширенный core-сервис: метод write() пишет одну запись журнала действий
// календаря. Вызывается из движка (booking-engine) fire-and-forget — глотает
// ошибки (сбой лога не должен ронять уже применённую операцию).
export default factories.createCoreService(UID, ({ strapi }) => ({
  async write(entry: Record<string, unknown>): Promise<void> {
    try {
      await strapi.documents(UID).create({ data: entry as any });
    } catch (e: any) {
      strapi.log.error(`calendar-log write failed: ${e?.message || e}`);
    }
  },
}));
