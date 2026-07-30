// POST/GET/DELETE /api/external/keys — manage external API keys.
//
// Auth: Normal Supabase session (workspace owner only).
// POST = generate new key, GET = list keys, DELETE = revoke a key.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { createExternalApiKey } from '@/lib/external-auth'
import { createAdminClient } from '@/lib/supabase/admin'

// GET /api/external/keys — list all keys for the workspace (no raw keys, only prefixes)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 400 })

  const { data: keys, error } = await supabase
    .from('external_api_keys')
    .select('id, key_prefix, label, permissions, is_active, last_used_at, created_at')
    .eq('workspace_id', wsId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, keys: keys || [] })
}

// POST /api/external/keys — generate a new API key
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 400 })

  // Verify ownership
  const { data: ws } = await supabase
    .from('workspaces')
    .select('owner_id')
    .eq('id', wsId)
    .single()
  if (ws?.owner_id !== user.id) {
    return NextResponse.json({ ok: false, error: 'only workspace owner can create API keys' }, { status: 403 })
  }

  const { label } = await req.json().catch(() => ({}))

  try {
    const result = await createExternalApiKey(wsId, user.id, label || 'default')
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}

// DELETE /api/external/keys — revoke (deactivate) a key
export async function DELETE(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 400 })

  const { keyId } = await req.json().catch(() => ({}))
  if (!keyId) return NextResponse.json({ ok: false, error: 'keyId is required' }, { status: 400 })

  // Use admin client because RLS policy restricts delete to owner
  const admin = createAdminClient()
  const { error } = await admin
    .from('external_api_keys')
    .update({ is_active: false })
    .eq('id', keyId)
    .eq('workspace_id', wsId)

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
