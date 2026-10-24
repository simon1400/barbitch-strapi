/**
 * voucher router
 *
 * s275: `create` vypnut — web zakládá voucher jen přes POST /api/engine/vouchers/checkout
 * (cena z katalogu, číslo generuje server, platba Comgate). Dřív šlo přes REST založit
 * voucher s libovolnou částkou i datePay. Čtení a úpravy (admin) zůstávají.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::voucher.voucher', { except: ['create'] });
