import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { designVoice, getWorkspaceKey } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'

// POST /api/voice/design — JSON: { description, text }
// Returns 3 previews with base64 audio embedded so the client can play them
// without an extra round-trip. User picks one → POST /api/voice/save-design.
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    const { description, text } = await req.json()
    const previews = await designVoice(key, description, text)
    // Keep audio_base_64 in the response — payload is OK (3× ~30s mp3 ≈ 1MB total).
    return NextResponse.json({ ok: true, previews })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
