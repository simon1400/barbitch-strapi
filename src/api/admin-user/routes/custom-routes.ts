export default {
  routes: [
    {
      method: 'POST',
      path: '/admin-users/login',
      handler: 'admin-user.login',
      config: {
        auth: false, // Публичный endpoint
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/admin-users/check-status/:id',
      handler: 'admin-user.checkStatus',
      config: {
        auth: false, // Публичный endpoint для проверки статуса
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/admin-users/administrator-data/:username',
      handler: 'admin-user.getAdministratorData',
      config: {
        auth: false, // Публичный endpoint для личного кабинета
        policies: [],
        middlewares: [],
      },
    },
  ],
}
