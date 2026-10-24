/**
 * firm-inquiry service (s274). Vše podstatné je v booking-engine/services/firm-inquiries.ts;
 * REST-routů kolekce nemá záměrně: zápis jen veřejnou ručkou s kontrolou, čtení jen vedení.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::firm-inquiry.firm-inquiry');
