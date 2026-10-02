/**
 * owner-task service (s240). Вся логика — в booking-engine/services/owner-tasks.ts;
 * REST-роутов у коллекции нет намеренно: поручения видят только владелец и исполнитель.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::owner-task.owner-task');
