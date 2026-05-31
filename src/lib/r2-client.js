// Cloudflare R2 client — drop-in replacement for Supabase Storage uploads.
//
// Why this exists: Supabase free tier caps Cached Egress at 5GB/billing cycle.
// A working video-gen app with media previews + editor exports hits that ceiling
// in days. R2 charges $0 for egress; storage is $0.015/GB. Net effect: same UX
// at ~1/10 the cost once we cross a few GB stored.
//
// API surface:
//   uploadToR2(key, body, contentType) -> public URL string
//   r2PublicUrl(key)                    -> public URL string (no upload)
//   deleteFromR2(key)                   -> void
//
// Server-only — uses S3 client credentials. Never import from a Client Component.

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

const accountId = process.env.R2_ACCOUNT_ID
const accessKeyId = process.env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
const bucket = process.env.R2_BUCKET || 'cak-video-refs'
const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

let _client = null
function client() {
  if (_client) return _client
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in env')
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return _client
}

// Upload bytes to R2 and return the public URL.
// CacheControl is set to 1 year immutable — uploaded assets are content-addressed
// (unique key per upload), so they never change. Aggressive caching = browser
// + CF CDN serve from cache, no repeat egress hit.
export async function uploadToR2(key, body, contentType) {
  if (!publicBase) throw new Error('R2_PUBLIC_URL not set in env')
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return r2PublicUrl(key)
}

export function r2PublicUrl(key) {
  if (!publicBase) throw new Error('R2_PUBLIC_URL not set in env')
  return `${publicBase}/${encodeURI(key).replace(/^\//, '')}`
}

export async function deleteFromR2(key) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

// Heuristic: is this URL ours (R2 bucket)?
export function isR2Url(url) {
  if (!url || typeof url !== 'string' || !publicBase) return false
  return url.startsWith(publicBase + '/')
}
