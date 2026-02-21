export default () => [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'data: blob:',
            'market-assets.strapi.io',
            'ik.imagekit.io',
            '*.imagekit.io',
          ],
          'media-src': [
            "'self'",
            'data:',
            'blob:',
            'market-assets.strapi.io',
            'ik.imagekit.io',
            '*.imagekit.io',
          ],
          'frame-src': [
            "'self'",
            'https://call.imagekit.io',
            'https://*.imagekit.io',
          ],
          'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://call.imagekit.io',
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  { name: 'strapi::body', config: { jsonLimit: '100mb', formLimit: '100mb', textLimit: '100mb' } },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
