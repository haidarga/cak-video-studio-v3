#!/usr/bin/env node
// One-time migration: copy all files from Supabase Storage `refs` bucket to
// Cloudflare R2, then rewrite every URL column in the database to point at
// the new R2 URLs.
//
// Usage:
//   node scripts/migrate-supabase-to-r2.mjs            # dry run, prints plan
//   node scripts/migrate-supabase-to-r2.mjs --apply    # actually copy + rewrite
//   node scripts/migrate-supabase-to-r2.mjs --apply --skip-copy
//                                                     # only rewrite DB (files already mirrored)
//
// Env required (load from .env.local — see env.r2.example):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY    (NOT anon — needs storage read across all workspaces)
//   R2_ACCOUNT_ID
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET
//   R2_PUBLIC_URL
//
// Idempotent — re-runs skip already-migrated rows. URL mapping is detected
// by string prefix match against the Supabase storage public URL pattern.

import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load .env.local if present (no dotenv dependency — small custom parser)
async function loadDotenv() {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(__dirname, '..', name)
    try {
      const text = await fs.readFile(p, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 0) continue
        const k = trimmed.slice(0, eq).trim()
        let v = trimmed.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        if (!(k in process.env)) process.env[k] = v
      }
    } catch {}
  }
}
await loadDotenv()

const APPLY = process.argv.includes('--apply')
const SKIP_COPY = process.argv.includes('--skip-copy')

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const R2_ACCOUNT = process.env.R2_ACCOUNT_ID
const R2_AK = process.env.R2_ACCESS_KEY_ID
const R2_SK = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'cak-video-refs'
const R2_PUBLIC = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

if (!SB_URL || !SB_SERVICE_KEY) {
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required in env')
  process.exit(1)
}
if (!R2_ACCOUNT || !R2_AK || !R2_SK || !R2_PUBLIC) {
  console.error('ERROR: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_PUBLIC_URL required')
  process.exit(1)
}

const sb = createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } })
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_AK, secretAccessKey: R2_SK },
})

// Supabase storage public URL pattern:
//   {SB_URL}/storage/v1/object/public/refs/{path}
const SB_STORAGE_PREFIX = `${SB_URL}/storage/v1/object/public/refs/`

function isSbStorageUrl(u) {
  return typeof u === 'string' && u.startsWith(SB_STORAGE_PREFIX)
}
function sbPathFromUrl(u) {
  return u.slice(SB_STORAGE_PREFIX.length)
}
function r2UrlFromKey(key) {
  return `${R2_PUBLIC}/${encodeURI(key)}`
}

// Phase 1 — mirror files
async function mirrorBucket() {
  console.log('\n=== PHASE 1: mirror refs bucket to R2 ===')
  let total = 0, copied = 0, skipped = 0, failed = 0
  async function walk(prefix) {
    let page = 0
    while (true) {
      const { data, error } = await sb.storage.from('refs').list(prefix, {
        limit: 100, offset: page * 100, sortBy: { column: 'name', order: 'asc' },
      })
      if (error) { console.error(`  list ${prefix}: ${error.message}`); return }
      if (!data || data.length === 0) break
      for (const entry of data) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (!entry.id) { // folder
          await walk(fullPath)
          continue
        }
        total++
        // Check if already on R2
        try {
          await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: fullPath }))
          skipped++
          if (total % 50 === 0) console.log(`  [${total}] already-on-R2: ${fullPath}`)
          continue
        } catch {} // 404 = not yet copied, proceed
        if (!APPLY) {
          console.log(`  [plan] copy: ${fullPath}`)
          continue
        }
        try {
          const { data: blob, error: dlErr } = await sb.storage.from('refs').download(fullPath)
          if (dlErr) throw dlErr
          const buf = Buffer.from(await blob.arrayBuffer())
          await r2.send(new PutObjectCommand({
            Bucket: R2_BUCKET, Key: fullPath, Body: buf,
            ContentType: blob.type || 'application/octet-stream',
            CacheControl: 'public, max-age=31536000, immutable',
          }))
          copied++
          if (copied % 10 === 0) console.log(`  [${total}] copied ${copied} | ${fullPath} (${(buf.length / 1024).toFixed(0)}KB)`)
        } catch (e) {
          failed++
          console.error(`  FAIL ${fullPath}: ${e.message || e}`)
        }
      }
      if (data.length < 100) break
      page++
    }
  }
  await walk('')
  console.log(`Phase 1 done: total=${total} copied=${copied} skipped=${skipped} failed=${failed}`)
}

// Phase 2 — rewrite DB URLs. Tables + columns enumerated explicitly.
const TARGETS = [
  // [table, [{ col, kind }]] — kind: 'text' (single URL string) or 'jsonb_array' (array of URLs) or 'jsonb_path' (URL inside nested JSON, e.g. meta.cloned_audio_url)
  ['refs',           [{ col: 'fal_url', kind: 'text' }]],
  ['results',        [{ col: 'url', kind: 'text' }, { col: 'meta', kind: 'jsonb_path', subpath: 'cloned_audio_url' }]],
  ['personas',       [{ col: 'avatar_url', kind: 'text' }, { col: 'voice_source_url', kind: 'text' }]],
  ['camera_presets', [{ col: 'style_ref_urls', kind: 'jsonb_array' }]],
  ['voices',         [{ col: 'preview_url', kind: 'text' }]],
]

function rewriteUrl(u) {
  if (!isSbStorageUrl(u)) return null
  return r2UrlFromKey(sbPathFromUrl(u))
}

async function rewriteTable(table, columns) {
  console.log(`\n  ${table}: scanning ${columns.map((c) => c.col).join(', ')}`)
  let totalRows = 0, patchedRows = 0
  let page = 0
  const PAGE = 200
  while (true) {
    const { data, error } = await sb.from(table).select('id, ' + columns.map((c) => c.col).join(', ')).range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) { console.error(`    ${table} select: ${error.message}`); return }
    if (!data || data.length === 0) break
    for (const row of data) {
      totalRows++
      const patch = {}
      for (const { col, kind, subpath } of columns) {
        const v = row[col]
        if (v == null) continue
        if (kind === 'text') {
          const nu = rewriteUrl(v)
          if (nu) patch[col] = nu
        } else if (kind === 'jsonb_array') {
          if (!Array.isArray(v)) continue
          const nv = v.map((u) => rewriteUrl(u) || u)
          if (nv.some((u, i) => u !== v[i])) patch[col] = nv
        } else if (kind === 'jsonb_path' && subpath) {
          if (typeof v !== 'object' || !v[subpath]) continue
          const nu = rewriteUrl(v[subpath])
          if (nu) patch[col] = { ...v, [subpath]: nu }
        }
      }
      if (Object.keys(patch).length === 0) continue
      if (!APPLY) {
        console.log(`    [plan] ${table}.${row.id} -> ${Object.keys(patch).join(',')}`)
        continue
      }
      const { error: upErr } = await sb.from(table).update(patch).eq('id', row.id)
      if (upErr) console.error(`    update ${table}.${row.id}: ${upErr.message}`)
      else patchedRows++
    }
    if (data.length < PAGE) break
    page++
  }
  console.log(`    ${table}: total=${totalRows} patched=${patchedRows}`)
}

async function rewriteDb() {
  console.log('\n=== PHASE 2: rewrite DB URL columns ===')
  for (const [table, cols] of TARGETS) {
    await rewriteTable(table, cols)
  }
}

// Main
console.log(`Mode: ${APPLY ? 'APPLY (real writes)' : 'DRY RUN (preview only)'}${SKIP_COPY ? ' | skip-copy' : ''}`)
console.log(`Supabase: ${SB_URL}`)
console.log(`R2: bucket=${R2_BUCKET} public=${R2_PUBLIC}`)

if (!SKIP_COPY) await mirrorBucket()
await rewriteDb()

console.log('\nDone.')
console.log(APPLY ? '✓ Migration applied. Verify a few URLs in the dashboard, then deploy the new code.' : 'ℹ Dry run only. Re-run with --apply to copy + rewrite.')
