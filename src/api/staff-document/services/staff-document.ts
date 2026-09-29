/**
 * staff-document service (s224). Вся логика — в booking-engine/services/staff.ts;
 * REST-роутов у коллекции нет намеренно: сканы выдаются только ручками движка руководству.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::staff-document.staff-document');
