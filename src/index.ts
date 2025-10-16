// import type { Core } from '@strapi/strapi';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }) {
    // Force Koa to trust proxy headers (for HTTPS behind Nginx)
    if (process.env.NODE_ENV === 'production') {
      strapi.server.app.proxy = true;
      console.log('🔒 Proxy mode enabled - trusting X-Forwarded-* headers');
    }
  },
};
