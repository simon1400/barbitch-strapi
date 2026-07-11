export default {
  routes: [
    {
      method: 'POST',
      path: '/booking-mirror/sync',
      handler: 'booking-mirror.sync',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/booking-mirror/sync',
      handler: 'booking-mirror.sync',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
