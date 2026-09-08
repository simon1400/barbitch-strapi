export default {
  routes: [
    {
      method: 'POST',
      path: '/campaign/send',
      handler: 'campaign.send',
      config: {
        // auth:false — проверку роли делает контроллер (наш HS256 admin-jwt)
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      // Письмо «voucher zaplacen» одному покупателю (страница «Potvrzení voucheru»).
      // Тот же прокси, что у рассылок: владелец → Strapi → client-роут с секретом.
      method: 'POST',
      path: '/campaign/voucher-confirmation',
      handler: 'campaign.voucherConfirmation',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
