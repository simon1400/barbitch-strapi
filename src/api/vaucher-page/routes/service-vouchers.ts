// Vlastní veřejná ručka vedle core routeru (ten zůstává pro find/update stránky).
// auth:false jako u ručky movku — chrání ji rate-limit, odpověď je sestavená
// serverem (jen vybraná pole služby, žádné PII).
export default {
  routes: [
    {
      method: 'GET',
      path: '/vaucher-page/service-vouchers',
      handler: 'vaucher-page.serviceVouchers',
      config: { auth: false, policies: [], middlewares: ['global::rate-limit-engine'] },
    },
  ],
}
