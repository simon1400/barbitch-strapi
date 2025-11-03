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

async function backupFilesTable() {
  try {
    await client.connect();
    console.log('Connected to database\n');

    // Получаем все записи из таблицы files
    const result = await client.query('SELECT * FROM files ORDER BY id');

    console.log(`Found ${result.rows.length} files in database`);

    // Создаем имя файла с текущей датой и временем
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupDir = path.join(__dirname, 'backups');

    // Создаем папку backups если её нет
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log('Created backups directory');
    }

    const backupFile = path.join(backupDir, `files-backup-${timestamp}.json`);

    // Сохраняем данные в JSON файл
    fs.writeFileSync(backupFile, JSON.stringify(result.rows, null, 2));

    console.log(`\n✓ Backup created successfully!`);
    console.log(`Location: ${backupFile}`);
    console.log(`Total records: ${result.rows.length}`);

    // Статистика по провайдерам
    const cloudinaryCount = result.rows.filter(f => f.url && f.url.includes('cloudinary')).length;
    const imagekitCount = result.rows.filter(f => f.url && f.url.includes('imagekit')).length;

    console.log('\n=== Backup Statistics ===');
    console.log(`Cloudinary files: ${cloudinaryCount}`);
    console.log(`ImageKit files: ${imagekitCount}`);
    console.log(`Other files: ${result.rows.length - cloudinaryCount - imagekitCount}`);

  } catch (error) {
    console.error('Error creating backup:', error);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\nDatabase connection closed');
  }
}

backupFilesTable();
