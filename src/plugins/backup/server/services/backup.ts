export default ({ strapi }: { strapi: any }) => ({
  async generateBackup(): Promise<Record<string, any>> {
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
      // SQLite fallback
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

    return backup;
  },
});
