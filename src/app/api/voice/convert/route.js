import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { voiceChange, extractAudio, getWorkspaceKey } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'

// POST /api/voice/convert — JSON: { video_url, voice_id, result_id? }
// 1. Calls v2 HF Space /api/extract-audio to decode mp3 from the video
// 2. POSTs that mp3 to ElevenLabs Speech-to-Speech with target voice_id
// 3. Uploads the converted mp3 to Supabase storage
// 4. Optionally patches results.meta.cloned_audio_url if result_id is provided
// Returns the public audio URL.
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    const { video_url, voice_id, result_id } = await req.json()
    if (!video_url || !voice_id) throw new Error('video_url + voice_id required')

    // 1. Extract audio (server ffmpeg on v2 HF Space — Vercel doesn't have ffmpeg)
    const audioBuf = await extractAudio(video_url)
    // 2. Speech-to-Speech
    const convertedBuf = await voiceChange(key, voice_id, new Uint8Array(audioBuf))
    // 3. Upload to Supabase storage
    const path = `${wsId}/voice/${voice_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
    const { error: upErr } = await supabase.storage.from('refs')
      .upload(path, new Uint8Array(convertedBuf), { contentType: 'audio/mpeg', upsert: false })
    if (upErr) throw new Error('storage upload: ' + upErr.message)
    const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)

    // 4. Patch result row if caller provided one
    if (result_id) {
      const { data: row } = await supabase.from('results').select('meta').eq('id', result_id).maybeSingle()
      const meta = { ...(row?.meta || {}), cloned_audio_url: publicUrl, voice_id }
      await supabase.from('results').update({ meta }).eq('id', result_id)
    }

    return NextResponse.json({ ok: true, audio_url: publicUrl })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
