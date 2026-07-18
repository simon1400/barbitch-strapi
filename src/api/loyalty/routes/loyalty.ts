export default {
  routes: [
    {
      method: 'POST',
      path: '/loyalty/run',
      handler: 'loyalty.run',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/loyalty/run',
      handler: 'loyalty.run',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
