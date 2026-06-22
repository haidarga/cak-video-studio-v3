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

// Route by model kind: image gen takes the SYNC path (fal.run/<model>
// blocks until done, single HTTP response — ~15s for nano-banana),
// video gen takes the WEBHOOK path (queue + Supabase realtime — required
// since video gen >60s would hit Vercel function timeout).
//
// Why this exists: webhook overhead is real — ~45-80s extra on top of
// the actual gen time (fal queue + webhook POST + realtime broadcast +
// browser subscribe). For 15s image gens, that's 5-6x slower than sync.
// User noticed god-mode (sync) finishes in 10-15s while /generate
// (webhook) takes 100s for the same model.
function isVideoModel(model) {
  if (!model) return false
  return /video|veo3|kling|seedance|wan|grok-imagine-video|happy-horse/i.test(model)
}

// Some IMAGE models are too slow for the sync path. The /api/fal/sync route
// is capped at maxDuration=60s (Vercel function limit). GPT Image 2 (OpenAI
// via fal) routinely takes 45-90s with multiple refs — it blows past 60s and
// Vercel kills the function → the browser sees a 504 ("sync fal call failed").
// Route these through the async webhook path (submit + realtime) which has NO
// function-duration limit: fal does the work and webhooks us when done.
// Fast models (nano-banana ~15s) stay on the snappy sync path.
function isSlowImageModel(model) {
  return /gpt-image-2/i.test(model || '')
}

export async function falRun(model, input, opts = {}) {
  const { onProgress, maxRetries = 3 } = opts
  const useSync = !isVideoModel(model) && !isSlowImageModel(model)
  const runner = useSync ? falRunSync : falRunOnce
  let lastErr
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) onProgress?.(`retry ${attempt}/${maxRetries - 1} (flaky content check)...`)
      return await runner(model, input, opts)
    } catch (e) {
      lastErr = e
      if (!isFlakyFalError(e)) throw e
      if (attempt === maxRetries - 1) throw e
      await new Promise((r) => setTimeout(r, 2000 + attempt * 1500))
    }
  }
  throw lastErr
}

// Sync path — POST to /api/fal/sync which calls fal.run inline + returns
// the result in a single HTTP response. No queue, no webhook, no realtime.
// Server still does budget gate + gen_jobs insert for usage tracking.
async function falRunSync(model, input, { onProgress, workspaceId, duration, meta } = {}) {
  onProgress?.('submitting (sync)...')
  const t0 = Date.now()
  const res = await fetch('/api/fal/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, meta: meta || { duration, workspaceId } }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `sync fal call failed (${res.status})`)
  }
  const elapsed = Math.round((Date.now() - t0) / 1000)
  onProgress?.(`completed (${elapsed}s)`)
  // Return the raw fal payload (callers destructure data.images / data.video).
  return data
}

// Default timeout — kind-aware. Video gen with Grok ref-to-video or
// Kling Pro can legit take 12-18 minutes when fal's queue is busy.
// Image gen normally <30s, BUT during queue spikes (Grok image,
// nano-banana mass burst, or fal-side outage) can stall 5-10 min
// while webhook silently drops. 15 min keeps a real safety net.
function defaultMaxWait(model) {
  if (!model) return 900000
  if (/video|veo3|kling|seedance|wan|grok-imagine-video|happy-horse/i.test(model)) {
    return 1200000 // 20 min — video gen
  }
  return 900000 // 15 min — image gen (was 10, bumped after user hit timeout on stalled webhook)
}

async function falRunOnce(model, input, { onProgress, maxWaitMs, workspaceId, duration, meta } = {}) {
  // Resolve timeout AFTER we know the model. Caller can still override.
  const effectiveMaxWait = maxWaitMs || defaultMaxWait(model)
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
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
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

    // Fallback poll every 20s of OUR Supabase + fal direct status.
    // Two reasons for the dual poll:
    //   1. Supabase realtime sometimes silently drops on flaky networks /
    //      phone backgrounding — without this, the UI would just sit on
    //      "submitted, waiting for webhook..." forever even after the gen
    //      actually completed on fal side.
    //   2. fal direct status gives us queue_position + IN_QUEUE/IN_PROGRESS
    //      states the user can SEE — much better UX than a silent timer.
    //      Without this, user sees "lama bro" with no signal whether fal
    //      is queued (will eventually move) or stuck (need to bail).
    const pollOnce = async () => {
      if (settled) return
      const elapsed = Math.round((Date.now() - start) / 1000)
      const { data } = await supabase.from('gen_jobs').select('*').eq('request_id', requestId).maybeSingle()
      if (data?.status === 'done' || data?.status === 'error') { finish(data); return }
      // Probe fal direct status via /api/god-mode/gen-status which already
      // handles canonical-path resolution + reads status_url from gen_jobs.
      try {
        const qs = new URLSearchParams({ request_id: requestId, model })
        const r = await fetch(`/api/god-mode/gen-status?${qs}`, { cache: 'no-store' })
        // 401 = session token expired mid-gen (laptop sleep / background-tab
        // timer throttling stops supabase-js's auto-refresh). Refresh the
        // session and let the next tick retry — without this the poll 401s
        // forever, the badge sits on "pending" even though fal finished, and
        // the user eventually gets bounced to /login.
        if (r.status === 401) {
          try { await supabase.auth.refreshSession() } catch {}
          onProgress?.(`session refresh, retrying... (${elapsed}s)`)
          return
        }
        const j = await r.json().catch(() => ({}))
        if (j.ok && j.status === 'done' && j.url) {
          // gen-status already saved the result row + would have triggered
          // webhook; mark settled with the URL we got.
          settled = true; cleanup()
          resolve(j.url ? { video: { url: j.url }, images: [{ url: j.url }] } : {})
          return
        }
        const falState = j.fal_status || 'pending'
        const queuePos = j.queue_position != null ? ` · #${j.queue_position} in queue` : ''
        onProgress?.(`${falState}${queuePos} (${elapsed}s)`)
      } catch {
        onProgress?.(`waiting (${elapsed}s)`)
      }
    }
    fallbackInterval = setInterval(pollOnce, 20000)

    // Instant recovery when the tab comes back: background tabs throttle
    // timers (and sleep suspends them entirely), so the 20s interval may not
    // have run for minutes. One immediate poll on focus snaps the UI to
    // reality instead of waiting for the next tick.
    const onVisible = () => { if (document.visibilityState === 'visible') pollOnce() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)

    // Hard timeout — if no webhook AND fallback never sees done, give up.
    // Video gen defaults to 20 min (Grok ref-to-video + Kling Pro under
    // queue load can legit hit 15+ min). Image gen stays at 10 min.
    // Caller can override via maxWaitMs.
    timeoutHandle = setTimeout(() => {
      if (settled) return
      settled = true; cleanup()
      reject(new Error(`timeout after ${Math.round(effectiveMaxWait / 1000)}s waiting for fal job ${requestId} — job may still complete on fal side, check the gen_jobs row or click Re-vid to retry`))
    }, effectiveMaxWait)
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

// Happy Horse anti-morph stability clause (Generate/F-Creator copy — kept
// local to this surface, not imported from god-mode-builders, to keep the two
// surfaces independent). HH has no negative_prompt field so we steer via the
// positive prompt: pin identity + style, forbid morphing/drift.
const HH_STABILITY = ' Keep ONE consistent visual style and identical subject appearance — same face, proportions, outfit and color palette across every frame. Smooth, coherent, physically stable motion. NO morphing, NO warping, NO melting, NO style drift, NO shape-shifting, NO flicker, NO identity change.'

// ── Video input builder, ported from v2's src/lib/api.js ──
// Veo 3.1 anti-morph. Lip/mouth/teeth morphing while the subject speaks is
// Veo's main artifact. i2v exposes a `negative_prompt` field; r2v does NOT
// (verified against fal's OpenAPI — sending it 422s), so for r2v the same
// intent is appended to the POSITIVE prompt instead.
export const VEO_NEGATIVE_PROMPT = 'morphing face, warping lips, distorted mouth, deformed teeth, melting facial features, smeared mouth, jittering lips, rubbery mouth, malformed teeth, extra teeth, lip-sync artifacts, flickering face, unstable facial features, face distortion, identity change, character drift, warping, melting, blurry mouth'
export const VEO_FACE_STABILITY = ' Keep the face and especially the MOUTH, LIPS and TEETH stable, natural and consistent while speaking — no morphing, warping, smearing, melting or flickering of the lips, teeth or facial features in any frame.'

// Veo 3.1 takes `duration` as a STRING with an `s` suffix and only accepts
// 4s/6s/8s for image-to-video; reference-to-video is locked to 8s. Coerce a
// numeric duration to the nearest allowed bucket.
function veoDuration(duration, isRef) {
  if (isRef) return '8s'
  const n = parseInt(duration) || 8
  if (n >= 7) return '8s'
  if (n >= 5) return '6s'
  return '4s'
}

export function buildVidInput(vidModel, { prompt, image_url, reference_urls, duration, aspect_ratio }) {
  const isRef = vidModel.includes('reference-to-video')
  // Pure text-to-video — NO image fields at all (sending them 422s on some
  // endpoints). Per-family shapes from the fal dashboards.
  if (vidModel.includes('text-to-video')) {
    const d = parseInt(duration) || 5
    if (vidModel.includes('kling-video')) {
      return { prompt, duration: Math.max(5, Math.min(10, d)), aspect_ratio, generate_audio: true }
    }
    if (vidModel.includes('seedance')) {
      return { prompt, duration: String(Math.max(4, Math.min(15, d))), resolution: '720p', aspect_ratio, generate_audio: true }
    }
    if (vidModel.includes('happy-horse')) {
      return { prompt: prompt + HH_STABILITY, duration: Math.max(3, Math.min(15, d)), aspect_ratio, resolution: '720p', enable_safety_checker: false }
    }
    if (vidModel.includes('grok-imagine')) {
      return { prompt, duration: Math.max(5, Math.min(10, d)), resolution: '720p', aspect_ratio: aspect_ratio || 'auto' }
    }
    return { prompt, duration: d, aspect_ratio }
  }
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
    // Both ref + i2v variants accept 4-15s per fal.ai dashboard. Earlier
    // commit capped ref at 12 based on an outdated assumption; user
    // confirmed 15 works (showed dashboard dropdown going to 15). Match
    // getVideoMaxDuration so the UI cap and the gen-time cap agree.
    return {
      prompt, ...srcField,
      duration: d ? String(Math.max(4, Math.min(15, d))) : 'auto',
      resolution: '720p',
      aspect_ratio: okAR.includes(aspect_ratio) ? aspect_ratio : 'auto',
    }
  }
  if (vidModel.includes('happy-horse')) {
    const srcField = isRef ? { image_urls: (reference_urls || []).filter(Boolean).slice(0, 9) } : { image_url }
    return { prompt: prompt + HH_STABILITY, ...srcField, duration: parseInt(duration) || 5, aspect_ratio, resolution: '720p', enable_safety_checker: false }
  }
  if (vidModel.includes('grok-imagine')) {
    // xAI Grok Imagine Video — TWO variants with DIFFERENT input schemas:
    //   image-to-video     : single source image (image_url), duration max 15
    //   reference-to-video : array of refs (reference_image_urls — not
    //     image_urls!), duration max 10. The model composes a fresh video
    //     that respects the references' identity + style.
    // Two bugs that fal.ai 422'd us on:
    //   - wrong field name (image_urls -> reference_image_urls)
    //   - duration cap (was 15, model only accepts <= 10 for ref-to-video)
    if (isRef) {
      const refs = (reference_urls || []).filter(Boolean).slice(0, 6)
      // Fall back to image_url as first reference if caller didn't pass refs
      // (e.g. storyboard auto-route where the grid image IS the reference).
      const finalRefs = refs.length ? refs : (image_url ? [image_url] : [])
      return {
        prompt,
        reference_image_urls: finalRefs,
        duration: Math.max(5, Math.min(10, parseInt(duration) || 5)),
        resolution: '720p',
        aspect_ratio: aspect_ratio || 'auto',
      }
    }
    return {
      prompt,
      image_url,
      duration: Math.max(5, Math.min(15, parseInt(duration) || 5)),
      resolution: '720p',
      aspect_ratio: aspect_ratio || 'auto',
    }
  }
  if (vidModel.includes('veo3')) {
    // Veo 3.1 Fast (Google). safety_tolerance is a STRING "1".."6" where 6 =
    // most permissive (user-requested MAX — there is nothing above 6). i2v takes
    // image_url, r2v takes image_urls (Veo caps reference images at 3). r2v AR
    // is limited to 16:9/9:16 (no "auto"/1:1); i2v also accepts "auto".
    const veoAR = ['16:9', '9:16'].includes(aspect_ratio) ? aspect_ratio : (isRef ? '9:16' : 'auto')
    if (isRef) {
      return {
        // r2v has no negative_prompt field — bake anti-morph into the positive.
        prompt: prompt + VEO_FACE_STABILITY,
        image_urls: (reference_urls || []).filter(Boolean).slice(0, 3),
        duration: '8s',
        resolution: '720p',
        aspect_ratio: veoAR,
        generate_audio: true,
        safety_tolerance: '6',
      }
    }
    return {
      prompt,
      image_url,
      negative_prompt: VEO_NEGATIVE_PROMPT,
      duration: veoDuration(duration, false),
      resolution: '720p',
      aspect_ratio: veoAR,
      generate_audio: true,
      safety_tolerance: '6',
    }
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
// gridDims — pick a CLEAN rectangle for N panels so the composite never has
// awkward empty cells. 1-4 → 2 cols, 5+ → 3 cols. 4→2x2, 6→2x3, 9→3x3.
export function gridDims(n) {
  const count = Math.max(1, Math.min(9, n | 0))
  const cols = count <= 4 ? 2 : 3
  const rows = Math.ceil(count / cols)
  return { count, rows, cols }
}

export function buildStoryboardGridPrompt(panels = [], ar = '9:16', concept = '', constraints = {}, candid = false) {
  const nine = panels.slice(0, 9)
  const { count, rows, cols } = gridDims(nine.length)
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
  const header = `Single composite image, ${ar} canvas, ${rows}x${cols} grid layout (${rows} rows × ${cols} columns) of ${count} sequential photographic stills. Tiny scene number (1-${count}) in top-left corner of each cell. NO text labels, NO captions, NO time stamps under the photos — clean raw photos only.`
  // Cross-panel consistency directive — the #1 storyboard failure mode is the
  // character morphing across the 9 panels (Tandy with different face/body
  // proportions in panel 1 vs panel 5). Diffusion models render each cell as
  // a semi-independent image unless told otherwise. This sentence forces the
  // model to treat the character as a locked entity across all 9 cells.
  const consistency = `CRITICAL CONSISTENCY: every character must look IDENTICAL across all ${count} panels — same face shape, same proportions, same outfit, same color palette, same art style. This is one continuous scene shown in ${count} keyframes, NOT ${count} different versions of the character.`
  // Anti "storyboard production mode" — the 3x3 grid format nudges the model to
  // render deliberately-composed keyframes (posed, balanced). For phone/UGC
  // presets that reads fake. This forces genuinely candid, unstaged moments.
  // OFF for cinema/studio presets (they WANT composed frames).
  const candidLine = candid
    ? `CANDID, NOT STAGED: each cell is a genuine snapshot caught mid-moment — imperfect framing, natural unposed expressions, subjects slightly off-center, real skin texture with pores and slight asymmetry, slight motion blur on hands and hair. NOT a directed photoshoot, NOT posed storyboard frames.`
    : ''
  return `${header}\n${consistency}\n${candidLine}\n${conceptLine}\n${productRule}\n\nThe 9 stills, in order (left-to-right, top-to-bottom):\n${cells}`
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

// Per-model max duration cap, in seconds. Aligned with the caps enforced
// inside buildVidInput so the UI can warn users BEFORE they hit the silent
// truncation. Ref-to-video variants generally tighter than image-to-video.
export function getVideoMaxDuration(vidModel) {
  if (!vidModel) return 10
  const m = vidModel
  const isRef = m.includes('reference-to-video') || m.includes('ref-to-video')
  if (m.includes('grok-imagine')) {
    if (m.includes('text-to-video')) return 10 // conservative — t2v form defaults to 6s
    return isRef ? 10 : 15
  }
  if (m.includes('seedance-2.0/fast')) return 15        // both ref + i2v accept 4-15s per fal.ai dashboard
  if (m.includes('seedance')) return 15
  if (m.includes('happy-horse')) return 15
  if (m.includes('kling-video/v3/pro')) return 15
  if (m.includes('kling-video/v3')) return 10
  if (m.includes('kling-video/o3')) return 10
  if (m.includes('kling-video/v2.5')) return 15
  if (m.includes('veo3')) return 8        // conservative; some variants longer, verify per-call
  return 10
}

// Storyboard grids + direct mode REQUIRE a ref-to-video model (the 3x3 grid
// must be a sequence map, not a frame to animate). When the user picked a
// NON-ref model (e.g. "Grok Imagine"), we must switch — but to the SAME
// FAMILY's ref variant, not silently to Seedance. Respects the user's pick.
export function toRefToVideoModel(vidModel) {
  const m = (vidModel || '').toLowerCase()
  if (m.includes('reference-to-video') || m.includes('ref-to-video')) return vidModel // already ref
  if (m.includes('veo3')) return 'fal-ai/veo3.1/fast/reference-to-video'
  if (m.includes('grok')) return 'xai/grok-imagine-video/reference-to-video'
  if (m.includes('kling')) return 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video'
  if (m.includes('happy-horse')) return 'alibaba/happy-horse/reference-to-video'
  if (m.includes('seedance-2')) return 'bytedance/seedance-2.0/fast/reference-to-video'
  if (m.includes('seedance')) return 'fal-ai/bytedance/seedance/v1/lite/reference-to-video'
  return 'bytedance/seedance-2.0/fast/reference-to-video' // safe default for unknown families
}

export const VIDEO_MODELS = [
  { v: 'xai/grok-imagine-video/image-to-video', l: 'Grok Imagine — ~$0.07/dtk 720p (audio) 💰' },
  { v: 'xai/grok-imagine-video/reference-to-video', l: '🎭 Grok Imagine Ref-to-Video — ~$0.07/dtk (multi-ref, NO grid morph) 💰' },
  { v: 'xai/grok-imagine-video/text-to-video', l: '📝 Grok T2V — ~$0.07/dtk (pure text, audio) 💰' },
  { v: 'fal-ai/kling-video/v3/standard/image-to-video', l: 'Kling v3 — ~$0.08/dtk 💰' },
  { v: 'fal-ai/kling-video/o3/standard/image-to-video', l: 'Kling O3 — ~$0.11/dtk (audio)' },
  { v: 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video', l: '🎭 Kling 2.5 Pro Ref-to-Video — ~$0.12/dtk (NO morphing dari grid)' },
  { v: 'fal-ai/kling-video/v3/standard/text-to-video', l: '📝 Kling 3 T2V — ~$0.13/dtk (audio, multi-shot)' },
  { v: 'alibaba/happy-horse/image-to-video', l: 'Happy Horse 1.0 — ~$0.14/dtk' },
  { v: 'alibaba/happy-horse/reference-to-video', l: '🎭 Happy Horse Ref-to-Video — ~$0.14/dtk' },
  { v: 'alibaba/happy-horse/text-to-video', l: '📝 Happy Horse T2V — ~$0.14/dtk 720p (native audio, 1080p $0.28)' },
  { v: 'xai/grok-imagine-video/v1.5/image-to-video', l: 'Grok 1.5 i2v — ~$0.14/dtk 720p (audio, higher quality)' },
  { v: 'fal-ai/veo3.1/fast/image-to-video', l: '🎬 Veo 3.1 Fast — ~$0.15/dtk (Google, native audio, 4/6/8s)' },
  { v: 'fal-ai/veo3.1/fast/reference-to-video', l: '🎭 Veo 3.1 Fast Ref-to-Video — ~$0.15/dtk (multi-ref, native audio, 8s)' },
  { v: 'fal-ai/bytedance/seedance/v1/lite/reference-to-video', l: '🎭 Seedance Lite Ref-to-Video — ~$0.16/dtk' },
  { v: 'bytedance/seedance-2.0/fast/image-to-video', l: 'Seedance 2 Fast — ~$0.24/dtk' },
  { v: 'bytedance/seedance-2.0/fast/reference-to-video', l: '🎭 Seedance 2 Fast Ref-to-Video — ~$0.24/dtk' },
  { v: 'fal-ai/kling-video/v3/pro/image-to-video', l: 'Kling v3 Pro — ~$0.28/dtk (best quality)' },
  { v: 'bytedance/seedance-2.0/text-to-video', l: '📝 Seedance 2 T2V — ~$0.30/dtk 720p (cinematic, native audio, premium)' },
]

// AI video EDIT models — transform an EXISTING video via text instruction.
// Not generation models; used by god-mode edit_video tool (and future UIs).
export const VIDEO_EDIT_MODELS = [
  { v: 'xai/grok-imagine-video/edit-video', l: '✂️ Grok Edit Video — ~$0.08/dtk (cheap global edits: colorize, style, mood)' },
  { v: 'xai/grok-imagine-video/extend-video', l: '➕ Grok Extend Video — ~$0.08/dtk (nerusin footage asli — dipakai continue-shot)' },
  { v: 'alibaba/happy-horse/video-edit', l: '✂️ Happy Horse Video Edit — ~$0.28/dtk 720p (ref-image-guided edits, up to 5 refs, 1080p $0.56)' },
]
export const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — fast multi-ref, outfit adapts' },
  { v: 'openai/gpt-image-2', l: '🆕 GPT Image 2 (generation mode) — refs as hints, NOT pixel-locked' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — best text, pixel-locks refs' },
  // NOTE: was `xai/grok-imagine-image/quality/edit` — fal rejected
  // "/quality" as a path segment because it's actually a PARAMETER
  // (`quality: '1k'` in the request body, not a URL tier).
  { v: 'xai/grok-imagine-image/edit', l: '🆕 Grok Imagine Edit — multi-ref, $0.05 (1k) / $0.07 (2k) + $0.01/input' },
]
