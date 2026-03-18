export default {
  routes: [
    {
      method: 'POST',
      path: '/review-sync/sync',
      handler: 'review-sync.sync',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
