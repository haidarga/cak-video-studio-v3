import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

// CRUD untuk postiz_accounts per workspace.
//
// GET    → list akun (api_key di-mask jadi boolean has_key)
// POST   → tambah akun baru { label, url, api_key }
// PATCH  → update akun { id, label?, url?, api_key? } (kosongin api_key buat keep yang lama)
// DELETE → hapus akun { id }

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { data, error } = await supabase
    .from('postiz_accounts')
    .select('id, label, url, api_key, created_at')
    .eq('workspace_id', wsId)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  // Never ship raw api_key — only a boolean indicating it's set.
  const accounts = (data || []).map((a) => ({
    id: a.id, label: a.label, url: a.url, has_key: !!a.api_key, created_at: a.created_at,
  }))
  return NextResponse.json({ ok: true, accounts })
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { label, url, api_key } = await req.json()
  if (!url?.trim() || !api_key?.trim()) {
    return NextResponse.json({ ok: false, error: 'url + api_key wajib diisi' }, { status: 400 })
  }
  const { data, error } = await supabase.from('postiz_accounts').insert({
    workspace_id: wsId,
    label: label?.trim() || 'Postiz',
    url: url.trim(),
    api_key: api_key.trim(),
  }).select('id').single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data.id })
}

export async function PATCH(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { id, label, url, api_key } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
  const patch = {}
  if (label != null) patch.label = String(label).trim() || 'Postiz'
  if (url != null) patch.url = String(url).trim()
  if (api_key != null && api_key !== '') patch.api_key = String(api_key).trim() // empty = keep existing
  if (!Object.keys(patch).length) return NextResponse.json({ ok: false, error: 'nothing to update' }, { status: 400 })

  const { error } = await supabase.from('postiz_accounts').update(patch).eq('id', id).eq('workspace_id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { id } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
  const { error } = await supabase.from('postiz_accounts').delete().eq('id', id).eq('workspace_id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
