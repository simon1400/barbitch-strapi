export default {
  routes: [
    {
      method: 'POST',
      path: '/shift-revert',
      handler: 'shift-revert.revert',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
