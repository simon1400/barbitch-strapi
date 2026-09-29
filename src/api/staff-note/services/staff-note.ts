/**
 * staff-note service (s224). Вся логика — в booking-engine/services/staff.ts;
 * REST-роутов у коллекции нет намеренно: заметки видит только руководство.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::staff-note.staff-note');
