// SERVER-ONLY. Replace a video's audio track, on the server, via fal's
// ffmpeg-api.
//
// WHY: the cloned-voice mux was the ONLY step of the voice-swap pipeline still
// running in the browser (ffmpeg.wasm). Everything before it — rehost, audio
// extract, ElevenLabs Speech-to-Speech, mp3 upload — already happens server-side
// in /api/voice/convert. That one browser-bound step is what made "auto voice
// changer" not actually automatic: close the tab mid-generation and the video
// gets ingested with the AI's native voice, forever.
//
// fal-ai/ffmpeg-api/merge-audio-video takes { video_url, audio_url } and returns
// { video: { url } }. We already hold a FAL_KEY and already pay fal, so this
// needs no new infrastructure — no HF Space endpoint, no VPS.
//
// Semantics match the client-side swapAudioInVideo(): the ORIGINAL audio track
// is replaced, not mixed under.

import { fal } from '@fal-ai/client'

const MUX_MODEL = 'fal-ai/ffmpeg-api/merge-audio-video'

let configured = false
function ensureConfigured(falKey) {
  const key = falKey || process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY belum di-set — gak bisa mux suara di server')
  if (!configured) {
    fal.config({ credentials: key })
    configured = true
  }
}

// Returns the muxed video URL. Throws on failure — callers decide whether to
// fall back to the browser mux.
export async function muxAudioOntoVideo(videoUrl, audioUrl, { falKey, onProgress } = {}) {
  if (!videoUrl || !audioUrl) throw new Error('muxAudioOntoVideo: video_url + audio_url wajib')
  ensureConfigured(falKey)

  const result = await fal.subscribe(MUX_MODEL, {
    input: { video_url: videoUrl, audio_url: audioUrl },
    logs: false,
    onQueueUpdate: (u) => onProgress?.(u?.status || 'processing'),
  })

  const out = result?.data?.video?.url || result?.video?.url || null
  if (!out) {
    throw new Error(`mux gagal — fal gak balikin URL video: ${JSON.stringify(result?.data || result).slice(0, 200)}`)
  }
  return out
}
