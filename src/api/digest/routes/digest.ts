export default {
  routes: [
    {
      method: 'POST',
      path: '/digest/send',
      handler: 'digest.send',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/digest/send',
      handler: 'digest.send',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
