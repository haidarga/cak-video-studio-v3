// Browser-side fal helper that proxies through /api/fal/*. The FAL_KEY stays
// on the server. submitRun returns once the fal job is COMPLETED (or throws).

export async function falRun(model, input, { onProgress, maxWaitMs = 600000 } = {}) {
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
  const resultRes = await fetch(`/api/fal/result?model=${encodeURIComponent(model)}&request_id=${requestId}`, { cache: 'no-store' })
  const r = await resultRes.json()
  if (!r.ok) throw new Error(r.error || 'result fetch failed')
  return r
}

// ── Image input builder, ported from v2's src/lib/api.js ──
export function buildImgInput(imgModel, { prompt, refUrls = [], ar = '9:16' }) {
  const refs = refUrls.filter(Boolean)
  if (imgModel.includes('nano-banana')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 12) } : {}), num_images: 1, output_format: 'png', aspect_ratio: ar }
  }
  const image_size = ar === '9:16' ? { width: 1024, height: 1536 } : ar === '16:9' ? { width: 1536, height: 1024 } : { width: 1024, height: 1024 }
  if (imgModel.includes('gpt-image-2/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 10) } : {}), image_size, quality: 'medium', num_images: 1 }
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
  return { prompt, image_url, duration: parseInt(duration) || 5, aspect_ratio }
}

export function productDirective(notes) {
  const n = (notes || '').trim()
  if (!n) return ''
  return ' PRODUCT FIDELITY (critical): reproduce the product packaging EXACTLY as in the reference image — correct shape and proportions, product upright with its front label facing the camera, and ALL label text sharp, legible and correctly spelled. Strictly respect this product knowledge: ' + n
}

export const IMG_QUALITY = 'Professional high-detail photography, sharp focus, natural realistic skin texture, anatomically correct hands and proportions, accurate product packaging with a clean legible logo and label, well-balanced composition.'
export const VID_STABILITY = 'Keep the character identity, face, wardrobe and product appearance consistent and stable throughout; smooth, natural, continuous motion with steady framing.'

export const VIDEO_MODELS = [
  { v: 'fal-ai/kling-video/v3/standard/image-to-video', l: 'Kling v3 — ~$0.08/dtk 💰' },
  { v: 'fal-ai/kling-video/o3/standard/image-to-video', l: 'Kling O3 — ~$0.11/dtk (audio)' },
  { v: 'alibaba/happy-horse/image-to-video', l: 'Happy Horse 1.0 — ~$0.14/dtk' },
  { v: 'bytedance/seedance-2.0/fast/image-to-video', l: 'Seedance 2 Fast — ~$0.24/dtk' },
]
export const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — fast multi-ref' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — best text' },
]
