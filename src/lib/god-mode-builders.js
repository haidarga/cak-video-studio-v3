// God Mode helper functions extracted from agent/route.js.
//
// These are PURE — no shared state, only model strings + payload data in,
// fal-ready input objects out. Extracted to:
//   1. Shrink route.js (was 1435 lines, now ~200 lighter)
//   2. Make builders testable in isolation
//   3. Let other endpoints (e.g. mass-variants worker) reuse the same
//      per-model field-name logic without copy-paste

import { canonicalFalPath } from '@/lib/fal-paths'

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
export function buildVideoInputForModel(model, { motion_prompt, image_url, image_urls, duration, aspect_ratio, resolution }) {
  const dur = String(Math.max(3, Math.min(15, parseInt(duration) || 5)))
  const ar = aspect_ratio || '9:16'

  const isI2V = model.includes('image-to-video')
  const isR2V = model.includes('reference-to-video')
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
      const elements = refsArr.slice(0, 4).map((u) => ({ frontal_image_url: u }))
      return { prompt: motion_prompt, ...(elements.length ? { elements } : {}), duration: dur, aspect_ratio: ar }
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
    if (isI2V) {
      return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar, resolution: '720p' }
    }
    if (isR2V) {
      return { prompt: motion_prompt, image_urls: refsArr.slice(0, 9), duration: parseInt(dur), aspect_ratio: ar, resolution: '720p' }
    }
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar, resolution: '720p' }
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
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar }
  }

  if (model.includes('veo3')) {
    return { prompt: motion_prompt, ...(image_url ? { image_url } : {}), duration: parseInt(dur), aspect_ratio: ar }
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
// (see src/lib/fal-client.js). Always canonicalizes model path first
// to avoid alias/canonical mismatch bugs (see src/lib/fal-paths.js).
export async function falCall(model, input, falKey) {
  const wireModel = canonicalFalPath(model)
  const res = await fetch(`https://fal.run/${wireModel}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.detail || data?.error || `fal.ai ${res.status}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return data
}

// ── Fetch URL → trimmed HTML ─────────────────────────────────────────
// Used by url_marketing tools to feed product page HTML into Gemini
// for extraction. Strips scripts/styles to save tokens; caps at 30k
// chars since most product pages have what we need in the first chunk.
export async function fetchUrlAsHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 CAK-Video-GodMode/1.0' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status}`)
  let html = await res.text()
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return html.slice(0, 30000)
}
