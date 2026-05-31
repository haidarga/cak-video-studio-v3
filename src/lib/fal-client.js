// Browser-side fal helper that proxies through /api/fal/*. The FAL_KEY stays
// on the server. falRun resolves once the fal job is COMPLETED (or rejects).
//
// ── Webhook-based completion, no polling ──
//
// Previously this polled /api/fal/status every 3s. Fine for 1-5 parallel jobs;
// at 200 concurrent gens it instantly hit fal.ai's 429 rate limit and torched
// every job. New flow:
//
//   1. POST /api/fal/submit → server submits to fal with webhookUrl, inserts
//      a gen_jobs row (status='pending'), returns request_id.
//   2. Browser SUBSCRIBES to that row via Supabase realtime, filtered by
//      request_id. Zero polls go to fal from the browser.
//   3. fal POSTs /api/fal/webhook when the job finishes → server updates the
//      row to status='done' (or 'error') with the payload URL.
//   4. Supabase realtime fires → falRun resolves with the fal payload.
//
// Safety nets:
//   - Initial check after subscribe: in case the webhook already fired (row
//     is already 'done' or 'error') before we subscribed.
//   - Periodic (every 45s) fallback poll of gen_jobs row in case the realtime
//     channel silently drops. Cheap — it hits OUR Supabase, not fal.
//   - Hard timeout at maxWaitMs (10min default) so a stuck row doesn't pin
//     the UI forever.

import { createClient } from '@/lib/supabase/client'

// Build the result shape callers expect. Returns the raw fal payload (e.g.
// { video: {url}, ... } or { images: [{url}], ... }) so existing destructures
// like result.video.url / result.images[0].url keep working.
function buildResult(row) {
  if (row.payload && typeof row.payload === 'object') return row.payload
  // Fallback if webhook only stored the extracted URL.
  if (row.payload_url) return { video: { url: row.payload_url }, images: [{ url: row.payload_url }] }
  return {}
}

// Recognize fal/Grok errors that are FLAKY (non-deterministic). Same prompt
// can pass on retry. The big one is xAI's content checker which returns
// false-positives constantly — user verified the exact same input goes
// through on a second submit. Retrying these is safe and effective.
function isFlakyFalError(err) {
  const s = String(err?.message || err || '').toLowerCase()
  return (
    s.includes('content checker') ||
    s.includes('flagged by a content checker') ||
    s.includes('content could not be processed') ||
    s.includes('partner_validation_failed') ||
    s.includes('temporarily unavailable') ||
    s.includes('please try again')
  )
}

export async function falRun(model, input, opts = {}) {
  const { onProgress, maxRetries = 3 } = opts
  let lastErr
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) onProgress?.(`retry ${attempt}/${maxRetries - 1} (flaky content check)...`)
      return await falRunOnce(model, input, opts)
    } catch (e) {
      lastErr = e
      // Only retry on flaky errors — real bugs (auth, invalid input) bail out immediately.
      if (!isFlakyFalError(e)) throw e
      if (attempt === maxRetries - 1) throw e
      // Brief backoff before retry — gives Grok's content checker a moment.
      await new Promise((r) => setTimeout(r, 2000 + attempt * 1500))
    }
  }
  throw lastErr
}

async function falRunOnce(model, input, { onProgress, maxWaitMs = 600000, workspaceId, duration, meta } = {}) {
  // ── Submit ─────────────────────────────────────────────────────────────
  const submitRes = await fetch('/api/fal/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, meta: meta || { duration, workspaceId } }),
  })
  const submit = await submitRes.json()
  if (!submit.ok) throw new Error(submit.error || 'submit failed')
  const requestId = submit.request_id
  if (!requestId) throw new Error('no request_id from fal')

  onProgress?.('submitted, waiting for webhook...')

  // ── Wait for completion via realtime ──────────────────────────────────
  const supabase = createClient()
  const start = Date.now()

  return await new Promise((resolve, reject) => {
    let settled = false
    let channel = null
    let fallbackInterval = null
    let timeoutHandle = null

    const cleanup = () => {
      if (channel) { try { channel.unsubscribe() } catch {} channel = null }
      if (fallbackInterval) clearInterval(fallbackInterval)
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
    const finish = (row) => {
      if (settled) return
      if (row.status === 'done') {
        settled = true; cleanup()
        resolve(buildResult(row))
      } else if (row.status === 'error') {
        settled = true; cleanup()
        reject(new Error(row.error || 'gen failed'))
      }
    }

    // Subscribe FIRST — before checking current state — to avoid missing an
    // update that lands between the read and the subscribe.
    channel = supabase
      .channel(`gen_job_${requestId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'gen_jobs',
        filter: `request_id=eq.${requestId}`,
      }, (payload) => finish(payload.new))
      .subscribe()

    // Now check current state — handles the race where webhook fired before
    // we subscribed (job took <1s, very rare for video but possible for cached
    // image gens).
    supabase.from('gen_jobs').select('*').eq('request_id', requestId).maybeSingle()
      .then(({ data }) => { if (data) finish(data) })

    // Fallback poll every 45s of OUR Supabase (not fal). Catches the case
    // where the realtime channel quietly drops — Supabase realtime is reliable
    // but not bulletproof on flaky networks / phone backgrounding.
    fallbackInterval = setInterval(async () => {
      if (settled) return
      const elapsed = Math.round((Date.now() - start) / 1000)
      onProgress?.(`waiting (${elapsed}s)`)
      const { data } = await supabase.from('gen_jobs').select('*').eq('request_id', requestId).maybeSingle()
      if (data) finish(data)
    }, 45000)

    // Hard timeout — if no webhook AND fallback never sees done, give up.
    // 10 minutes is generous for video gen (Kling pro ~3min, Seedance ~2min).
    timeoutHandle = setTimeout(() => {
      if (settled) return
      settled = true; cleanup()
      reject(new Error(`timeout after ${Math.round(maxWaitMs / 1000)}s waiting for fal job ${requestId}`))
    }, maxWaitMs)
  })
}

// ── Image input builder ──
// Per-model branches so multi-ref models don't silently drop refs[1..].
// Single-ref models still receive refs[0]; a warn logs when refs are dropped.
export function buildImgInput(imgModel, { prompt, refUrls = [], ar = '9:16' }) {
  const refs = (refUrls || []).filter(Boolean)
  if (imgModel.includes('nano-banana')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 12) } : {}), num_images: 1, output_format: 'png', aspect_ratio: ar }
  }
  const image_size = ar === '9:16' ? { width: 1024, height: 1536 } : ar === '16:9' ? { width: 1536, height: 1024 } : { width: 1024, height: 1024 }
  if (imgModel.includes('gpt-image-2/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 10) } : {}), image_size, quality: 'medium', num_images: 1 }
  }
  // GPT Image 2 GENERATION mode (no /edit suffix) — same underlying model
  // as gpt-image-2/edit but in text-to-image generation mode. Refs treated
  // as style/identity hints, NOT pixel-preserve source. Outfit + aesthetic
  // free to follow text prompt instead of mirroring reference photo.
  if (imgModel.includes('gpt-image-2') && !imgModel.includes('edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 10) } : {}), image_size, quality: 'medium', num_images: 1 }
  }
  if (imgModel.includes('imagen-4-fast/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 8) } : {}), aspect_ratio: ar, num_images: 1 }
  }
  if (imgModel.includes('seedream/v4/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 6) } : {}), aspect_ratio: ar, num_images: 1 }
  }
  if (imgModel.includes('qwen-image-edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 4) } : {}), aspect_ratio: ar, num_images: 1 }
  }
  // Grok Imagine Image Quality Edit — xAI's edit model. Accepts image_urls
  // for multi-ref edit. Resolution 1k ($0.05) or 2k ($0.07) per output +
  // $0.01 per input image. aspect_ratio='auto' lets it infer from source.
  if (imgModel.includes('grok-imagine-image')) {
    return {
      prompt,
      ...(refs.length ? { image_urls: refs.slice(0, 8) } : {}),
      resolution: '1k', // bump to 2k manually if user wants — costs more
      aspect_ratio: ar || 'auto',
      num_images: 1,
      output_format: 'jpeg',
    }
  }
  // Single-ref fallback (flux/dev, flux-pro/v1.1-ultra). Warn if dropping refs.
  if (refs.length > 1 && typeof console !== 'undefined') {
    console.warn(`[buildImgInput] ${imgModel} is single-ref; dropping ${refs.length - 1} ref(s)`)
  }
  return { prompt, ...(refs.length ? { image_url: refs[0] } : {}), image_size, quality: 'medium' }
}

// ── Video input builder, ported from v2's src/lib/api.js ──
export function buildVidInput(vidModel, { prompt, image_url, reference_urls, duration, aspect_ratio }) {
  const isRef = vidModel.includes('reference-to-video')
  if (vidModel.includes('kling-video')) {
    const isO3 = vidModel.includes('/o3/')
    const dur = Math.max(5, Math.min(15, parseInt(duration) || 5))
    if (isRef) {
      const refs = (reference_urls || []).filter(Boolean).slice(0, 4)
      const elements = refs.map((u) => ({ frontal_image_url: u }))
      const tags = elements.map((_, i) => `@Element${i + 1}`).join(' and ')
      return { prompt: tags ? `${tags}. ${prompt}` : prompt, ...(elements.length ? { elements } : {}), duration: dur, aspect_ratio, generate_audio: true }
    }
    const out = { prompt, image_url, duration: dur, aspect_ratio }
    if (reference_urls?.length) out.reference_image_urls = reference_urls.slice(0, 4)
    if (isO3) out.generate_audio = true
    return out
  }
  if (vidModel.includes('seedance')) {
    const okAR = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
    const d = parseInt(duration)
    const srcField = isRef ? { image_urls: (reference_urls || []).filter(Boolean).slice(0, 9) } : { image_url }
    return {
      prompt, ...srcField,
      duration: d ? String(Math.max(4, Math.min(15, d))) : 'auto',
      resolution: '720p',
      aspect_ratio: okAR.includes(aspect_ratio) ? aspect_ratio : 'auto',
    }
  }
  if (vidModel.includes('happy-horse')) {
    const srcField = isRef ? { image_urls: (reference_urls || []).filter(Boolean).slice(0, 9) } : { image_url }
    return { prompt, ...srcField, duration: parseInt(duration) || 5, aspect_ratio, resolution: '720p' }
  }
  if (vidModel.includes('grok-imagine')) {
    // xAI Grok Imagine Video — has TWO variants:
    //   image-to-video    : single source image, animate motion from prompt
    //   reference-to-video: multiple reference photos (up to ~4-6), the model
    //     composes a fresh video that respects the references' identity +
    //     style. Picked for storyboard mode so each panel can stay as a
    //     reference without being morphed by image-to-video frame-warping.
    // Both share resolution / aspect / duration handling.
    const base = {
      prompt,
      duration: Math.max(5, Math.min(15, parseInt(duration) || 5)),
      resolution: '720p',
      aspect_ratio: aspect_ratio || 'auto',
    }
    if (isRef) {
      const refs = (reference_urls || []).filter(Boolean).slice(0, 6)
      // Fall back to image_url as first reference if caller didn't pass refs
      // (e.g. storyboard auto-route where the grid image IS the reference).
      const finalRefs = refs.length ? refs : (image_url ? [image_url] : [])
      return { ...base, image_urls: finalRefs }
    }
    return { ...base, image_url }
  }
  return { prompt, image_url, duration: parseInt(duration) || 5, aspect_ratio }
}

// Build the 3×3 storyboard grid LAYOUT HEADER + tight cells.
// Pre-refactor this was verbose ad-agency boilerplate. Cells used to be:
//   Cell N (M detik) — TITLE
//      Camera: <shot_type>
//      Action: <visual>
// That structure is OK for human readers but diffusion models parse it as
// 4 separate text blobs per cell — eats attention budget. Refactored to
// woven 1-line cells where camera intent + action are joined naturally.
//
// constraints = { skipDialog, skipOnscreen, skipProduct }
export function buildStoryboardGridPrompt(panels = [], ar = '9:16', concept = '', constraints = {}) {
  const nine = panels.slice(0, 9)
  let t = 0
  const cells = nine.map((p) => {
    const dur = Math.max(1, parseInt(p.seconds) || 2)
    t += dur
    // Woven single-line cell — camera + action in one sentence model parses cleanly.
    const shot = p.shot_type ? `${p.shot_type.toLowerCase()} — ` : ''
    const action = (p.visual || p.scene || '').trim()
    let line = `Cell ${p.n}: ${shot}${action}`
    if (!constraints.skipDialog && p.dialog) line += ` (overheard: "${p.dialog.trim()}")`
    if (!constraints.skipOnscreen && p.onscreen) line += ` [caption: ${p.onscreen.trim()}]`
    return line
  }).join('\n')
  const conceptLine = '' // dropped — action already conveys concept; saves redundancy
  const productRule = constraints.skipProduct
    ? 'No product or brand packaging in any cell — lifestyle moments only.'
    : 'Product appears in cells marked Product Shot only.'
  // Slim layout — match ChatGPT-style raw-photo grid (NOT ad-agency table sheet).
  // Pre-refactor this asked for 'thin grey lines + scene-number badge + time
  // range per cell + concise text block under each still' which produced an
  // ad-agency presentation board with text labels. ChatGPT-image output was
  // just 9 raw photos in 3x3 with small corner numbers, no text below — that's
  // what users actually want.
  const header = `Single composite image, ${ar} canvas, 3x3 grid layout (3 rows × 3 columns) of 9 sequential photographic stills. Tiny scene number (1-9) in top-left corner of each cell. NO text labels, NO captions, NO time stamps under the photos — clean raw photos only.`
  return `${header}\n${conceptLine}\n${productRule}\n\nThe 9 stills, in order (left-to-right, top-to-bottom):\n${cells}`
}

export function productDirective(notes) {
  const n = (notes || '').trim()
  if (!n) return ''
  return ' PRODUCT FIDELITY (critical): reproduce the product packaging EXACTLY as in the reference image — correct shape and proportions, product upright with its front label facing the camera, and ALL label text sharp, legible and correctly spelled. Strictly respect this product knowledge: ' + n
}

// @deprecated — was unconditionally appended at every image gen and contradicted
// phone/animation camera presets (audit flagged this as the #1 contradiction
// source: 'shot on Samsung A13' + 'Professional high-detail photography' in
// same prompt). prompt-compiler picks a style-aware quality line per preset.
// Empty string kept so legacy imports don't throw.
export const IMG_QUALITY = ''

// @deprecated — same story; compileVideoPrompt handles stability per preset.
export const VID_STABILITY = ''

export const VIDEO_MODELS = [
  { v: 'xai/grok-imagine-video/image-to-video', l: 'Grok Imagine — ~$0.07/dtk 720p (audio) 💰' },
  { v: 'xai/grok-imagine-video/reference-to-video', l: '🎭 Grok Imagine Ref-to-Video — ~$0.07/dtk (multi-ref, NO grid morph) 💰' },
  { v: 'fal-ai/kling-video/v3/standard/image-to-video', l: 'Kling v3 — ~$0.08/dtk 💰' },
  { v: 'fal-ai/kling-video/o3/standard/image-to-video', l: 'Kling O3 — ~$0.11/dtk (audio)' },
  { v: 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video', l: '🎭 Kling 2.5 Pro Ref-to-Video — ~$0.12/dtk (NO morphing dari grid)' },
  { v: 'alibaba/happy-horse/image-to-video', l: 'Happy Horse 1.0 — ~$0.14/dtk' },
  { v: 'fal-ai/bytedance/seedance/v1/lite/reference-to-video', l: '🎭 Seedance Ref-to-Video — ~$0.16/dtk' },
  { v: 'bytedance/seedance-2.0/fast/image-to-video', l: 'Seedance 2 Fast — ~$0.24/dtk' },
  { v: 'fal-ai/kling-video/v3/pro/image-to-video', l: 'Kling v3 Pro — ~$0.28/dtk (best quality)' },
]
export const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — fast multi-ref, outfit adapts' },
  { v: 'openai/gpt-image-2', l: '🆕 GPT Image 2 (generation mode) — refs as hints, NOT pixel-locked' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — best text, pixel-locks refs' },
  { v: 'xai/grok-imagine-image/quality/edit', l: '🆕 Grok Imagine Edit — multi-ref, $0.05 (1k) / $0.07 (2k) + $0.01/input' },
]
