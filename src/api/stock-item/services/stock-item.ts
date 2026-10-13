/**
 * stock-item service (s251). Вся логика — в booking-engine/services/stock.ts;
 * REST-роутов у коллекции нет намеренно (администраторам REST незакрытых коллекций открыт).
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::stock-item.stock-item');
