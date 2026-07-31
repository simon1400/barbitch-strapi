export default {
  routes: [
    {
      method: 'POST',
      path: '/comeback-reminder/run',
      handler: 'comeback-reminder.run',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/comeback-reminder/run',
      handler: 'comeback-reminder.run',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
