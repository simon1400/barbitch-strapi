/**
 * cost-request service (s236). Вся логика — в booking-engine/services/costs.ts;
 * REST-роутов у коллекции нет намеренно: запросы видит только руководство.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::cost-request.cost-request');
