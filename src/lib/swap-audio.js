// Replace a video's audio track with a different audio file (cloned voice)
// via ffmpeg.wasm — the final step of the QC "Change Voice" flow:
//   1. /api/voice/convert extracts the video's audio (v2 HF Space ffmpeg)
//      and runs it through ElevenLabs Speech-to-Speech with the persona's
//      voice_id → same timing/phonemes, new voice timbre → mp3 on R2.
//   2. THIS function muxes that mp3 back onto the video: original audio
//      dropped (video "muted"), cloned voice becomes the only track.
// Lip-sync survives because S2S preserves the input audio's timing 1:1.
//
// -c:v copy = video stream untouched (instant, zero quality loss). Only
// the tiny audio track gets encoded (aac 256k 48kHz, TikTok/IG standard).

import { getFFmpeg, fetchToUint8 } from './editor-render.js'

export async function swapAudioInVideo(videoUrl, audioUrl, onProgress) {
  onProgress?.('Loading ffmpeg...')
  const ff = await getFFmpeg((msg) => {
    if (msg.includes('frame=') || msg.includes('time=')) onProgress?.('Muxing cloned voice...')
  })
  onProgress?.('Downloading video...')
  await ff.writeFile('swap-in.mp4', await fetchToUint8(videoUrl))
  onProgress?.('Downloading cloned voice...')
  await ff.writeFile('swap-voice.mp3', await fetchToUint8(audioUrl))
  // -map 0:v:0 takes ONLY the video stream (original audio dropped),
  // -map 1:a:0 takes the cloned voice. -shortest stops at the shorter
  // stream so a slightly-long mp3 tail doesn't freeze-frame the video.
  await ff.exec([
    '-i', 'swap-in.mp4',
    '-i', 'swap-voice.mp3',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-shortest',
    '-movflags', '+faststart',
    '-y', 'swap-out.mp4',
  ])
  onProgress?.('Reading output...')
  const data = await ff.readFile('swap-out.mp4')
  try { await ff.deleteFile('swap-in.mp4') } catch {}
  try { await ff.deleteFile('swap-voice.mp3') } catch {}
  try { await ff.deleteFile('swap-out.mp4') } catch {}
  return new Blob([data.buffer], { type: 'video/mp4' })
}
