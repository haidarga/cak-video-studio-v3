import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { voiceChange, extractAudio, getWorkspaceKey, rehostToFal } from '@/lib/elevenlabs-server'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertBudget } from '@/lib/budget-gate'
import { uploadToR2 } from '@/lib/r2-client'
import { muxAudioOntoVideo } from '@/lib/fal-mux'

// Re-host (download from R2 + upload to fal) + ffmpeg extract + S2S + upload can
// take a while on a multi-MB clip — give it room so it doesn't 504 mid-convert.
// +mux step (fal ffmpeg) on top of rehost + extract + S2S + upload.
export const maxDuration = 180
const MAX_MS = maxDuration * 1000
// Leave room to still write the DB row and serialize a response after the mux.
const SAFETY_MS = 20_000
// Below this there's no point starting a queue job we can't wait out.
const MIN_MUX_MS = 25_000

// Rough ElevenLabs Speech-to-Speech cost per call. Actual cost depends on
// minutes of audio; this is a conservative estimate for one shot (~10s) used
// for the budget pre-check. Refine if you start hitting false rejections.
const VOICE_CONVERT_USD = 0.30

// POST /api/voice/convert — JSON: { video_url, voice_id, result_id? }
// 1. Calls v2 HF Space /api/extract-audio to decode mp3 from the video
// 2. POSTs that mp3 to ElevenLabs Speech-to-Speech with target voice_id
// 3. Uploads the converted mp3 to Supabase storage
// 4. Optionally patches results.meta.cloned_audio_url if result_id is provided
// Returns the public audio URL.
export async function POST(req) {
  const startedAt = Date.now()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const key = await getWorkspaceKey(supabase, wsId)
    const { video_url, voice_id, result_id } = await req.json()
    if (!video_url || !voice_id) throw new Error('video_url + voice_id required')

    const gate = await assertBudget(supabase, wsId, { projectedUsd: VOICE_CONVERT_USD })
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

    // 1. Extract audio (server ffmpeg on v2 HF Space — Vercel doesn't have ffmpeg).
    // The Space can't reach our R2 host (pub-*.r2.dev is blocked from datacenter
    // fleets), so any non-fal video is re-hosted to fal.media first (the Space
    // CAN fetch fal.media). fal-sourced videos are passed straight through.
    let srcUrl = video_url
    if (!/\.fal\.media\//i.test(video_url)) {
      const { data: ws } = await supabase.from('workspaces').select('fal_key').eq('id', wsId).maybeSingle()
      const falKey = ws?.fal_key || process.env.FAL_KEY || ''
      srcUrl = await rehostToFal(video_url, falKey)
    }
    const audioBuf = await extractAudio(srcUrl)
    // 2. Speech-to-Speech
    const convertedBuf = await voiceChange(key, voice_id, new Uint8Array(audioBuf))
    // 3. Upload to R2 (cheap egress for cloned-voice mp3s)
    const r2Key = `cloned-voice/${wsId}/${voice_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
    const publicUrl = await uploadToR2(r2Key, Buffer.from(new Uint8Array(convertedBuf)), 'audio/mpeg')

    // 4. Patch result row if caller provided one. Workspace-scope the
    // read AND update to prevent cross-tenant result hijacking — without
    // these filters, a user could overwrite another workspace's result
    // meta by guessing the id.
    // 5. MUX on the server. This was the last browser-bound step of the pipeline,
    // and the reason "auto voice changer" wasn't actually automatic — with the
    // mux in the tab, closing it mid-generation left the video with the AI voice
    // permanently. fal's ffmpeg-api does it with the FAL_KEY we already hold.
    // Best-effort: if it fails we still return audio_url so the caller can fall
    // back to the browser mux rather than losing the converted voice entirely.
    let voicedUrl = null
    let muxError = null
    // Only attempt the mux if enough of the function budget is left. Everything
    // above (rehost + extract + S2S + upload) already consumed part of it, and
    // being killed mid-mux costs the whole request: Vercel returns a 504 with an
    // HTML body, the browser can't JSON.parse it, and the cloned audio we just
    // PAID for is thrown away. Bailing early keeps audio_url, so the caller
    // falls back to the browser mux instead of losing the work.
    const elapsed = Date.now() - startedAt
    const budgetLeft = MAX_MS - elapsed - SAFETY_MS
    if (budgetLeft < MIN_MUX_MS) {
      muxError = `skip mux: sisa waktu ${Math.round(budgetLeft / 1000)}s gak cukup (butuh ≥${MIN_MUX_MS / 1000}s) — di-mux di browser aja`
      console.warn('[voice/convert]', muxError)
    } else try {
      const { data: ws2 } = await supabase.from('workspaces').select('fal_key').eq('id', wsId).maybeSingle()
      voicedUrl = await muxAudioOntoVideo(video_url, publicUrl, {
        falKey: ws2?.fal_key || process.env.FAL_KEY,
        timeoutMs: budgetLeft,
      })
    } catch (e) {
      muxError = String(e?.message || e).slice(0, 300)
      console.warn('[voice/convert] server mux failed, caller may fall back to browser mux:', muxError)
    }

    // 6. Patch result row if caller provided one. Workspace-scope the
    // read AND update to prevent cross-tenant result hijacking — without
    // these filters, a user could overwrite another workspace's result
    // meta by guessing the id.
    if (result_id) {
      const { data: row } = await supabase.from('results').select('meta')
        .eq('id', result_id).eq('workspace_id', wsId).maybeSingle()
      if (row) {
        const meta = {
          ...(row?.meta || {}),
          cloned_audio_url: publicUrl,
          voice_id,
          ...(voicedUrl ? { original_url: row?.meta?.original_url || video_url, voiced_by: 'server' } : {}),
        }
        await supabase.from('results').update({
          meta,
          // Only move results.url once the muxed video actually exists.
          ...(voicedUrl ? { url: voicedUrl } : {}),
        }).eq('id', result_id).eq('workspace_id', wsId)
      }
    }

    return NextResponse.json({ ok: true, audio_url: publicUrl, video_url: voicedUrl, muxed: !!voicedUrl, mux_error: muxError })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
