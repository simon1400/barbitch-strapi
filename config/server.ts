export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1350),
  proxy: true, // 👈 Важно!
  url: env('PUBLIC_URL', 'https://strapi.barbitch.cz'),
  app: {
    keys: env.array('APP_KEYS'),
  },
});
