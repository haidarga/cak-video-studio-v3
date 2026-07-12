// God Mode helper functions extracted from agent/route.js.
//
// These are PURE — no shared state, only model strings + payload data in,
// fal-ready input objects out. Extracted to:
//   1. Shrink route.js (was 1435 lines, now ~200 lighter)
//   2. Make builders testable in isolation
//   3. Let other endpoints (e.g. mass-variants worker) reuse the same
//      per-model field-name logic without copy-paste

import { canonicalFalPath, candidateFalPaths } from '@/lib/fal-paths'

// Happy Horse tends to MORPH/drift the subject across frames and wander in
// style. fal's HH endpoint has NO negative_prompt field, so we steer stability
// through the POSITIVE prompt: a compact clause appended to every HH gen that
// pins identity + style. Shared by God Mode + F Creator (both use this builder).
export const HAPPYHORSE_STABILITY = ' Keep ONE consistent visual style and identical subject appearance — same face, proportions, outfit and color palette across every frame. Smooth, coherent, physically stable motion. NO morphing, NO warping, NO melting, NO style drift, NO shape-shifting, NO flicker, NO identity change.'

// LTX-2.3 anti-artifact negative prompt. Starts from fal's tuned default
// quality list, then ADDS the temporal + identity failure modes LTX is prone
// to once things start MOVING: face morphing, character drift between frames,
// flicker, melting, limb/face duplication, smearing. Baked in as the default
// so every LTX gen ships clean without the caller thinking about it.
const LTX_NEGATIVE_PROMPT = 'color distortion, overexposure, static, blurry details, subtitles, style, artwork, painting, frame, still, dim overall tone, worst quality, low quality, JPEG compression artifacts, ugly, mutilated, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, malformed limbs, fused fingers, motionless frame, cluttered background, three legs, crowded background, walking backwards, morphing, warping, melting, shape-shifting, face distortion, changing face, identity change, inconsistent character, character drift, flickering, flicker, temporal instability, jitter, ghosting, duplicated limbs, duplicated face, extra heads, drifting features, wobbling, frame blending artifacts, glitch, smearing, stretched anatomy, unstable proportions'

// Wan 2.7 negative prompt — fal's playground default + temporal/identity
// anti-drift terms (Wan can morph faces/limbs on longer motion like any
// video model).
const WAN_NEGATIVE_PROMPT = 'low resolution, errors, worst quality, low quality, incomplete, extra fingers, bad proportions, blurry, distorted, morphing, warping, melting, face distortion, identity change, character drift, flickering, jitter, duplicated limbs, deformed, malformed limbs'

// Veo 3.1 anti-morph. Lip/mouth/teeth morphing while speaking is Veo's main
// artifact. i2v exposes negative_prompt; r2v does NOT (sending it 422s), so
// r2v gets the same intent via the POSITIVE prompt.
const VEO_NEGATIVE_PROMPT = 'morphing face, warping lips, distorted mouth, deformed teeth, melting facial features, smeared mouth, jittering lips, rubbery mouth, malformed teeth, extra teeth, lip-sync artifacts, flickering face, unstable facial features, face distortion, identity change, character drift, warping, melting, blurry mouth'
const VEO_FACE_STABILITY = ' Keep the face and especially the MOUTH, LIPS and TEETH stable, natural and consistent while speaking — no morphing, warping, smearing, melting or flickering of the lips, teeth or facial features in any frame.'

// ── Product fidelity directive ───────────────────────────────────────
// Injects the active product's textual knowledge (description, dimensions,
// features, label text, etc) into a prompt as a STRONG fidelity directive.
// Without this, the diffusion model only sees the product as a fuzzy image
// reference and drifts across shots — colors change, labels disappear,
// proportions shift. With this, the model has BOTH the image AND the
// textual spec, which dramatically reduces multi-shot drift.
//
// Why this exists at all:
// The user fills out product detail with description / dimensions / features
// in the product modal — that data goes into products.knowledge (jsonb).
// But god-mode tools previously only sent the image ref to fal, never the
// text. That's why "UGREEN charger" became "generic black charger" by
// shot 3 — model had no anchor beyond the drifting visual cue.
//
// Output: a string fragment ready to append to the user-supplied prompt.
// Returns '' when there's nothing useful to add (no active product, empty
// knowledge), so callers can blindly concatenate.
export function buildProductFidelityDirective(activeProduct) {
  if (!activeProduct) return ''
  const k = activeProduct.knowledge
  const label = activeProduct.label || ''

  // `knowledge` in v3 refs table is plain TEXT (see migrations/0001_init.sql).
  // Older god-mode code stringified it as JSON, suggesting some product
  // sources might store an object. Handle both shapes.
  const parts = []
  if (label) parts.push(`product name: "${label}"`)

  if (typeof k === 'string') {
    const note = k.trim().slice(0, 600)
    if (note) parts.push(`details: ${note}`)
  } else if (k && typeof k === 'object') {
    if (k.description) parts.push(`description: ${String(k.description).slice(0, 400)}`)
    if (k.dimensions) parts.push(`dimensions: ${k.dimensions}`)
    if (k.color) parts.push(`color: ${k.color}`)
    if (k.material) parts.push(`material: ${k.material}`)
    if (Array.isArray(k.features) && k.features.length) {
      parts.push(`key features: ${k.features.slice(0, 5).join(', ')}`)
    }
    if (k.label_text) parts.push(`label/branding text: "${k.label_text}"`)
    if (k.shape) parts.push(`shape: ${k.shape}`)
    if (parts.length <= 1 && (k.notes || k.description)) {
      const note = String(k.notes || k.description).slice(0, 500)
      if (note) parts.push(note)
    }
  }

  if (parts.length === 0) return ''

  // Strong directive language so the model treats this as binding spec.
  // Mirrors v2's productDirective in fal-client.js (which was never wired
  // up in v3 — this replaces it). Phrasing chosen to survive diffusion
  // token-budget pressure: "CRITICAL" + "EXACTLY" anchors the model.
  return `\n\nCRITICAL PRODUCT FIDELITY — render the product EXACTLY as specified, identical across every shot: ${parts.join('; ')}. Product label text must be sharp, legible, correctly spelled. Do NOT substitute, abstract, or vary the product between shots.`
}

// ── Video input builder ──────────────────────────────────────────────
// Per-model branches that hand fal.ai the right field names. The trap
// this exists to avoid: each video family uses a DIFFERENT field name
// for the source image(s). Sending `image_url` to Grok's ref-to-video
// endpoint silently 422s on missing `reference_image_urls`. This
// function routes by MODEL VARIANT (i2v / r2v / t2v) extracted from
// the model URL, never by which input field happens to be set —
// previous bug was routing on `if (image_url)` which broke any ref-to-
// video model after we started auto-promoting chat attachments as
// image_url.
export function buildVideoInputForModel(model, { motion_prompt, image_url, image_urls, duration, aspect_ratio, resolution, seed }) {
  const dur = String(Math.max(3, Math.min(15, parseInt(duration) || 5)))
  const ar = aspect_ratio || '9:16'

  const isI2V = model.includes('image-to-video')
  // Kling's ref endpoint is '/ref-to-video'; every other family uses
  // '/reference-to-video'. Match BOTH, else Kling-ref falls through to the
  // default branch with no `elements` and fal 422s on missing frontal images.
  const isR2V = model.includes('reference-to-video') || model.includes('ref-to-video')
  const isT2V = model.includes('text-to-video')

  // Unified refs array — explicit image_urls when provided, else fall
  // back to single image_url as a 1-element array. Lets ref-to-video
  // models accept a single-source caller (e.g. storyboard auto-route
  // where the grid image is itself the reference).
  const refsArr = (image_urls && image_urls.length > 0)
    ? image_urls.filter(Boolean)
    : (image_url ? [image_url] : [])

  if (model.includes('kling-video')) {
    if (isI2V) {
      return { prompt: motion_prompt, start_image_url: image_url || refsArr[0], duration: dur, aspect_ratio: ar }
    }
    if (isR2V) {
      // O3 rejects an element with ONLY frontal_image_url ("Either frontal_image_url
      // and reference_image_urls or video_url must be provided") — mirror the same
      // image into reference_image_urls since we only have one photo per character.
      const elements = refsArr.slice(0, 4).map((u) => ({ frontal_image_url: u, reference_image_urls: [u] }))
      return { prompt: motion_prompt, ...(elements.length ? { elements } : {}), duration: dur, aspect_ratio: ar }
    }
    if (isT2V) {
      return { prompt: motion_prompt, duration: String(Math.min(10, parseInt(dur))), aspect_ratio: ar, generate_audio: true }
    }
    return { prompt: motion_prompt, duration: dur, aspect_ratio: ar }
  }

  if (model.includes('seedance')) {
    const okAR = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
    const finalAR = okAR.includes(ar) ? ar : 'auto'
    if (isI2V) {
      return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: dur, resolution: resolution || '720p', aspect_ratio: finalAR }
    }
    if (isR2V) {
      return { prompt: motion_prompt, image_urls: refsArr.slice(0, 9), duration: dur, resolution: resolution || '720p', aspect_ratio: finalAR }
    }
    return { prompt: motion_prompt, duration: dur, resolution: resolution || '720p', aspect_ratio: finalAR }
  }

  if (model.includes('happy-horse')) {
    // enable_safety_checker:false — user-requested bypass (NSFW false-positives
    // block legit ad content). + anti-morph stability clause on the prompt.
    const hhPrompt = motion_prompt + HAPPYHORSE_STABILITY
    if (isI2V) {
      return { prompt: hhPrompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar, resolution: '720p', enable_safety_checker: false }
    }
    if (isR2V) {
      return { prompt: hhPrompt, image_urls: refsArr.slice(0, 9), duration: parseInt(dur), aspect_ratio: ar, resolution: '720p', enable_safety_checker: false }
    }
    return { prompt: hhPrompt, duration: parseInt(dur), aspect_ratio: ar, resolution: '720p', enable_safety_checker: false }
  }

  if (model.includes('grok-imagine')) {
    if (isI2V) {
      return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar }
    }
    if (isR2V) {
      // Field name `reference_image_urls` (NOT image_urls) — fal returned 422
      // "reference_image_urls: Field required" when we sent image_urls.
      return { prompt: motion_prompt, reference_image_urls: refsArr.slice(0, 6), duration: parseInt(dur), aspect_ratio: ar }
    }
    if (isT2V) {
      return { prompt: motion_prompt, duration: Math.min(10, parseInt(dur)), resolution: resolution || '720p', aspect_ratio: ar }
    }
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar }
  }

  if (model.includes('veo3')) {
    // Veo 3.1 Fast (Google). duration is a STRING w/ `s` suffix (4s/6s/8s for
    // i2v; r2v locked to 8s). safety_tolerance is a STRING "1".."6", 6 = most
    // permissive (user-requested MAX). i2v=image_url, r2v=image_urls (max 3
    // refs). r2v AR limited to 16:9/9:16. generate_audio for native dialog.
    const veoAR = ['16:9', '9:16'].includes(ar) ? ar : (isR2V ? '9:16' : 'auto')
    const base = { resolution: resolution || '720p', aspect_ratio: veoAR, generate_audio: true, safety_tolerance: '6' }
    if (isR2V) {
      // r2v has no negative_prompt field — bake anti-morph into the positive.
      return { ...base, prompt: motion_prompt + VEO_FACE_STABILITY, image_urls: refsArr.slice(0, 3), duration: '8s' }
    }
    const n = parseInt(dur) || 8
    const veoDur = n >= 7 ? '8s' : n >= 5 ? '6s' : '4s'
    return { ...base, prompt: motion_prompt, negative_prompt: VEO_NEGATIVE_PROMPT, ...(image_url || refsArr[0] ? { image_url: image_url || refsArr[0] } : {}), duration: veoDur }
  }

  // LTX-2.3 (fal-ai/ltx-2.3-quality/*) — high-quality video WITH native audio.
  // FRAME-based, not duration-based: the schema takes num_frames (must be 8n+1,
  // default 121 ≈ 5s @24fps) + frames_per_second, NOT a `duration` field.
  // resolution is a fal ImageSize enum (portrait_16_9 / landscape_16_9 / square_hd).
  // enable_safety_checker is forced OFF — xAI-style NSFW false-positives block
  // legit ad content, and the user explicitly wants it disabled (only possible
  // via API; the playground can't turn it off).
  if (model.includes('ltx')) {
    const fps = 24
    const secs = Math.max(3, Math.min(15, parseInt(dur) || 5))
    const num_frames = Math.round((secs * fps) / 8) * 8 + 1 // snap to 8n+1
    const resMap = { '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '1:1': 'square_hd' }
    const base = {
      prompt: motion_prompt,
      negative_prompt: LTX_NEGATIVE_PROMPT,
      num_frames,
      frames_per_second: fps,
      resolution: resMap[ar] || 'portrait_16_9',
      generate_audio: true,
      // Prompt expansion ON — fal rewrites/enriches the prompt server-side for
      // sharper scene coherence (matters more since God Mode's LTX fast-path
      // skips Gemini, so this is the only prompt-cleanup step).
      enable_prompt_expansion: true,
      enable_safety_checker: false, // user-requested OFF (NSFW false-positives)
      // ── Quality recipe (mirrors the 3rd-party "Balanced 30+4 / HQ sampler"
      //    preset the user referenced) ──
      // LTX is priced PER MEGAPIXEL (W×H×frames), INDEPENDENT of steps/quality.
      // So maxing the quality levers costs $0 extra — only adds gen time. Free
      // quality, so we take it: this is the anti-artifact/morph/drift recipe.
      num_inference_steps: 30, // schema MAX — most denoise passes = cleanest detail, least smear
      guidance_scale: 1,       // LTX distilled WANTS low CFG; raising it ADDS artifacts, not fewer
      video_quality: 'maximum', // top of the enum (low|medium|high|maximum) — fal's "Quality" preset equivalent
      video_write_mode: 'balanced', // not 'small' — small re-compresses harder = mushier output
      // Seed — when locked, the same prompt re-gens the SAME clip (consistency /
      // reproducibility). LTX supports it natively; omitted when not provided.
      ...(Number.isFinite(seed) ? { seed } : {}),
    }
    // LTX has i2v/r2v variants too — pass the source image(s) when present so
    // this builder stays correct if those endpoints get wired later.
    if (isI2V && (image_url || refsArr[0])) base.image_url = image_url || refsArr[0]
    if (isR2V && refsArr.length) base.image_urls = refsArr.slice(0, 6)
    return base
  }

  // Wan 2.7 (fal-ai/wan/v2.7/*) — smooth-motion video. Has a REAL
  // enable_safety_checker (API-only, can't disable on the playground), so we
  // force it OFF per the user. Priced per second ($0.10/s @720p, $0.15/s
  // @1080p) → default 720p to keep batch cost sane; pass resolution:'1080p'
  // for hero shots. i2v derives AR from the source image; t2v takes aspect_ratio.
  if (model.includes('wan')) {
    const base = {
      prompt: motion_prompt,
      negative_prompt: WAN_NEGATIVE_PROMPT,
      resolution: resolution || '720p',
      duration: Math.max(3, Math.min(10, parseInt(dur) || 5)),
      enable_prompt_expansion: true,
      enable_safety_checker: false, // user-requested OFF (only possible via API)
      ...(Number.isFinite(seed) ? { seed } : {}),
    }
    if (isI2V && (image_url || refsArr[0])) base.image_url = image_url || refsArr[0]
    else base.aspect_ratio = ar
    return base
  }

  // Generic fallback — pick shape by variant if detectable, else send both.
  if (isI2V) {
    return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar }
  }
  if (isR2V) {
    return { prompt: motion_prompt, image_urls: refsArr.slice(0, 6), duration: parseInt(dur), aspect_ratio: ar }
  }
  if (isT2V) {
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar }
  }
  return {
    prompt: motion_prompt,
    ...(image_url ? { image_url, start_image_url: image_url } : {}),
    ...(image_urls?.length ? { image_urls: image_urls.slice(0, 6) } : {}),
    duration: parseInt(dur),
    aspect_ratio: ar,
  }
}

// ── Video EDIT input builder ─────────────────────────────────────────
// Transform an EXISTING video via text instruction. Two models, two shapes:
//   xai/grok-imagine-video/edit-video : { prompt, video_url } — cheap global
//     edits (colorize, style, mood). ~$0.08/s.
//   alibaba/happy-horse/video-edit    : { video_url, prompt,
//     reference_image_urls?, resolution } — ref-image-GUIDED edits (swap
//     product/character look while anchored to refs, up to 5). ~$0.28/s 720p.
export function buildVideoEditInput(model, { prompt, video_url, reference_image_urls, resolution, duration }) {
  if (!video_url) throw new Error('video_url required for video edit')
  if (model.includes('happy-horse')) {
    const refs = (reference_image_urls || []).filter(Boolean).slice(0, 5)
    return {
      video_url,
      prompt,
      ...(refs.length ? { reference_image_urls: refs } : {}),
      resolution: resolution === '1080p' ? '1080p' : '720p',
    }
  }
  if (model.includes('extend-video')) {
    // Grok extend — continues the actual footage. duration = seconds ADDED.
    return { prompt, video_url, duration: Math.max(5, Math.min(15, parseInt(duration) || 10)) }
  }
  // grok edit-video
  return { prompt, video_url }
}

// Strict fal-storage mirror — returns NULL when the source can't be fetched
// (dead host, 404, expired signature) instead of falling back to the original
// URL. Retry paths use this to DROP dead refs rather than resubmitting a URL
// fal already told us it can't download (r2.ai-assist.me ghosts, etc).
export async function mirrorToFalStorageStrict(externalUrl, falKey) {
  try {
    const res = await fetch(externalUrl)
    if (!res.ok) return null
    const blob = await res.blob()
    const { fal } = await import('@fal-ai/client')
    fal.config({ credentials: falKey })
    const url = await fal.storage.upload(blob)
    return url || null
  } catch {
    return null
  }
}

// ── Image input builder ──────────────────────────────────────────────
// Per-model field-name routing for image gen. nano-banana edit takes
// image_urls; flux-lora takes image_size + loras; gpt-image-2/edit
// requires at least one source image (throws if caller forgot).
export function buildImageInputForModel(model, { prompt, refs, ar, quality }) {
  const refList = (refs || []).filter(Boolean).slice(0, 8)

  if (model.includes('nano-banana')) {
    const isEdit = model.includes('edit')
    return {
      prompt,
      ...(isEdit ? { image_urls: refList } : {}),
      output_format: 'jpeg',
    }
  }

  if (model.includes('gpt-image')) {
    const isEdit = model.includes('edit')
    if (isEdit && refList.length === 0) {
      throw new Error('GPT Image 2 Edit mode butuh minimal 1 source image. Upload gambar ke chat dulu.')
    }
    return {
      prompt,
      ...(isEdit ? { image_urls: refList } : {}),
      quality: quality === '1080p' ? 'high' : 'medium',
      aspect_ratio: ar || '1:1',
    }
  }

  if (model.includes('grok-imagine')) {
    return { prompt, image_urls: refList, aspect_ratio: ar || '1:1' }
  }

  if (model.includes('flux-lora')) {
    const arMap = { '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '1:1': 'square_hd', '4:5': 'portrait_4_3', '3:4': 'portrait_4_3' }
    return {
      prompt,
      loras: [],
      image_size: arMap[ar] || 'square_hd',
    }
  }

  return { prompt, image_urls: refList }
}

// ── Fal sync helper ──────────────────────────────────────────────────
// Lightweight wrapper for endpoints that finish quickly (image gen).
// For video gen which takes 1-3 min, use the queue + webhook pattern
// (see src/lib/fal-client.js).
//
// DEFENSIVE MULTI-PATH submit: tries canonical first, then alias forms,
// then algorithmic derivations. The catalog has historically had wrong
// model paths (e.g. `xai/grok-imagine-image/quality/edit` — "/quality"
// isn't a path segment, it's the resolution PARAMETER `quality: '1k'`).
// Without multi-path, one bad catalog entry breaks the whole tool.
// Returns the result from the first path that works. Throws the last
// error if none work.
export async function falCall(model, input, falKey) {
  const candidates = candidateFalPaths(model)
  let lastError = null

  for (const wireModel of candidates) {
    try {
      const res = await fetch(`https://fal.run/${wireModel}`, {
        method: 'POST',
        headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) return data

      const msg = data?.detail || data?.error || `fal.ai ${res.status}`
      const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg)
      // Skip "Path /X not found" + 404 to next candidate — that's the
      // catalog-has-wrong-path bug. For 4xx like 422 (content rejected)
      // or 5xx, the path was probably correct + retrying won't help.
      const isPathMiss = res.status === 404 || /path .* not found/i.test(msgStr)
      lastError = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
      if (!isPathMiss) throw lastError
    } catch (e) {
      lastError = e
      if (!/path .* not found|404/i.test(String(e?.message || e))) throw e
    }
  }
  throw lastError || new Error('all fal path candidates failed')
}

// ── Mirror external image URL to our R2 ──────────────────────────────
// Many product CDNs (Sociolla, Tokopedia, IG CDN, etc) block hotlinking
// — they refuse downloads without the right Referer header or block
// known bot UAs. When we pass such a URL to fal.ai, fal gets a 403/404
// and returns "Failed to download the file. Please check if the URL is
// accessible." Mirroring through R2 (our public CORS-friendly bucket)
// fixes this — fal can always download from R2 since R2 sets no
// hotlink protection.
//
// Returns the R2 URL on success, or the original URL on failure (fal
// might still be able to fetch it; better than throwing).
export async function mirrorToR2(externalUrl, folder = 'mirrored') {
  try {
    const { uploadToR2 } = await import('@/lib/r2-client')
    const res = await fetch(externalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
        'Referer': new URL(externalUrl).origin,
      },
    })
    if (!res.ok) {
      console.warn('[mirrorToR2] fetch failed:', res.status, externalUrl.slice(-60))
      return externalUrl
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = res.headers.get('content-type') || 'image/jpeg'
    const ext = mime.split('/')[1]?.split(';')[0] || 'jpg'
    const hash = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
    const key = `${folder}/${hash}.${ext}`
    return await uploadToR2(key, buf, mime)
  } catch (e) {
    console.warn('[mirrorToR2] error:', e.message, '— falling back to original URL')
    return externalUrl
  }
}

// ── Mirror to FAL STORAGE — for "Failed to download the file" retries ──
// Root cause this fixes: attachments live on R2's pub-*.r2.dev dev domain,
// which Cloudflare RATE-LIMITS. fal's downloader intermittently gets 429
// → submit/gen fails with file_download_error even though the URL works
// in a browser. Mirroring R2→R2 (mirrorToR2) can't fix that. Re-hosting
// the file on fal's OWN storage (fal.media) can — fal always reads its
// own bucket. Server fetch from r2.dev is fine (we're not rate-limited
// the way fal's fleet is).
// Returns the fal.media URL, or the original URL if anything fails.
export async function mirrorToFalStorage(externalUrl, falKey) {
  try {
    const res = await fetch(externalUrl)
    if (!res.ok) {
      console.warn('[mirrorToFalStorage] source fetch failed:', res.status, externalUrl.slice(-60))
      return externalUrl
    }
    const blob = await res.blob()
    const { fal } = await import('@fal-ai/client')
    fal.config({ credentials: falKey })
    const url = await fal.storage.upload(blob)
    return url || externalUrl
  } catch (e) {
    console.warn('[mirrorToFalStorage] error:', e.message, '— falling back to original URL')
    return externalUrl
  }
}

// ── Fetch URL → structured product data + trimmed HTML ──────────────
// Used by url_marketing tools.
//
// Why this was rewritten:
// Original version stripped `<script>` BEFORE returning, which killed
// the JSON-LD <script type="application/ld+json"> blocks that e-commerce
// sites use to embed structured Product schema. It also used a custom
// User-Agent ("CAK-Video-GodMode/1.0") that Shopee, Sociolla, Tokopedia
// recognize as a bot and serve empty shells.
//
// Modern e-commerce sites are JS-hydrated SPAs — the visible HTML is
// just a shell + meta tags. The ACTUAL product data lives in:
//   1. <meta property="og:image|og:title|og:description"> — always
//      server-rendered for social sharing
//   2. <script type="application/ld+json"> — Product schema (price,
//      images array, name, description, brand) for SEO + Google
//      shopping integration
//   3. Twitter Card metas as backup
//
// New behavior:
//   1. Fetch with realistic browser User-Agent + Referer matching the
//      site's own origin (most anti-bot rules pass this)
//   2. BEFORE stripping scripts, extract OG meta + JSON-LD Product
//      schema into a structured "STRUCTURED PRODUCT DATA" preamble
//   3. Then strip + trim the rest of HTML
//   4. Return preamble + clean HTML (capped 30k) — Gemini sees the
//      reliable structured data FIRST + can fall back to visible
//      HTML for context
export async function fetchUrlAsHtml(url, opts = {}) {
  // opts: { cookie?: string, _noRetry?: boolean }
  // cookie is forwarded to /api/scrape-spa for the Browserless fallback
  // so that internal route call sees the same auth context as the agent
  // request. _noRetry prevents infinite loop if Browserless also returns
  // an SPA shell.
  const u = new URL(url)
  const res = await fetch(url, {
    headers: {
      // Real Chrome UA — bypasses most anti-bot rules on e-commerce sites
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': u.origin,
    },
    redirect: 'follow',
  })
  if (!res.ok) {
    // Some sites have bulletproof bot-protection (Akamai, Cloudflare Bot
    // Manager, Imperva). Louis Vuitton, Nike, Apple, big banks all use
    // these — they detect data-center IPs (Vercel, AWS, etc) and 403
    // EVERYTHING regardless of UA / headers. Server-side scraping is
    // genuinely impossible for these sites without a residential proxy.
    // Surface a clear error with workaround instead of generic "fetch failed".
    if (res.status === 403 || res.status === 429) {
      throw new Error(`Site ini di-protect anti-bot Akamai/Cloudflare (403 dari Vercel IP). Server-side scrape gak bisa di-bypass. Workaround: screenshot product photo + paste ke chat ini lewat 📎, lalu kasih konteks "ini produk X dari brand Y, bikinin video review".`)
    }
    throw new Error(`URL fetch failed: ${res.status}. Cek URL valid + accessible publicly.`)
  }
  const rawHtml = await res.text()

  // ── Extract structured data BEFORE strip ──
  const preamble = []
  preamble.push(`SOURCE_URL: ${url}`)

  // OG meta tags
  const ogMatches = rawHtml.matchAll(/<meta\s+(?:property|name)=["']([^"']+)["']\s+content=["']([^"']*)["']/gi)
  const og = {}
  for (const m of ogMatches) {
    const key = m[1].toLowerCase()
    if (
      key.startsWith('og:') ||
      key.startsWith('twitter:') ||
      key === 'description' ||
      key === 'product:price:amount' ||
      key === 'product:price:currency' ||
      key === 'price'
    ) {
      og[key] = m[2]
    }
  }
  if (Object.keys(og).length) {
    preamble.push('OG_META:')
    for (const [k, v] of Object.entries(og)) {
      preamble.push(`  ${k}: ${v}`)
    }
  }

  // JSON-LD blocks (Product schema is the key one)
  const ldMatches = rawHtml.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  const ldBlocks = []
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim())
      // Only keep Product / Offer / nested Product entities (skip BreadcrumbList etc)
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        const type = item['@type'] || item['@graph']?.[0]?.['@type']
        if (typeof type === 'string' && /product|offer/i.test(type)) {
          ldBlocks.push(JSON.stringify(item).slice(0, 2000))
        }
      }
    } catch {
      // Malformed JSON-LD — skip
    }
  }
  if (ldBlocks.length) {
    preamble.push('JSON_LD_PRODUCT:')
    preamble.push(...ldBlocks)
  }

  // ── Strip + trim HTML for fallback context ──
  let html = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Total budget: 30k chars. Preamble first (high signal), then HTML tail.
  const preambleStr = preamble.join('\n')
  const htmlBudget = Math.max(2000, 30000 - preambleStr.length - 100)
  const combined = `${preambleStr}\n\n--- HTML BODY (fallback) ---\n${html.slice(0, htmlBudget)}`

  // SPA detection — if we extracted ZERO structured data AND the body
  // tail is minimal text, this is a JS-hydrated SPA (Sociolla, Shopee,
  // Tokopedia, Lazada modern UIs). Server-side fetch can't see product
  // data because it only loads AFTER browser JS execution. Two paths:
  //   1. BROWSERLESS_TOKEN env var set -> auto-retry via headless
  //      Playwright (real browser, sees post-hydration DOM)
  //   2. No token set -> throw with workaround hint
  const hasStructuredData = ldBlocks.length > 0 || Object.keys(og).length > 0
  const bodyText = html.replace(/<[^>]+>/g, '').trim()
  const looksLikeSpa = !hasStructuredData && bodyText.length < 500
  if (looksLikeSpa) {
    // Try Browserless fallback IF token is configured. Caller may have
    // hit this from a route already; we proxy through our own endpoint
    // (rather than calling Browserless directly) so the auth boundary +
    // env var stay on the server. Pass `_internalBrowserlessRetry: true`
    // to prevent infinite recursion if browserless itself returns shell.
    if (process.env.BROWSERLESS_TOKEN && !opts._noRetry) {
      try {
        const proto = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL || 'localhost:3000'}`
        const blRes = await fetch(`${proto}/api/scrape-spa`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Forward cookie so /api/scrape-spa sees the logged-in user
            ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          },
          body: JSON.stringify({ url, waitFor: 5000 }),
        })
        const blJson = await blRes.json().catch(() => ({}))
        if (blJson.ok && blJson.html) {
          // Re-run extraction on the rendered HTML — recursive call with
          // _noRetry guard to prevent infinite loop if browserless also
          // returns an empty shell (rare but possible).
          return await fetchUrlAsHtmlFromBuffer(url, blJson.html)
        }
      } catch (e) {
        console.warn('[fetchUrlAsHtml] browserless fallback failed:', e.message)
      }
    }
    const err = new Error(`SPA_NO_DATA`)
    err.isSpaShell = true
    err.host = u.host
    throw err
  }
  return combined
}

// Internal: run the OG/JSON-LD extraction pass on an already-fetched
// HTML buffer (e.g. from Browserless rendered output). Same logic as
// fetchUrlAsHtml minus the initial fetch + minus SPA fallback (we
// already came from there).
async function fetchUrlAsHtmlFromBuffer(url, rawHtml) {
  const u = new URL(url)
  const preamble = [`SOURCE_URL: ${url}`]

  const ogMatches = rawHtml.matchAll(/<meta\s+(?:property|name)=["']([^"']+)["']\s+content=["']([^"']*)["']/gi)
  const og = {}
  for (const m of ogMatches) {
    const key = m[1].toLowerCase()
    if (key.startsWith('og:') || key.startsWith('twitter:') || key === 'description' || /price/i.test(key)) {
      og[key] = m[2]
    }
  }
  if (Object.keys(og).length) {
    preamble.push('OG_META:')
    for (const [k, v] of Object.entries(og)) preamble.push(`  ${k}: ${v}`)
  }

  const ldMatches = rawHtml.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  const ldBlocks = []
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim())
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        const type = item['@type'] || item['@graph']?.[0]?.['@type']
        if (typeof type === 'string' && /product|offer/i.test(type)) {
          ldBlocks.push(JSON.stringify(item).slice(0, 2000))
        }
      }
    } catch {}
  }
  if (ldBlocks.length) {
    preamble.push('JSON_LD_PRODUCT:')
    preamble.push(...ldBlocks)
  }

  // Also pull visible text from rendered DOM — much more meaningful
  // than from raw shell since Browserless has executed all JS
  const html = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const preambleStr = preamble.join('\n')
  const htmlBudget = Math.max(2000, 30000 - preambleStr.length - 100)

  // If STILL no data + body still empty, browserless also failed to
  // get product data (e.g. site requires login). Throw so caller can
  // suggest manual workaround.
  const hasStructuredData = ldBlocks.length > 0 || Object.keys(og).length > 0
  const bodyText = html.replace(/<[^>]+>/g, '').trim()
  if (!hasStructuredData && bodyText.length < 500) {
    const err = new Error('SPA_NO_DATA_AFTER_RENDER')
    err.isSpaShell = true
    err.host = u.host
    throw err
  }
  return `${preambleStr}\n\n--- HTML BODY (rendered) ---\n${html.slice(0, htmlBudget)}`
}
