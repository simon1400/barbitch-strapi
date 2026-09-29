/**
 * staff-checklist-item service (s231). Вся логика — в booking-engine/services/staff.ts;
 * REST-роутов у коллекции нет намеренно: каталог правит только руководство.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::staff-checklist-item.staff-checklist-item');
