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
  ],
}
