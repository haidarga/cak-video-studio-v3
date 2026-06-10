// GOD MODE conversations API.
//
// GET  /api/god-mode/conversations          -> list user's conversations
//                                              (excluding archived by default)
// POST /api/god-mode/conversations          -> save/update a conversation
//                                              body: { id?, messages, brand_id? }
//                                              If id provided, updates that
//                                              thread. Else creates a new one
//                                              and returns the new id.
//
// Why one endpoint with method routing:
//   - All three operations are tiny + share auth/workspace resolution
//   - Avoids three separate route files for a thin feature
//   - Easier to read in one place

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

function deriveTitle(messages) {
  // First user message, truncated. Falls back to "New conversation".
  const firstUser = (messages || []).find((m) => m.role === 'user')
  if (!firstUser) return 'New conversation'
  const text = String(firstUser.content || '').trim().replace(/\s+/g, ' ')
  if (!text) return 'New conversation'
  return text.length > 60 ? text.slice(0, 57) + '...' : text
}

async function resolveWorkspace(supabase, userId) {
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, active_brand_id)')
    .eq('user_id', userId).order('added_at', { ascending: true }).limit(1)
  return data?.[0]?.workspaces || null
}

export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const ws = await resolveWorkspace(supabase, user.id)
  if (!ws) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  // List recent conversations (most-recently-updated first). Cap at 50 to
  // keep payload tight; user can search/scroll if they have more (future).
  // Only return metadata for the list view — messages payload loaded per-
  // conversation via the same endpoint with ?id=...
  const url = new URL(req.url)
  const specificId = url.searchParams.get('id')

  if (specificId) {
    // Single conversation load — returns full messages payload.
    const { data, error } = await supabase
      .from('god_mode_conversations')
      .select('id, title, messages, brand_id, message_count, created_at, updated_at')
      .eq('id', specificId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, conversation: data })
  }

  // List view — metadata only (no messages payload). Supports:
  //   - ?q=text     — case-insensitive substring match on title
  //   - ?brand_id   — filter by brand
  //   - ?limit      — override default 50 (max 200)
  // Title search uses ilike; for deeper full-text search across messages
  // body, add a tsvector column in a future migration.
  const q = (url.searchParams.get('q') || '').trim()
  const brandFilter = url.searchParams.get('brand_id') || null
  const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get('limit')) || 50))

  let query = supabase
    .from('god_mode_conversations')
    .select('id, title, brand_id, message_count, created_at, updated_at')
    .eq('user_id', user.id)
    .eq('workspace_id', ws.id)
    .eq('archived', false)
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (q) query = query.ilike('title', `%${q}%`)
  if (brandFilter) query = query.eq('brand_id', brandFilter)

  const { data, error } = await query
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, conversations: data || [], filters: { q, brand_id: brandFilter, limit } })
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const ws = await resolveWorkspace(supabase, user.id)
  if (!ws) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  let body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }

  const { id, messages, brand_id } = body || {}
  if (!Array.isArray(messages)) return NextResponse.json({ ok: false, error: 'messages array required' }, { status: 400 })

  const title = deriveTitle(messages)
  const message_count = messages.length

  if (id) {
    // Update existing thread.
    const { data, error } = await supabase
      .from('god_mode_conversations')
      .update({ messages, title, message_count, brand_id: brand_id || null })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, title, message_count, updated_at')
      .single()
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, conversation: data })
  }

  // Insert new thread.
  const { data, error } = await supabase
    .from('god_mode_conversations')
    .insert({
      workspace_id: ws.id,
      user_id: user.id,
      brand_id: brand_id || ws.active_brand_id || null,
      title,
      messages,
      message_count,
    })
    .select('id, title, message_count, created_at, updated_at')
    .single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, conversation: data })
}

export async function DELETE(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

  // Soft-delete (archive) rather than hard-delete so accidental deletions
  // can be recovered manually via supabase if needed. Hard delete can come
  // later if it matters for storage cost.
  const { error } = await supabase
    .from('god_mode_conversations')
    .update({ archived: true })
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
