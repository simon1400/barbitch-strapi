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
  ],
};
