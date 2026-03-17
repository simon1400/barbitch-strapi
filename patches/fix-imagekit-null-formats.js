/**
 * Patches strapi-plugin-imagekit to handle null/undefined formats
 * Bug: transformFormats() calls Object.entries(formats) without null check
 * This causes 500 errors on images without formats (e.g. small images, SVGs)
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(
  __dirname,
  '..',
  'node_modules',
  'strapi-plugin-imagekit',
  'dist',
  'server',
  'index.js'
);

if (!fs.existsSync(filePath)) {
  console.log('[patch] strapi-plugin-imagekit not found, skipping');
  process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');

const target = 'function transformFormats(formats, url, settings2, client) {';
const replacement = 'function transformFormats(formats, url, settings2, client) {\n  if (!formats) return {};';

if (content.includes('if (!formats) return {};')) {
  console.log('[patch] strapi-plugin-imagekit already patched');
  process.exit(0);
}

if (!content.includes(target)) {
  console.error('[patch] Could not find transformFormats function to patch');
  process.exit(1);
}

content = content.replace(target, replacement);
fs.writeFileSync(filePath, content, 'utf8');
console.log('[patch] strapi-plugin-imagekit patched: null formats guard added');
