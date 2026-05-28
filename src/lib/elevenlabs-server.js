// Server-side ElevenLabs client — uses the workspace's API key from `workspaces.elevenlabs_key`.
// Browser never touches the key. All ElevenLabs traffic flows through /api/voice/* routes.
//
// Voice-cloning approach (see migration 0012_voices.sql):
//   - Pipeline generates video with generate_audio:true → has lip-synced AI voice
//   - extractAudio() (server ffmpeg via v2 HF Space) gets the audio as mp3
//   - voiceChange() runs the audio through ElevenLabs Speech-to-Speech with persona voice_id
//   - Returned audio = same timing/lip-sync, new voice timbre
//   - We upload result to Supabase storage and stash URL in result.meta.cloned_audio_url

const BASE = 'https://api.elevenlabs.io'

function headers(apiKey, extra = {}) {
  if (!apiKey) throw new Error('Workspace belum punya ElevenLabs API key — set di Settings dulu')
  return { 'xi-api-key': apiKey, ...extra }
}

// ── List voices in this account ──
export async function listVoices(apiKey) {
  const r = await fetch(`${BASE}/v2/voices?page_size=100&include_total_count=false`, {
    headers: headers(apiKey),
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(`listVoices ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return data.voices || []
}

// ── Instant Voice Clone (IVC) — upload audio samples, get voice_id ──
// samples = Array of { buffer: Uint8Array|Buffer, name: string, type: string }
export async function cloneVoiceIVC(apiKey, name, description, samples) {
  if (!name?.trim()) throw new Error('Voice name kosong')
  if (!samples?.length) throw new Error('Butuh minimal 1 audio sample')
  const fd = new FormData()
  fd.append('name', name.trim())
  if (description) fd.append('description', description)
  for (const s of samples) {
    const blob = new Blob([s.buffer], { type: s.type || 'audio/mpeg' })
    fd.append('files', blob, s.name || 'sample.mp3')
  }
  const r = await fetch(`${BASE}/v1/voices/add`, {
    method: 'POST', headers: headers(apiKey), body: fd,
  })
  if (!r.ok) throw new Error(`clone ${r.status}: ${(await r.text()).slice(0, 240)}`)
  const data = await r.json()
  if (!data.voice_id) throw new Error('clone: voice_id missing')
  return { voice_id: data.voice_id, requires_verification: !!data.requires_verification }
}

// ── Voice Design — 3 previews from a text description ──
// Returns: [{ generated_voice_id, audio_base_64, media_type }]
export async function designVoice(apiKey, description, text, opts = {}) {
  if (!description?.trim() || description.trim().length < 20) {
    throw new Error('Voice description harus ≥ 20 karakter')
  }
  if (!text?.trim() || text.trim().length < 100) {
    throw new Error('Sample text harus ≥ 100 karakter')
  }
  const body = {
    voice_description: description.trim(),
    text: text.trim(),
    model_id: opts.modelId || 'eleven_multilingual_ttv_v2',
    output_format: 'mp3_44100_128',
  }
  const r = await fetch(`${BASE}/v1/text-to-voice/design`, {
    method: 'POST',
    headers: headers(apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`design ${r.status}: ${(await r.text()).slice(0, 240)}`)
  const data = await r.json()
  return data.previews || []
}

// ── Save a chosen design preview to the voice library → returns voice_id ──
export async function saveDesignedVoice(apiKey, generatedVoiceId, voiceName, voiceDescription) {
  if (!generatedVoiceId) throw new Error('generated_voice_id kosong')
  if (!voiceName?.trim()) throw new Error('Voice name kosong')
  const r = await fetch(`${BASE}/v1/text-to-voice`, {
    method: 'POST',
    headers: headers(apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      voice_name: voiceName.trim(),
      voice_description: voiceDescription?.trim() || `Designed voice — ${voiceName.trim()}`,
      generated_voice_id: generatedVoiceId,
    }),
  })
  if (!r.ok) throw new Error(`saveDesigned ${r.status}: ${(await r.text()).slice(0, 240)}`)
  const data = await r.json()
  if (!data.voice_id) throw new Error('saveDesigned: voice_id missing')
  return data.voice_id
}

export async function deleteVoice(apiKey, voiceId) {
  if (!voiceId) return
  const r = await fetch(`${BASE}/v1/voices/${voiceId}`, {
    method: 'DELETE', headers: headers(apiKey),
  })
  if (!r.ok && r.status !== 404) {
    throw new Error(`deleteVoice ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
}

// ── Speech-to-Speech: convert existing audio to a different voice ──
// audioBuf = Uint8Array/Buffer of mp3/wav input. Returns ArrayBuffer of mp3 output.
export async function voiceChange(apiKey, voiceId, audioBuf, opts = {}) {
  if (!voiceId) throw new Error('voice_id kosong')
  if (!audioBuf) throw new Error('audio kosong')
  const {
    modelId = 'eleven_multilingual_sts_v2',
    stability = 0.5,
    similarity_boost = 0.85,
    style = 0,
    remove_background_noise = true,
  } = opts
  const fd = new FormData()
  fd.append('audio', new Blob([audioBuf], { type: 'audio/mpeg' }), 'input.mp3')
  fd.append('model_id', modelId)
  fd.append('remove_background_noise', String(remove_background_noise))
  fd.append('voice_settings', JSON.stringify({ stability, similarity_boost, style, use_speaker_boost: true }))
  const r = await fetch(`${BASE}/v1/speech-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST', headers: headers(apiKey), body: fd,
  })
  if (!r.ok) throw new Error(`S2S ${r.status}: ${(await r.text()).slice(0, 240)}`)
  return await r.arrayBuffer()
}

// ── Extract audio from a video URL ──
// v3 (Vercel) doesn't have ffmpeg. v2 HF Space does — and v2 already exposes
// /api/extract-audio with CORS to vercel.app. We just proxy through it.
// Falls back to fetching the video directly if the user passes an audio URL.
export async function extractAudio(videoUrl) {
  const v2Base = process.env.V2_BACKEND_URL || 'https://cahmul2-cak-video-studio-v2.hf.space'
  const r = await fetch(`${v2Base}/api/extract-audio?url=${encodeURIComponent(videoUrl)}`)
  if (!r.ok) throw new Error(`extract-audio ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return await r.arrayBuffer()
}

// ── Helper: load workspace's ElevenLabs key (server-side) ──
// Throws if not set so callers don't accidentally pass empty string to ElevenLabs.
export async function getWorkspaceKey(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('workspaces').select('elevenlabs_key').eq('id', workspaceId).maybeSingle()
  if (error) throw new Error('load workspace: ' + error.message)
  if (!data?.elevenlabs_key) {
    throw new Error('Workspace belum punya ElevenLabs API key. Set di Settings dulu.')
  }
  return data.elevenlabs_key
}
