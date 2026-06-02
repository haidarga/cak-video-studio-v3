// Extract a single frame from a video URL using the shared ffmpeg.wasm
// instance. Used by the Continue Storyboard feature — the last frame of
// storyboard A becomes a continuity-anchor reference for storyboard B.
//
// Reuses the singleton ffmpegInstance from editor-render.js so we don't load
// the 30MB wasm twice on a page that uses both editor + generate.

import { getFFmpeg, fetchToUint8 } from './editor-render'

// Extract the last frame of a video. Returns a Blob (JPEG). Default uses
// `-sseof -0.1` which seeks 0.1s before END, then grabs 1 frame — most
// reliable way to land on a stable trailing frame (exact-last frame is
// sometimes black during fade-out / motion blur). Override `offsetEnd` to
// 0 for exact last frame.
export async function extractLastFrame(videoUrl, { offsetEnd = 0.1 } = {}) {
  const ff = await getFFmpeg()
  // Download video bytes through our proxy (same path the editor uses; handles
  // CORS + COEP isolation on the editor page; harmless on /generate).
  const bytes = await fetchToUint8(videoUrl)
  const inputName = `extract-in-${Date.now()}.mp4`
  const outputName = `extract-out-${Date.now()}.jpg`
  await ff.writeFile(inputName, bytes)
  // `-sseof` seeks relative to end of file. `-vframes 1` grabs one frame.
  // `-q:v 2` = high JPEG quality (1-31 scale, lower is better).
  // Negative offsetEnd means "from end backwards", we pass it as negative.
  const seekFromEnd = -Math.abs(offsetEnd || 0)
  await ff.exec([
    '-sseof', String(seekFromEnd),
    '-i', inputName,
    '-vframes', '1',
    '-q:v', '2',
    outputName,
  ])
  const data = await ff.readFile(outputName)
  // Cleanup tmp files inside the ffmpeg virtual fs.
  try { await ff.deleteFile(inputName) } catch {}
  try { await ff.deleteFile(outputName) } catch {}
  return new Blob([data], { type: 'image/jpeg' })
}

// Convenience wrapper — extract + upload to R2 + return public URL.
// Caller still has to wire the URL into a refs list / shot state.
export async function extractAndUploadLastFrame(videoUrl, uploadBlob, opts = {}) {
  const blob = await extractLastFrame(videoUrl, opts)
  const filename = `last-frame-${Date.now()}.jpg`
  const { url } = await uploadBlob(blob, filename, 'continuation')
  return url
}
