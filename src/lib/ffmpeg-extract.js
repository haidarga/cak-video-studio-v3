// Extract a single frame from a video URL using the shared ffmpeg.wasm
// instance. Used by the Continue Storyboard feature — the last frame of
// storyboard A becomes a continuity-anchor reference for storyboard B.
//
// Reuses the singleton ffmpegInstance from editor-render.js so we don't load
// the 30MB wasm twice on a page that uses both editor + generate.

import { getFFmpeg, fetchToUint8 } from './editor-render'

// Extract the last frame of a video. Returns a Blob (JPEG).
//
// Tries two strategies in order:
//   1. `-sseof -<offset>` — fast (seeks directly), works when the MP4 has a
//      valid seek index (faststart-enabled moov atom). Some fal.ai outputs
//      don't ship faststart, so this fails with "memory access out of bounds"
//      inside ffmpeg.wasm's seek table lookup.
//   2. `-update 1` over full stream — decodes the whole video, overwriting
//      the output JPEG with each sampled frame so the final file IS the last
//      frame. Slower (~2-4s for a 15s video) but never fails on seek issues.
//
// If both fail, the caller should fall back to using the previous shot's
// approved image as a continuity anchor (better than nothing — character +
// style still match even without exact-frame handoff).
export async function extractLastFrame(videoUrl, { offsetEnd = 0.1 } = {}) {
  const ff = await getFFmpeg()
  const bytes = await fetchToUint8(videoUrl)
  const inputName = `extract-in-${Date.now()}.mp4`
  const outputName = `extract-out-${Date.now()}.jpg`
  await ff.writeFile(inputName, bytes)

  const tryStrategy = async (args) => {
    try {
      await ff.exec(args)
      const data = await ff.readFile(outputName)
      if (data && data.byteLength > 100) return new Blob([data], { type: 'image/jpeg' })
      return null
    } catch (e) {
      console.warn('[extractLastFrame] strategy failed:', e.message || e)
      return null
    }
  }

  // Strategy 1 — fast seek from end.
  const seekFromEnd = -Math.abs(offsetEnd || 0.1)
  let blob = await tryStrategy([
    '-sseof', String(seekFromEnd),
    '-i', inputName,
    '-vframes', '1',
    '-q:v', '2',
    outputName,
  ])
  if (blob) {
    try { await ff.deleteFile(inputName) } catch {}
    try { await ff.deleteFile(outputName) } catch {}
    return blob
  }

  // Strategy 2 — decode full stream, keep overwriting output until last frame.
  // -fps_mode passthrough avoids ffmpeg complaining about variable fps inputs.
  console.log('[extractLastFrame] strategy 1 failed, trying full-decode fallback')
  blob = await tryStrategy([
    '-i', inputName,
    '-vf', 'fps=2',
    '-update', '1',
    '-q:v', '2',
    outputName,
  ])
  try { await ff.deleteFile(inputName) } catch {}
  try { await ff.deleteFile(outputName) } catch {}
  if (blob) return blob
  throw new Error('Last frame extract failed (both -sseof and -update strategies). Video may be malformed.')
}

// Convenience wrapper — extract + upload to R2 + return public URL.
// Caller still has to wire the URL into a refs list / shot state.
export async function extractAndUploadLastFrame(videoUrl, uploadBlob, opts = {}) {
  const blob = await extractLastFrame(videoUrl, opts)
  const filename = `last-frame-${Date.now()}.jpg`
  const { url } = await uploadBlob(blob, filename, 'continuation')
  return url
}
