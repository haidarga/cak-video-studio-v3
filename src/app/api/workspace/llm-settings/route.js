import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { PROVIDER_CATALOG } from '@/lib/llm-server'

// GET — current llm_config + openai_key (masked) + provider catalog for the UI.
// PATCH — update llm_config { default, fallback[] } and/or openai_key.

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { data } = await supabase
    .from('workspaces').select('llm_config, openai_key').eq('id', wsId).maybeSingle()

  return NextResponse.json({
    ok: true,
    config: data?.llm_config || null,
    has_openai_key: !!data?.openai_key,
    catalog: PROVIDER_CATALOG,
  })
}

export async function PATCH(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const body = await req.json()
  const patch = {}
  if (body.config) {
    // Sanity check shape
    const c = body.config
    if (!c.default?.provider || !c.default?.model) {
      return NextResponse.json({ ok: false, error: 'config.default needs provider + model' }, { status: 400 })
    }
    if (!Array.isArray(c.fallback)) c.fallback = []
    patch.llm_config = {
      default: { provider: String(c.default.provider), model: String(c.default.model) },
      fallback: c.fallback
        .filter((f) => f?.provider && f?.model)
        .map((f) => ({ provider: String(f.provider), model: String(f.model) })),
    }
  }
  if ('openai_key' in body) {
    patch.openai_key = body.openai_key === '' ? null : String(body.openai_key)
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: false, error: 'nothing to update' }, { status: 400 })
  }
  const { error } = await supabase.from('workspaces').update(patch).eq('id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
