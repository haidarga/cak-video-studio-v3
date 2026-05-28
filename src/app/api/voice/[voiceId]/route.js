import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deleteVoice, getWorkspaceKey } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'

// DELETE /api/voice/[voiceId] — remove from ElevenLabs library.
// Also clears voice_id from any personas in this workspace that point to it.
export async function DELETE(_req, { params }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const { voiceId } = await params
    if (!voiceId) throw new Error('voiceId required')
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    await deleteVoice(key, voiceId)
    await supabase.from('personas')
      .update({ voice_id: null, voice_name: null, voice_source: null })
      .eq('workspace_id', wsId).eq('voice_id', voiceId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
