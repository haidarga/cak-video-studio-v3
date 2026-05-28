import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { saveDesignedVoice, getWorkspaceKey } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'

// POST /api/voice/save-design — JSON: { generated_voice_id, voice_name, voice_description? }
// Commits a design preview to the voice library, returns the permanent voice_id.
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    const { generated_voice_id, voice_name, voice_description } = await req.json()
    const voice_id = await saveDesignedVoice(key, generated_voice_id, voice_name, voice_description)
    return NextResponse.json({ ok: true, voice_id })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
