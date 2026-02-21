// import type { Core } from '@strapi/strapi';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    // Backup download route — registered as Koa middleware (bypasses plugin routing)
    strapi.server.use(async (ctx: any, next: any) => {
      if (ctx.path !== '/backup/download' || ctx.method !== 'GET') {
        return next();
      }

      const authHeader = ctx.headers?.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        ctx.status = 401;
        ctx.body = JSON.stringify({ error: 'Unauthorized' });
        return;
      }

      try {
        const knex = strapi.db.connection;
        const dbClient = process.env.DATABASE_CLIENT || 'sqlite';

        let tableNames: string[];
        if (dbClient === 'postgres') {
          const rows = await knex('information_schema.tables')
            .select('table_name')
            .where('table_schema', 'public')
            .where('table_type', 'BASE TABLE');
          tableNames = rows.map((r: any) => r.table_name as string);
        } else {
          const rows = await knex('sqlite_master')
            .select('name as table_name')
            .where('type', 'table')
            .whereNot('name', 'like', 'sqlite_%');
          tableNames = rows.map((r: any) => r.table_name as string);
        }

        const backup: Record<string, any> = {
          meta: {
            createdAt: new Date().toISOString(),
            database: dbClient,
            tablesCount: tableNames.length,
            version: '1.0',
          },
          tables: {},
        };

        for (const tableName of tableNames) {
          try {
            backup.tables[tableName] = await knex(tableName).select('*');
          } catch (e: any) {
            backup.tables[tableName] = { __error: e.message };
          }
        }

        const json = JSON.stringify(backup, null, 2);
        const date = new Date().toISOString().slice(0, 10);
        ctx.set('Content-Type', 'application/json; charset=utf-8');
        ctx.set('Content-Disposition', `attachment; filename="barbitch-backup-${date}.json"`);
        ctx.body = json;
      } catch (e: any) {
        ctx.status = 500;
        ctx.body = JSON.stringify({ error: e.message });
      }
    });

    // Backup restore route
    strapi.server.use(async (ctx: any, next: any) => {
      if (ctx.path !== '/backup/restore' || ctx.method !== 'POST') {
        return next();
      }

      const authHeader = ctx.headers?.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        ctx.status = 401;
        ctx.body = JSON.stringify({ error: 'Unauthorized' });
        return;
      }

      let backup: any;
      try {
        // Body is pre-parsed by strapi::body middleware (limit raised to 100mb)
        if (ctx.request.body && typeof ctx.request.body === 'object') {
          backup = ctx.request.body;
        } else {
          // Fallback: read raw stream (if body parser didn't run yet)
          const raw = await new Promise<string>((resolve, reject) => {
            let data = '';
            ctx.req.setEncoding('utf8');
            ctx.req.on('data', (chunk: string) => { data += chunk; });
            ctx.req.on('end', () => resolve(data));
            ctx.req.on('error', reject);
          });
          backup = JSON.parse(raw);
        }
      } catch (e: any) {
        ctx.status = 400;
        ctx.body = JSON.stringify({ error: 'Invalid JSON: ' + e.message });
        return;
      }

      if (!backup?.tables || typeof backup.tables !== 'object') {
        ctx.status = 400;
        ctx.body = JSON.stringify({ error: 'Invalid backup format' });
        return;
      }

      const knex = strapi.db.connection;
      const dbClient = process.env.DATABASE_CLIENT || 'sqlite';

      try {
        // Disable FK constraints during restore
        if (dbClient === 'postgres') {
          await knex.raw("SET session_replication_role = 'replica'");
        } else {
          await knex.raw('PRAGMA foreign_keys = OFF');
        }

        let restored = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const [tableName, rows] of Object.entries(backup.tables) as [string, any][]) {
          if (!Array.isArray(rows)) { skipped++; continue; }

          try {
            await knex(tableName).del();

            if (rows.length > 0) {
              const batchSize = 100;
              for (let i = 0; i < rows.length; i += batchSize) {
                await knex(tableName).insert(rows.slice(i, i + batchSize));
              }

              // Reset PostgreSQL sequences after insert
              if (dbClient === 'postgres') {
                try {
                  if ('id' in (rows[0] as any)) {
                    await knex.raw(
                      `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE(MAX(id), 1)) FROM ??`,
                      [tableName, tableName]
                    );
                  }
                } catch (_) {}
              }
            }

            restored++;
          } catch (e: any) {
            skipped++;
            errors.push(`${tableName}: ${e.message}`);
          }
        }

        ctx.status = 200;
        ctx.body = JSON.stringify({
          success: true,
          restored,
          skipped,
          total: Object.keys(backup.tables).length,
          ...(errors.length > 0 && { errors }),
        });
      } catch (e: any) {
        ctx.status = 500;
        ctx.body = JSON.stringify({ error: e.message });
      } finally {
        try {
          if (dbClient === 'postgres') {
            await knex.raw("SET session_replication_role = 'DEFAULT'");
          } else {
            await knex.raw('PRAGMA foreign_keys = ON');
          }
        } catch (_) {}
      }
    });

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
