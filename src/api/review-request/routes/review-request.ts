export default {
  routes: [
    {
      method: 'POST',
      path: '/review-request/run',
      handler: 'review-request.run',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/review-request/run',
      handler: 'review-request.run',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
