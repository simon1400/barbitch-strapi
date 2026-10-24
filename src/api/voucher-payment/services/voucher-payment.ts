/**
 * voucher-payment service (s275). Vše podstatné je v booking-engine/services/voucher-payments.ts;
 * REST-routů kolekce nemá záměrně: platbu zakládá jen veřejná ručka s cenou z katalogu.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::voucher-payment.voucher-payment');
