/**
 * shift-handover service (s265). Вся логика — в booking-engine/services/smena.ts;
 * REST-роутов у коллекции нет намеренно: сообщения передачи смены видят только участники и руководство.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::shift-handover.shift-handover');
