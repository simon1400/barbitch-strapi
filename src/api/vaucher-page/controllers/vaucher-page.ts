/**
 * vaucher-page controller
 */

import { factories } from '@strapi/strapi'

const UID = 'api::vaucher-page.vaucher-page' as const

export default factories.createCoreController(UID, ({ strapi }) => ({
  // GET /api/vaucher-page/service-vouchers — karty voucherů na službu (web, veřejné).
  async serviceVouchers(ctx) {
    ctx.body = { data: await strapi.service(UID).serviceVouchers() }
  },
}))
