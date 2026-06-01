/**
 * Patches @strapi/content-manager relations `findAvailable` controller (the admin
 * relation-field dropdown / picker). Three fixes, all scoped to that endpoint:
 *
 *  1. HIDE DRAFTS — for Draft&Publish targets the picker normally lists draft rows
 *     and labels each (so unpublished / never-published documents show with a blue
 *     "Draft" badge). We force `published` status → only documents that have a
 *     published version appear. Applies to ALL relation fields (intentional).
 *
 *  2. SEARCH "+" — over the wire the admin sends e.g. `_q=6D%20+` (space as %20 but
 *     the literal `+` left unencoded). The `qs` parser decodes a literal `+` as a
 *     space → server receives "6D  " (two spaces) → ILIKE matches nothing. We recover
 *     the term from the raw querystring with decodeURIComponent (which keeps literal
 *     `+`), so "6D +" searches correctly.
 *
 *  3. SEARCH DIACRITICS — default `$containsi` → Postgres ILIKE is accent-sensitive
 *     ("mokry" != "Mokrý"). We rewrite the search into an `id IN (subquery)` using
 *     `unaccent(lower(col)) like unaccent(lower(?))`. Requires the Postgres `unaccent`
 *     extension (CREATE EXTENSION IF NOT EXISTS unaccent;). On non-postgres / on any
 *     metadata error it falls back to the original $containsi (with the recovered term).
 *
 * Version-pinned to @strapi/content-manager 5.46.1 — re-verify after Strapi upgrades.
 * Idempotent. Runs from `postinstall` (see package.json), patches both .js and .mjs.
 */
const fs = require('fs');
const path = require('path');

const baseDir = path.join(
  __dirname,
  '..',
  'node_modules',
  '@strapi',
  'content-manager',
  'dist',
  'server',
  'controllers'
);

const MARKER = '__bbForcedStatus';

// Per-file build of the replacements (util references differ between CJS/ESM bundles)
function patchFile(fileName, isOperatorRef, contentTypesRef) {
  const filePath = path.join(baseDir, fileName);

  if (!fs.existsSync(filePath)) {
    console.log(`[patch] relations: ${fileName} not found, skipping`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes(MARKER)) {
    console.log(`[patch] relations: ${fileName} already patched`);
    return;
  }

  // --- Fix 1: helper that forces "published" for Draft&Publish targets ---
  const helperAnchor = 'const validateLocale = (sourceUid, targetUid, locale)=>{';
  const helper =
    'const __bbForcedStatus = (status, uid)=>{ try { const m = strapi.getModel(uid); if (m && ' +
    contentTypesRef +
    ".hasDraftAndPublish(m)) return 'published'; } catch (e) {} return status; };\n";
  if (!content.includes(helperAnchor)) {
    console.error(`[patch] relations: ${fileName} — validateLocale anchor not found`);
    process.exit(1);
  }
  content = content.replace(helperAnchor, helper + helperAnchor);

  // Wrap both publishedAt clauses inside findAvailable with the forced status
  const draftA = 'publishedAt: getPublishedAtClause(status, targetUid)';
  const draftB = 'const publishedAt = getPublishedAtClause(status, targetUid);';
  if (!content.includes(draftA) || !content.includes(draftB)) {
    console.error(`[patch] relations: ${fileName} — getPublishedAtClause targets not found`);
    process.exit(1);
  }
  content = content
    .split(draftA)
    .join('publishedAt: getPublishedAtClause(__bbForcedStatus(status, targetUid), targetUid)')
    .split(draftB)
    .join('const publishedAt = getPublishedAtClause(__bbForcedStatus(status, targetUid), targetUid);');

  // --- Fix 2 + 3: replace the whole `if (_q) { ... }` search block ---
  const searchRe = /if \(_q\) \{[\s\S]*?\[_filter\]: _q\s*\}\s*\}\s*\)\s*;\s*\}/;
  if (!searchRe.test(content)) {
    console.error(`[patch] relations: ${fileName} — search block not found`);
    process.exit(1);
  }
  const newBlock =
    'if (_q) {\n' +
    "            let __bbTerm = _q;\n" +
    "            try { const __m = (ctx.request.querystring || '').match(/(?:^|&)_q=([^&]*)/); if (__m) __bbTerm = decodeURIComponent(__m[1]); } catch (e) {}\n" +
    "            let __bbDone = false;\n" +
    "            try {\n" +
    "                const __dialect = (strapi.db.dialect && strapi.db.dialect.client) || (strapi.db.connection.client && strapi.db.connection.client.config && strapi.db.connection.client.config.client) || '';\n" +
    "                if (__dialect === 'postgres' || __dialect === 'pg') {\n" +
    "                    const __meta = strapi.db.metadata.get(targetUid);\n" +
    "                    const __col = (__meta.attributes[mainField] && __meta.attributes[mainField].columnName) || mainField;\n" +
    "                    const __sub = strapi.db.connection(__meta.tableName).select('id').whereRaw('unaccent(lower(??)) like unaccent(lower(?))', [__col, '%' + __bbTerm + '%']);\n" +
    "                    addFiltersClause(queryParams, { id: { $in: __sub } });\n" +
    "                    __bbDone = true;\n" +
    "                }\n" +
    "            } catch (e) { try { strapi.log.warn('[barbitch relsearch] fallback: ' + e.message); } catch (e2) {} }\n" +
    "            if (!__bbDone) {\n" +
    "                const _filter = " +
    isOperatorRef +
    "('where', query._filter) ? query._filter : '$containsi';\n" +
    "                addFiltersClause(queryParams, { [mainField]: { [_filter]: __bbTerm } });\n" +
    "            }\n" +
    "        }";
  content = content.replace(searchRe, newBlock);

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[patch] relations: ${fileName} patched (hide drafts + search + / diacritics)`);
}

patchFile('relations.js', 'strapiUtils.isOperatorOfType', 'strapiUtils.contentTypes');
patchFile('relations.mjs', 'isOperatorOfType', 'contentTypes');
