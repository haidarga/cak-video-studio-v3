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

// Build the 3×3 storyboard grid prompt from structured panels.
// Output asks the image model to render ONE storyboard sheet (header + 3x3
// grid of cells, each cell with scene num, time range, photo, and text
// blocks: Visual / Dialog / Keterangan), mirroring v2's PipelineTab logic.
//
// constraints = { skipDialog, skipOnscreen, skipProduct } — gate optional text
// rows so the grid matches user's stated intent (no dialog/text overlay/product).
export function buildStoryboardGridPrompt(panels = [], ar = '9:16', concept = '', constraints = {}) {
  const nine = panels.slice(0, 9)
  let t = 0
  const cells = nine.map((p) => {
    const dur = Math.max(1, parseInt(p.seconds) || 2)
    const range = `${t}-${t + dur} detik`
    t += dur
    const lines = [`Scene ${p.n} (${range}) — ${(p.title || '').trim()}`]
    lines.push(`   Visual: ${(p.visual || p.scene || '').trim()}`)
    if (!constraints.skipDialog && p.dialog) lines.push(`   Dialog/VO: "${p.dialog.trim()}"`)
    if (!constraints.skipOnscreen) lines.push(`   Keterangan: ${(p.purpose || p.onscreen || '').trim()}`)
    return lines.join('\n')
  }).join('\n')
  const header = (concept || 'STORYBOARD 3x3').trim().toUpperCase()
  const productRule = constraints.skipProduct
    ? 'NO product, NO brand packaging, NO logos anywhere in any cell. People only, lifestyle moments.'
    : 'the SAME character(s) and product packaging CONSISTENT across all relevant cells.'
  const labelList = constraints.skipDialog && constraints.skipOnscreen
    ? '(Visual only)'
    : constraints.skipDialog
      ? '(Visual / Keterangan)'
      : constraints.skipOnscreen
        ? '(Visual / Dialog/VO)'
        : '(Visual / Dialog/VO / Keterangan)'
  return `Design ONE professional STORYBOARD SHEET image — an ad-agency shot-breakdown TABLE — clean white background, ${ar} canvas.
LAYOUT: header bar with the title "${header}". Below, a 3x3 GRID of 9 equal cells in 3 rows x 3 columns, thin grey table lines. Each cell top-to-bottom: scene number in a circle badge + time range in bold; a photographic still; a small white block with labeled lines ${labelList}.
HARD RULES: ${productRule} Cohesive lighting & color grade. Crisp, correctly-spelled, legible Indonesian text. No watermark.
THE 9 CELLS, in order (left to right, top to bottom):
${cells}`
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
  { v: 'fal-ai/kling-video/v3/pro/image-to-video', l: 'Kling v3 Pro — ~$0.28/dtk (best quality)' },
]
export const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — fast multi-ref' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — best text' },
]
