// Toggle the workspace-level "TikTok auto-add music" flag. Read by the
// Postiz post route when scheduling TikTok content — when true, Postiz
// passes autoAddMusic='yes' so TikTok attaches a trending sound on
// landing (boosts sound-algo discoverability).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

export async function PATCH(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 400 })

  const { enabled } = await req.json()
  const { error } = await supabase
    .from('workspaces')
    .update({ tiktok_auto_add_music: !!enabled })
    .eq('id', wsId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
