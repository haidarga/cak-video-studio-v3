import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { listVoices, getWorkspaceKey } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    const voices = await listVoices(key)
    return NextResponse.json({ ok: true, voices })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
