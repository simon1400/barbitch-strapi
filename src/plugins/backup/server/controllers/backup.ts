export default ({ strapi }: { strapi: any }) => ({
  async download(ctx: any) {
    try {
      const backup = await strapi.plugin('backup').service('backup').generateBackup();
      const json = JSON.stringify(backup, null, 2);
      const date = new Date().toISOString().slice(0, 10);

      ctx.set('Content-Type', 'application/json; charset=utf-8');
      ctx.set('Content-Disposition', `attachment; filename="barbitch-backup-${date}.json"`);
      ctx.body = json;
    } catch (error: any) {
      ctx.throw(500, error.message);
    }
  },
});
