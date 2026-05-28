import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

// GET — return current workspace API key statuses (only booleans, never the keys themselves)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
  const { data } = await supabase
    .from('workspaces')
    .select('name, fal_key, gemini_key, postiz_url, postiz_key, elevenlabs_key')
    .eq('id', wsId).maybeSingle()
  return NextResponse.json({
    ok: true,
    workspace_id: wsId,
    name: data?.name || '',
    has_fal: !!data?.fal_key, has_gemini: !!data?.gemini_key,
    has_postiz: !!(data?.postiz_url && data?.postiz_key),
    has_elevenlabs: !!data?.elevenlabs_key,
    postiz_url: data?.postiz_url || '',
  })
}

// PATCH — update workspace API keys. Only set the keys the user provides
// (so they can update one without clearing the others). Empty string clears.
export async function PATCH(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const body = await req.json()
  const patch = {}
  for (const k of ['fal_key', 'gemini_key', 'postiz_url', 'postiz_key', 'elevenlabs_key']) {
    if (k in body) patch[k] = body[k] === '' ? null : body[k]
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: false, error: 'nothing to update' }, { status: 400 })
  }
  const { error } = await supabase.from('workspaces').update(patch).eq('id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
