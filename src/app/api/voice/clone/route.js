import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { cloneVoiceIVC, getWorkspaceKey } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'

// POST /api/voice/clone
// multipart: name, description?, files[] (audio samples ≥10s each)
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    const form = await req.formData()
    const name = form.get('name')
    const description = form.get('description') || ''
    const files = form.getAll('files')
    if (!name) throw new Error('name required')
    if (!files.length) throw new Error('files required')
    const samples = []
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer())
      samples.push({ buffer: buf, name: f.name || 'sample.mp3', type: f.type || 'audio/mpeg' })
    }
    const result = await cloneVoiceIVC(key, String(name), String(description), samples)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
