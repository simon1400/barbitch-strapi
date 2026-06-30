export default {
  routes: [
    {
      method: 'GET',
      path: '/shift-selfcheck',
      handler: 'shift-selfcheck.check',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
