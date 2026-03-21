/**
 * Migrate local Strapi uploads to ImageKit CDN.
 *
 * Usage: cd strapi && node scripts/migrate-local-to-imagekit.js
 *
 * What it does:
 * 1. Files with /uploads/ URL → uploads to ImageKit, updates DB
 * 2. Files already on ImageKit but provider='local' → fixes provider in DB
 */

const ImageKit = require('imagekit')
const { Client } = require('pg')
const path = require('path')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const STRAPI_PUBLIC_URL = 'https://strapi.barbitch.cz'

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
})

const db = new Client({
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  ssl: { rejectUnauthorized: false },
})

async function migrate() {
  await db.connect()
  console.log('Connected to database\n')

  const { rows: allLocal } = await db.query(
    `SELECT id, name, url, hash, ext, mime, provider_metadata FROM files WHERE provider = 'local' ORDER BY id`
  )

  const needUpload = allLocal.filter(f => f.url.startsWith('/uploads/'))
  const alreadyOnIK = allLocal.filter(f => f.url.includes('ik.imagekit.io'))

  console.log(`=== Phase 1: Fix provider for ${alreadyOnIK.length} files already on ImageKit ===\n`)

  for (const file of alreadyOnIK) {
    await db.query(`UPDATE files SET provider = 'imagekit' WHERE id = $1`, [file.id])
    console.log(`[${file.id}] ✓ ${file.name} — provider fixed`)
  }

  console.log(`\n=== Phase 2: Upload ${needUpload.length} local files to ImageKit ===\n`)

  let success = 0
  let failed = 0

  for (const file of needUpload) {
    const sourceUrl = `${STRAPI_PUBLIC_URL}${file.url}`
    const fileName = `${file.hash}${file.ext}`

    try {
      process.stdout.write(`[${file.id}] ${file.name} ... `)

      const result = await imagekit.upload({
        file: sourceUrl,
        fileName: fileName,
        folder: '/strapi-uploads/',
        useUniqueFileName: false,
      })

      const providerMetadata = JSON.stringify({
        fileId: result.fileId,
        filePath: result.filePath,
        url: result.url,
        thumbnailUrl: result.thumbnailUrl,
      })

      await db.query(
        `UPDATE files SET provider = 'imagekit', url = $1, provider_metadata = $2 WHERE id = $3`,
        [result.url, providerMetadata, file.id]
      )

      console.log(`✓ ${result.url}`)
      success++
    } catch (err) {
      console.log(`✗ ${err.message}`)
      failed++
    }
  }

  console.log(`\nDone: ${alreadyOnIK.length} provider fixed, ${success} uploaded, ${failed} failed`)
  await db.end()
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
