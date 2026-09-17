import { factories } from '@strapi/strapi';

// Роутов у коллекции нет намеренно: пишет и читает её только модуль «Дозаписи»
// через ручки движка (/api/engine/admin/upsell/result|report) с гейтом ролей.
export default factories.createCoreService('api::upsell-attempt.upsell-attempt');
