// Browser-side fal helper that proxies through /api/fal/*. The FAL_KEY stays
// on the server. submitRun returns once the fal job is COMPLETED (or throws).

export async function falRun(model, input, { onProgress, maxWaitMs = 600000, workspaceId, duration } = {}) {
  const submitRes = await fetch('/api/fal/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  })
  const submit = await submitRes.json()
  if (!submit.ok) throw new Error(submit.error || 'submit failed')
  const requestId = submit.request_id
  if (!requestId) throw new Error('no request_id from fal')

  const start = Date.now()
  let lastLog = 0
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000))
    const statusRes = await fetch(`/api/fal/status?model=${encodeURIComponent(model)}&request_id=${requestId}`, { cache: 'no-store' })
    const s = await statusRes.json()
    if (!s.ok) throw new Error(s.error || 'status check failed')
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed - lastLog >= 5) { onProgress?.(`${s.status} (${elapsed}s)`); lastLog = elapsed }
    if (s.status === 'COMPLETED') break
    if (s.status === 'FAILED' || s.status === 'ERROR') throw new Error(s.error?.message || s.error || 'fal job failed')
  }
  // Pass workspace_id + duration ke result endpoint biar usage logger bisa
  // record cost dengan benar (per-second untuk video, flat untuk image)
  const ws = workspaceId ? `&workspace_id=${workspaceId}` : ''
  const dur = duration ? `&duration=${duration}` : ''
  const resultRes = await fetch(`/api/fal/result?model=${encodeURIComponent(model)}&request_id=${requestId}${ws}${dur}`, { cache: 'no-store' })
  const r = await resultRes.json()
  if (!r.ok) throw new Error(r.error || 'result fetch failed')
  return r
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
  if (imgModel.includes('imagen-4-fast/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 8) } : {}), aspect_ratio: ar, num_images: 1 }
  }
  if (imgModel.includes('seedream/v4/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 6) } : {}), aspect_ratio: ar, num_images: 1 }
  }
  if (imgModel.includes('qwen-image-edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 4) } : {}), aspect_ratio: ar, num_images: 1 }
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
    // xAI Grok Imagine Video — image-to-video with audio. Cap at 15s per
    // fal.ai schema. Resolution 720p ($0.07/s) — 480p ($0.05/s) available but
    // we prefer quality. aspect_ratio='auto' lets the model infer from source.
    return {
      prompt,
      image_url,
      duration: Math.max(5, Math.min(15, parseInt(duration) || 5)),
      resolution: '720p',
      aspect_ratio: aspect_ratio || 'auto',
    }
  }
  return { prompt, image_url, duration: parseInt(duration) || 5, aspect_ratio }
}

// Build the 3×3 storyboard grid LAYOUT HEADER only.
// Pre-refactor this dumped ad-agency boilerplate ('Professional ... well-balanced
// composition', 'Cohesive lighting & color grade', 'No watermark') that
// contradicted UGC/animation camera presets at the compiler stage. Now it
// returns ONLY the layout instructions — quality / continuity / negatives are
// owned by prompt-compiler.
//
// constraints = { skipDialog, skipOnscreen, skipProduct }
export function buildStoryboardGridPrompt(panels = [], ar = '9:16', concept = '', constraints = {}) {
  const nine = panels.slice(0, 9)
  let t = 0
  const cells = nine.map((p) => {
    const dur = Math.max(1, parseInt(p.seconds) || 2)
    const range = `${t}-${t + dur} detik`
    t += dur
    const lines = [`Cell ${p.n} (${range}) — ${(p.title || '').trim()}`]
    if (p.shot_type) lines.push(`   Camera: ${p.shot_type}`)
    lines.push(`   Action: ${(p.visual || p.scene || '').trim()}`)
    if (!constraints.skipDialog && p.dialog) lines.push(`   Dialog: "${p.dialog.trim()}"`)
    if (!constraints.skipOnscreen && p.onscreen) lines.push(`   Caption: ${p.onscreen.trim()}`)
    return lines.join('\n')
  }).join('\n\n')
  const conceptLine = concept ? `Concept: ${concept.trim()}.` : ''
  const productRule = constraints.skipProduct
    ? 'No product or brand packaging in any cell — lifestyle moments only.'
    : 'Product appears in cells marked Product Shot only.'
  const header = `Storyboard sheet layout: ${ar} canvas, 3x3 grid (3 rows × 3 columns), thin grey lines, scene-number badge + time range per cell, one still per cell, concise text block under each still.`
  return `${header}\n${conceptLine}\n${productRule}\n\nCELLS:\n${cells}`
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
  { v: 'fal-ai/kling-video/v3/standard/image-to-video', l: 'Kling v3 — ~$0.08/dtk 💰' },
  { v: 'fal-ai/kling-video/o3/standard/image-to-video', l: 'Kling O3 — ~$0.11/dtk (audio)' },
  { v: 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video', l: '🎭 Kling 2.5 Pro Ref-to-Video — ~$0.12/dtk (NO morphing dari grid)' },
  { v: 'alibaba/happy-horse/image-to-video', l: 'Happy Horse 1.0 — ~$0.14/dtk' },
  { v: 'fal-ai/bytedance/seedance/v1/lite/reference-to-video', l: '🎭 Seedance Ref-to-Video — ~$0.16/dtk' },
  { v: 'bytedance/seedance-2.0/fast/image-to-video', l: 'Seedance 2 Fast — ~$0.24/dtk' },
  { v: 'fal-ai/kling-video/v3/pro/image-to-video', l: 'Kling v3 Pro — ~$0.28/dtk (best quality)' },
]
export const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — fast multi-ref' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — best text' },
]
