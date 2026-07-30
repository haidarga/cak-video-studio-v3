// External API key validation for cross-platform calls (Caketing → Studio).
// Keys are stored hashed (bcrypt via crypto.subtle) in external_api_keys table.
// This module handles: key generation, hashing, validation, and workspace resolution.
//
// Key format: cak_<32 random hex chars>  (e.g. cak_a1b2c3d4e5f6...)
// Only the bcrypt hash is stored; the raw key is shown ONCE at creation time.

import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitCheck } from '@/lib/rate-limit'

const KEY_PREFIX_LEN = 8  // chars kept for display: "cak_a1b2..."

// Generate a new API key (returns the raw key — only time it's visible)
export function generateApiKey() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return `cak_${hex}`
}

// Hash a key for storage. Uses SHA-256 (fast, fine for high-entropy random keys
// — bcrypt would be safer for user-chosen passwords but overkill for 256-bit
// random keys, and crypto.subtle is available in Edge runtime unlike bcrypt).
async function hashKey(rawKey) {
  const encoder = new TextEncoder()
  const data = encoder.encode(rawKey)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Create and store a new API key for a workspace.
// Returns { key (raw, show once), keyId, prefix }.
export async function createExternalApiKey(workspaceId, userId, label = 'default') {
  const admin = createAdminClient()
  const rawKey = generateApiKey()
  const hash = await hashKey(rawKey)
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN)

  const { data, error } = await admin
    .from('external_api_keys')
    .insert({
      workspace_id: workspaceId,
      key_hash: hash,
      key_prefix: prefix,
      label,
      permissions: ['ingest', 'status'],
      is_active: true,
      created_by: userId,
    })
    .select('id, key_prefix, label, created_at')
    .single()

  if (error) throw new Error(`Failed to create API key: ${error.message}`)
  return { key: rawKey, ...data }
}

// Validate an API key from an incoming request.
// Returns { ok, workspaceId, keyId, permissions } or { ok: false, error }.
export async function validateExternalApiKey(req) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing or invalid Authorization header', status: 401 }
  }

  const rawKey = authHeader.slice(7).trim()
  if (!rawKey.startsWith('cak_') || rawKey.length < 20) {
    return { ok: false, error: 'Invalid API key format', status: 401 }
  }

  // Rate limit by key prefix (not full key, to avoid timing attacks on hash)
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN)
  const rl = rateLimitCheck(`ext:${prefix}`, { perMin: 30 })
  if (!rl.ok) {
    return { ok: false, error: `Rate limited. Retry after ${rl.retryAfter}s`, status: 429 }
  }

  const hash = await hashKey(rawKey)
  const admin = createAdminClient()

  const { data: keyRow, error } = await admin
    .from('external_api_keys')
    .select('id, workspace_id, permissions, is_active')
    .eq('key_hash', hash)
    .maybeSingle()

  if (error || !keyRow) {
    return { ok: false, error: 'Invalid API key', status: 401 }
  }

  if (!keyRow.is_active) {
    return { ok: false, error: 'API key is disabled', status: 403 }
  }

  // Touch last_used_at (fire-and-forget — don't block the request)
  admin.from('external_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', keyRow.id)
    .then(() => {})

  return {
    ok: true,
    workspaceId: keyRow.workspace_id,
    keyId: keyRow.id,
    permissions: keyRow.permissions || ['ingest'],
  }
}

// Check if a validated key has a specific permission
export function hasPermission(validationResult, permission) {
  return validationResult.ok && validationResult.permissions.includes(permission)
}
