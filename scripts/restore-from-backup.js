const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '.env.local' });

const client = new Client({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
  } : false
});

async function restoreFromBackup() {
  try {
    // Проверяем наличие аргумента с именем файла бэкапа
    const backupFileName = process.argv[2];

    if (!backupFileName) {
      console.error('Error: Please provide backup file name');
      console.log('\nUsage: node restore-from-backup.js <backup-file-name>');
      console.log('Example: node restore-from-backup.js files-backup-2025-11-03T10-30-00.json');

      // Показываем доступные бэкапы
      const backupDir = path.join(__dirname, 'backups');
      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          console.log('\nAvailable backups:');
          files.forEach(f => console.log(`  - ${f}`));
        }
      }
      process.exit(1);
    }

    const backupFile = path.join(__dirname, 'backups', backupFileName);

    if (!fs.existsSync(backupFile)) {
      console.error(`Error: Backup file not found: ${backupFile}`);
      process.exit(1);
    }

    console.log(`Reading backup from: ${backupFile}\n`);
    const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

    console.log(`Found ${backupData.length} records in backup`);

    await client.connect();
    console.log('Connected to database\n');

    console.log('Restoring files...\n');

    let restored = 0;
    let errors = 0;

    for (const file of backupData) {
      try {
        await client.query(
          'UPDATE files SET url = $1, provider = $2 WHERE id = $3',
          [file.url, file.provider, file.id]
        );
        restored++;

        if (restored % 10 === 0) {
          console.log(`Restored ${restored}/${backupData.length} files...`);
        }
      } catch (error) {
        errors++;
        console.error(`Error restoring file ${file.id}: ${error.message}`);
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('=== Restore Summary ===');
    console.log('='.repeat(50));
    console.log(`Total records: ${backupData.length}`);
    console.log(`Successfully restored: ${restored}`);
    console.log(`Errors: ${errors}`);

    if (errors === 0) {
      console.log('\n✓ Restore completed successfully!');
    } else {
      console.log('\n⚠ Restore completed with errors');
    }

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\nDatabase connection closed');
  }
}

restoreFromBackup();
