// Strip audio track from an MP4 via ffmpeg.wasm stream copy.
//
// Why: TikTok's `autoAddMusic: yes` flag only attaches a trending sound
// when the uploaded video has no audio track of its own. If our render
// includes the AI-generated voice (or any baked audio), TikTok keeps
// that audio and ignores the auto-music flag — user ends up with their
// own audio + zero trending music.
//
// Stripping audio via `-c:v copy -an` is INSTANT (no re-encode, just
// remux). Output is the same MP4 minus the audio track. Re-upload that
// to TikTok with autoAddMusic=yes → TikTok adds a trending sound.

import { getFFmpeg, fetchToUint8 } from './editor-render.js'

export async function stripAudioFromVideo(url, onProgress) {
  onProgress?.('Loading ffmpeg...')
  const ff = await getFFmpeg((msg) => {
    if (msg.includes('frame=') || msg.includes('time=')) onProgress?.('Stripping audio...')
  })
  onProgress?.('Downloading source...')
  const bytes = await fetchToUint8(url)
  await ff.writeFile('strip-in.mp4', bytes)
  // -c:v copy = no video re-encode (instant). -an = drop audio track.
  // -movflags +faststart so the output streams cleanly in browsers / TikTok.
  await ff.exec([
    '-i', 'strip-in.mp4',
    '-c:v', 'copy',
    '-an',
    '-movflags', '+faststart',
    '-y', 'strip-out.mp4',
  ])
  onProgress?.('Reading output...')
  const data = await ff.readFile('strip-out.mp4')
  // Clean up so subsequent runs in the same session don't bloat the wasm fs.
  try { await ff.deleteFile('strip-in.mp4') } catch {}
  try { await ff.deleteFile('strip-out.mp4') } catch {}
  return new Blob([data.buffer], { type: 'video/mp4' })
}
