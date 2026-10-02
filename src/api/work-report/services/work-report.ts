/**
 * work-report service (s239). Вся логика — в booking-engine/services/work-reports.ts;
 * REST-роутов у коллекции нет намеренно: отчёты управляющей читает только владелец.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::work-report.work-report');
