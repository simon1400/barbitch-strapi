/**
 * vaucher-page service
 */

import { factories } from '@strapi/strapi';

import { shapeServiceVouchers } from './vaucher-page-core';

const UID = 'api::vaucher-page.vaucher-page' as const;

export default factories.createCoreService(UID, ({ strapi }) => ({
  /**
   * Karty „Voucher na službu“ pro web. Čte se publikovaná verze stránky;
   * cena a dostupnost přímo ze služby katalogu rezervací. Vlastní ručka, protože
   * přes REST by Public role relaci na salon-service mlčky vyřízla.
   */
  async serviceVouchers() {
    const page: any = await strapi.documents(UID).findFirst({
      status: 'published',
      populate: {
        serviceVouchers: {
          populate: {
            service: { fields: ['documentId', 'title', 'price', 'active', 'onlineBookable'] },
            photo: true,
          },
        },
      },
    });
    return shapeServiceVouchers(page?.serviceVouchers);
  },
}));
