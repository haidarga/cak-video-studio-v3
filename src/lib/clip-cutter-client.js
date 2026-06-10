// Client-side viral clip cutter. Uses ffmpeg.wasm to slice videos in
// the browser — no server ffmpeg needed.
//
// WHY THIS EXISTS (the "akalin"):
// Vercel functions have no ffmpeg. The original viral clip cutter was
// going to proxy through v2 HF Space backend (which has ffmpeg), but
// that requires a separate redeploy + couples v3 to v2's uptime. By
// running ffmpeg.wasm in the user's browser we skip both problems.
// ffmpeg.wasm cold-loads in ~10s on first run, then cached.
//
// Trade-offs vs server ffmpeg:
//   Pro: zero infra dep, no v2 outage, no cross-region latency
//   Pro: scales free — user's CPU does the work, not our compute budget
//   Con: ~10s cold-load on first cut per session
//   Con: 2GB browser memory cap — fine for <5min source videos
//   Con: user must keep tab open during cut (~5s per 60s clip)

import { getFFmpeg, fetchToUint8 } from './editor-render'

const PLATFORM_DURATIONS = { tiktok: 60, reels: 90, shorts: 60, ig: 90 }

/**
 * Cut a single clip from a video URL using ffmpeg.wasm in the browser.
 * Returns a Blob ready to upload (e.g. to R2 via uploadFile).
 *
 * @param {string} videoUrl   — http(s) URL of source video
 * @param {object} opts
 * @param {number} opts.start    — start time in seconds (default 0)
 * @param {number} opts.duration — clip duration in seconds
 * @param {string} [opts.preset] — 'tiktok'|'reels'|'shorts'|'ig' overrides duration
 * @param {function} [opts.onLog] — receives ffmpeg log lines
 * @returns {Promise<Blob>} mp4 blob
 */
export async function cutClipClientSide(videoUrl, { start = 0, duration = 60, preset, onLog } = {}) {
  if (preset && PLATFORM_DURATIONS[preset]) duration = PLATFORM_DURATIONS[preset]
  const finalStart = Math.max(0, parseFloat(start) || 0)
  const finalDur = Math.max(1, Math.min(600, parseFloat(duration) || 60))

  const ff = await getFFmpeg(onLog)
  const bytes = await fetchToUint8(videoUrl)
  // Random suffix so concurrent cuts on the same source don't clobber.
  const tag = Math.random().toString(36).slice(2, 8)
  const inName = `in_${tag}.mp4`
  const outName = `out_${tag}.mp4`

  await ff.writeFile(inName, bytes)
  // -ss BEFORE -i = fast seek (less accurate but ~100x quicker).
  // -preset ultrafast in wasm because we don't want users waiting 60s for
  // a 60s clip — encoding quality matters less than wall-clock here.
  await ff.exec([
    '-ss', String(finalStart),
    '-i', inName,
    '-t', String(finalDur),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outName,
  ])
  const data = await ff.readFile(outName)
  // Clean up so ffmpeg.wasm's MEMFS doesn't bloat across cuts.
  try { await ff.deleteFile(inName) } catch {}
  try { await ff.deleteFile(outName) } catch {}
  return new Blob([data.buffer], { type: 'video/mp4' })
}

/**
 * Cut multiple clips from one source in sequence. Returns array of
 * { ok, blob, start, duration, preset, label, error? }.
 */
export async function cutMultipleClipsClientSide(videoUrl, clips, { onLog, onProgress } = {}) {
  const results = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    onProgress?.(`Cutting clip ${i + 1} of ${clips.length}...`)
    try {
      const blob = await cutClipClientSide(videoUrl, { ...clip, onLog })
      results.push({ ok: true, blob, ...clip })
    } catch (e) {
      results.push({ ok: false, ...clip, error: String(e?.message || e) })
    }
  }
  return results
}
