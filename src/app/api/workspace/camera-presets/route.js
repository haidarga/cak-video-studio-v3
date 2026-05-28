import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

// CRUD untuk camera_presets per workspace.
// GET    → list user-custom presets
// POST   → create new
// PATCH  → update existing { id, ...fields }
// DELETE → remove { id }
//
// Built-in presets live in src/lib/camera-presets.js and are returned client-
// side; this endpoint only exposes workspace customs.

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { data, error } = await supabase
    .from('camera_presets')
    .select('*')
    .eq('workspace_id', wsId)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  // Normalize shape: tokens/negatives/conflicts_with are jsonb arrays already.
  // preset_key becomes the dropdown id; ensure unique per workspace.
  const presets = (data || []).map((p) => ({
    id: p.preset_key,             // public id used in globalConfig
    _row_id: p.id,                // DB row id (for PATCH/DELETE)
    label: p.label,
    category: p.category,
    use_case: p.use_case,
    tokens: Array.isArray(p.tokens) ? p.tokens : [],
    negatives: Array.isArray(p.negatives) ? p.negatives : [],
    conflicts_with: Array.isArray(p.conflicts_with) ? p.conflicts_with : [],
    dominance: p.dominance,
    is_favorite: p.is_favorite,
  }))
  return NextResponse.json({ ok: true, presets })
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const body = await req.json()
  const preset_key = String(body.preset_key || body.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)
  if (!preset_key) return NextResponse.json({ ok: false, error: 'preset_key required' }, { status: 400 })
  if (!body.label?.trim()) return NextResponse.json({ ok: false, error: 'label required' }, { status: 400 })

  const row = {
    workspace_id: wsId,
    preset_key,
    label: String(body.label).trim().slice(0, 100),
    category: String(body.category || 'custom').trim(),
    use_case: String(body.use_case || '').trim().slice(0, 200),
    tokens: Array.isArray(body.tokens) ? body.tokens.filter(Boolean).map((t) => String(t).trim()).slice(0, 50) : [],
    negatives: Array.isArray(body.negatives) ? body.negatives.filter(Boolean).map((t) => String(t).trim()).slice(0, 50) : [],
    conflicts_with: Array.isArray(body.conflicts_with) ? body.conflicts_with : [],
    dominance: Number.isFinite(Number(body.dominance)) ? Number(body.dominance) : 5,
    is_favorite: !!body.is_favorite,
  }
  const { data, error } = await supabase.from('camera_presets').insert(row).select('id').single()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ ok: false, error: `Preset key "${preset_key}" udah ada — pakai key lain.` }, { status: 409 })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, id: data.id, preset_key })
}

export async function PATCH(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const body = await req.json()
  const id = body.id || body._row_id
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

  const patch = {}
  if (body.label != null) patch.label = String(body.label).trim().slice(0, 100)
  if (body.category != null) patch.category = String(body.category).trim()
  if (body.use_case != null) patch.use_case = String(body.use_case).trim().slice(0, 200)
  if (Array.isArray(body.tokens)) patch.tokens = body.tokens.filter(Boolean).map((t) => String(t).trim()).slice(0, 50)
  if (Array.isArray(body.negatives)) patch.negatives = body.negatives.filter(Boolean).map((t) => String(t).trim()).slice(0, 50)
  if (Array.isArray(body.conflicts_with)) patch.conflicts_with = body.conflicts_with
  if (body.dominance != null) patch.dominance = Number(body.dominance) || 5
  if (body.is_favorite != null) patch.is_favorite = !!body.is_favorite

  const { error } = await supabase
    .from('camera_presets')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const body = await req.json()
  const id = body.id || body._row_id
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

  const { error } = await supabase.from('camera_presets').delete().eq('id', id).eq('workspace_id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
