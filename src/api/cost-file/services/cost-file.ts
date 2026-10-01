/**
 * cost-file service (s237). Вся логика — в booking-engine/services/costs.ts;
 * REST-роутов у коллекции нет намеренно: чеки выдаются только ручками движка руководству.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::cost-file.cost-file');
