// Extract a single frame from a video URL using the shared ffmpeg.wasm
// instance. Used by the Continue Storyboard feature — the last frame of
// storyboard A becomes a continuity-anchor reference for storyboard B.
//
// Reuses the singleton ffmpegInstance from editor-render.js so we don't load
// the 30MB wasm twice on a page that uses both editor + generate.

import { getFFmpeg, fetchToUint8 } from './editor-render'
import { proxify } from './editor-proxy'

// Server-side frame extraction on the v2 HF Space (has ffmpeg + a datacenter
// network). This is the FAST path: v2 downloads the video and extracts the frame
// server-side, returning a tiny JPEG. It avoids the client downloading the whole
// video (fal mp4s lack faststart → the browser must fetch the entire file to
// read metadata) AND avoids loading the 30MB ffmpeg.wasm — the #1 cause of
// "stuck extracting" on slow networks (e.g. an ISP that throttles fal.media).
const V2_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_V2_BACKEND_URL) || 'https://cahmul2-cak-video-studio-v2.hf.space'
export async function extractLastFrameServer(videoUrl, pos = 'end') {
  const r = await fetch(`${V2_BASE}/api/extract-frame?url=${encodeURIComponent(videoUrl)}&pos=${pos}`)
  if (!r.ok) throw new Error(`server extract-frame ${r.status}`)
  const blob = await r.blob()
  if (!blob || blob.size < 100) throw new Error('server extract-frame empty')
  return blob
}

// Server → canvas, NO ffmpeg.wasm. For hot loops (long-form) where the 30MB wasm
// download + full-decode was hanging per segment.
export async function extractLastFrameNoWasm(videoUrl) {
  try {
    const blob = await extractLastFrameServer(videoUrl)
    console.log('[extractLastFrame] server-side (no-wasm) succeeded', blob.size, 'bytes')
    return blob
  } catch (e) {
    console.warn('[extractLastFrame] server-side failed, trying canvas:', e.message || e)
  }
  return extractLastFrameViaCanvas(videoUrl)
}

// Strategy 0 — browser-native video decoder + canvas snapshot. Bypasses
// ffmpeg.wasm entirely. Browsers (Chrome, Firefox, Safari) support MANY
// MORE codecs than ffmpeg.wasm does (H265/HEVC, AV1, etc), so this is
// the most reliable extraction path for fal.ai outputs which sometimes
// use newer codecs.
//
// CORS: proxify() routes fal.ai URLs through /api/proxy to make them
// same-origin (otherwise canvas.toBlob throws a security error).
export async function extractLastFrameViaCanvas(videoUrl) {
  if (typeof document === 'undefined') throw new Error('canvas extract requires browser env')
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.src = proxify(videoUrl)

  // Wait for metadata so duration + dimensions are known.
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve
    video.onerror = () => reject(new Error('video element load failed'))
    // fal mp4 often has no faststart → browser must download enough to read the
    // moov atom before metadata fires. 4s was too tight (failed → slow wasm
    // fallback). Give it a fair chance.
    setTimeout(() => reject(new Error('video metadata timeout (12s)')), 12_000)
  })

  if (!video.duration || !isFinite(video.duration)) {
    throw new Error('video duration unknown')
  }
  // Seek to very near end. Most browsers fire 'seeked' even at duration-0.01
  // and decode that final frame. Some require a tiny offset.
  const target = Math.max(0, video.duration - 0.05)
  video.currentTime = target

  await new Promise((resolve, reject) => {
    video.onseeked = resolve
    video.onerror = () => reject(new Error('video seek failed'))
    setTimeout(() => reject(new Error('video seek timeout (8s)')), 8_000)
  })

  const w = video.videoWidth, h = video.videoHeight
  if (!w || !h) throw new Error('video dimensions zero (decoder problem)')

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0, w, h)

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b && b.size > 100) resolve(b)
      else reject(new Error('canvas.toBlob produced empty/tiny blob'))
    }, 'image/jpeg', 0.9)
  })
  return blob
}

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
  // Strategy -1 (FASTEST) — server-side extract on v2. Skips downloading the
  // whole video + the 30MB ffmpeg.wasm on the client, which is what stalls on
  // slow networks. Falls through to the client paths if v2 is unreachable.
  try {
    const blob = await extractLastFrameServer(videoUrl)
    console.log('[extractLastFrame] server-side succeeded', blob.size, 'bytes')
    return blob
  } catch (e) {
    console.warn('[extractLastFrame] server-side failed, trying client canvas:', e.message || e)
  }
  // Strategy 0 — browser-native video + canvas. Most reliable for fal.ai
  // outputs (browsers handle H265/AV1/etc that ffmpeg.wasm chokes on).
  // Try this FIRST; the ffmpeg.wasm path is now a fallback for the rare
  // case where browser decode also fails (e.g. CORS / proxy issues).
  try {
    console.log('[extractLastFrame] trying browser-native canvas strategy')
    const blob = await extractLastFrameViaCanvas(videoUrl)
    if (blob && blob.size > 100) {
      console.log('[extractLastFrame] canvas strategy succeeded', blob.size, 'bytes')
      return blob
    }
  } catch (e) {
    console.warn('[extractLastFrame] canvas strategy failed:', e.message || e)
  }

  // Fallback: ffmpeg.wasm path (3 sub-strategies).
  console.log('[extractLastFrame] falling back to ffmpeg.wasm strategies')
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
  console.log('[extractLastFrame] strategy 1 failed, trying full-decode fallback')
  blob = await tryStrategy([
    '-i', inputName,
    '-vf', 'fps=2',
    '-update', '1',
    '-q:v', '2',
    outputName,
  ])
  if (blob) {
    try { await ff.deleteFile(inputName) } catch {}
    try { await ff.deleteFile(outputName) } catch {}
    return blob
  }

  // Strategy 3 — dump frames sequentially to numbered files, take the highest-
  // numbered one. Some MP4s with unusual codecs (H265, certain B-frame patterns)
  // refuse -update; sequential dump is the most robust approach.
  console.log('[extractLastFrame] strategy 2 failed, trying sequential frame dump')
  const seqPattern = `seq-${Date.now()}-%03d.jpg`
  try {
    await ff.exec([
      '-i', inputName,
      '-vf', 'fps=1',
      '-q:v', '2',
      seqPattern,
    ])
    // List the produced files and pick the highest index.
    const files = (await ff.listDir('/')).filter((f) => typeof f.name === 'string' && f.name.startsWith(seqPattern.split('-%')[0]))
    let lastName = null, lastIdx = -1
    for (const f of files) {
      const m = f.name.match(/-(\d+)\.jpg$/)
      if (m) {
        const i = parseInt(m[1], 10)
        if (i > lastIdx) { lastIdx = i; lastName = f.name }
      }
    }
    if (lastName) {
      const data = await ff.readFile(lastName)
      if (data && data.byteLength > 100) {
        blob = new Blob([data], { type: 'image/jpeg' })
      }
    }
    // Cleanup all seq files
    for (const f of files) {
      try { await ff.deleteFile(f.name) } catch {}
    }
  } catch (e) {
    console.warn('[extractLastFrame] strategy 3 failed:', e.message || e)
  }

  try { await ff.deleteFile(inputName) } catch {}
  try { await ff.deleteFile(outputName) } catch {}
  if (blob) return blob
  throw new Error('Last frame extract failed (all 3 strategies: sseof / update / seq-dump). Video codec may be unsupported by ffmpeg.wasm.')
}

// Convenience wrapper — extract + upload to R2 + return public URL.
// Caller still has to wire the URL into a refs list / shot state.
export async function extractAndUploadLastFrame(videoUrl, uploadBlob, opts = {}) {
  const blob = await extractLastFrame(videoUrl, opts)
  const filename = `last-frame-${Date.now()}.jpg`
  const { url } = await uploadBlob(blob, filename, 'continuation')
  return url
}
