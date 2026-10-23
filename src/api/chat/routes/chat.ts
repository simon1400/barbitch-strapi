export default {
  routes: [
    {
      method: 'POST',
      path: '/chat/send',
      handler: 'chat.send',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/chat/messages',
      handler: 'chat.messages',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/chat/file',
      handler: 'chat.file',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/chat/status',
      handler: 'chat.status',
      config: { auth: false, policies: [], middlewares: ['global::rate-limit-cabinet'] },
    },
    {
      method: 'GET',
      path: '/chat/session',
      handler: 'chat.session',
      config: { auth: false, policies: [], middlewares: ['global::rate-limit-cabinet'] },
    },
    {
      method: 'POST',
      path: '/chat/contact',
      handler: 'chat.contact',
      config: { auth: false, policies: [], middlewares: ['global::rate-limit-cabinet'] },
    },
    {
      method: 'POST',
      path: '/chat/webhook',
      handler: 'chat.webhook',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
