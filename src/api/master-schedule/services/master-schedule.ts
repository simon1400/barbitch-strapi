/**
 * master-schedule service (s218). Вся логика — в booking-engine/services/master-schedule.ts;
 * REST-роутов у коллекции нет намеренно: план пишется только ручками движка.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::master-schedule.master-schedule');
