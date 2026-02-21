export default {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/download',
      handler: 'backup.download',
      config: {
        policies: [],
        auth: false,
      },
    },
  ],
};
