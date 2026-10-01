/**
 * cost-cash-skip service (s238). Вся логика — в booking-engine/services/costs.ts;
 * REST-роутов у коллекции нет намеренно: пометки ставятся только ручками движка руководством.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::cost-cash-skip.cost-cash-skip');
