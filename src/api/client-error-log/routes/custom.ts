export default {
  routes: [
    {
      method: 'POST',
      path: '/client-error-logs/report',
      handler: 'client-error-log.report',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
