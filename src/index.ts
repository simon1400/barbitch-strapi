// import type { Core } from '@strapi/strapi';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    // Middleware: hide inactive personnel from relation pickers
    strapi.server.use(async (ctx, next) => {
      const path = ctx.request.path;

      if (!path.includes('/content-manager/relations/')) {
        return next();
      }

      try {
        const relPath = path.split('/content-manager/relations/')[1];
        if (!relPath) return next();

        const parts = relPath.split('/').filter(Boolean).map(decodeURIComponent);

        let modelUid: string;
        let fieldName: string;

        if (parts.length === 2) {
          // /content-manager/relations/:model/:field
          modelUid = parts[0];
          fieldName = parts[1];
        } else if (parts.length === 3) {
          // /content-manager/relations/:model/:id/:field
          modelUid = parts[0];
          fieldName = parts[2];
        } else {
          return next();
        }

        const model = strapi.contentType(modelUid as any);
        const attribute = model?.attributes?.[fieldName];

        if (
          attribute?.type === 'relation' &&
          attribute.target === 'api::personal.personal'
        ) {
          // Add filter: show only active personnel (isActive != false)
          // Using $ne:false so existing entries without the field are still shown
          const separator = ctx.querystring ? '&' : '';
          ctx.querystring += `${separator}filters[isActive][$ne]=false`;
        }
      } catch (e) {
        // Skip if model/attribute not found
      }

      return next();
    });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }) {
    // Force Koa to trust proxy headers (for HTTPS behind Nginx)
    // But only if we're not running on localhost
    const isLocalhost = process.env.URL?.includes('localhost') || process.env.URL?.includes('127.0.0.1');

    if (process.env.NODE_ENV === 'production' && !isLocalhost) {
      strapi.server.app.proxy = true;
      console.log('🔒 Proxy mode enabled - trusting X-Forwarded-* headers');
    } else {
      strapi.server.app.proxy = false;
      console.log('🔓 Proxy mode disabled - running in local development mode');
    }
  },
};
