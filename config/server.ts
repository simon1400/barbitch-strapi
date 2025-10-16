export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1350),
  url: env('URL'),
  proxy: {
    enabled: true,
    ssl: env('NODE_ENV') === 'production',
    host: env('PROXY_HOST', 'demo-strapi.barbitch.cz'),
  },
  app: {
    keys: env.array('APP_KEYS'),
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
});
