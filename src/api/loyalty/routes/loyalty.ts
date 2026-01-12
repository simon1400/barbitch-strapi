export default {
  routes: [
    {
      method: 'POST',
      path: '/loyalty/register',
      handler: 'loyalty.register',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/loyalty/login',
      handler: 'loyalty.login',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/loyalty/me',
      handler: 'loyalty.me',
      config: {
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/loyalty/status/:clientId',
      handler: 'loyalty.getStatus',
      config: {
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/loyalty/rewards',
      handler: 'loyalty.getRewards',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/loyalty/calculate-points',
      handler: 'loyalty.calculatePoints',
      config: {
        policies: [],
      },
    },
  ],
};