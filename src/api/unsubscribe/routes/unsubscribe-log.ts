// Журнал отписок — только чтение (вкладка «Напоминания о визите» владельца).
// Public-прав нет; админка читает сессией сотрудника (admin-session). Пишет только сервис.
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::unsubscribe.unsubscribe-log', { only: ['find'] });
