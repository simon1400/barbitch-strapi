/**
 * stock-order service (s252). Вся логика — в booking-engine/services/stock-orders.ts;
 * REST-роутов у коллекции нет намеренно (администраторам REST незакрытых коллекций открыт,
 * а в заказе — цены).
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::stock-order.stock-order');
