// fal.ai + Gemini API layer (ported from legacy single-file app)
let _falKey = ''
let _geminiKey = ''

export function setApiKeys(falKey, geminiKey) {
  _falKey = falKey || ''
  _geminiKey = geminiKey || ''
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── fal.ai queue run ────────────────────────────────────────
export async function falRun(modelId, input, onLog) {
  if (!_falKey) throw new Error('fal.ai API key belum di-set. Buka ⚙️ Settings.')
  const base = 'https://queue.fal.run'
  const sub = await fetch(`${base}/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Key ${_falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!sub.ok) {
    let e
    try { e = await sub.json() } catch { e = {} }
    throw new Error(e.detail || `Submit failed (${sub.status})`)
  }
  const subData = await sub.json()
  const requestId = subData.request_id
  // fal returns the exact polling URLs — use them (model IDs have varying path depth,
  // so constructing the status URL by hand breaks on multi-segment models).
  const statusUrl = subData.status_url || `${base}/${modelId}/requests/${requestId}/status`
  const responseUrl = subData.response_url || `${base}/${modelId}/requests/${requestId}`
  onLog && onLog(`Queued: ${String(requestId).slice(0, 12)}...`)

  let attempt = 0
  while (true) {
    await sleep(attempt < 3 ? 3000 : 5000)
    attempt++
    const st = await fetch(statusUrl + (statusUrl.includes('?') ? '&' : '?') + 'logs=1', {
      headers: { Authorization: `Key ${_falKey}` },
    })
    if (!st.ok) {
      const body = await st.text().catch(() => '')
      throw new Error(`Status poll failed (${st.status}) ${body.slice(0, 120)}`)
    }
    const status = await st.json()
    if (status.logs) status.logs.forEach((l) => onLog && onLog(l.message))
    if (status.status === 'COMPLETED') break
    if (status.status === 'FAILED') throw new Error(status.error || 'Generation failed')
    onLog && onLog(`${status.status}... (${attempt * 3}s)`)
  }
  const res = await fetch(responseUrl, { headers: { Authorization: `Key ${_falKey}` } })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`fal response ${res.status}: ${txt.slice(0, 240)}`)
  }
  const data = await res.json()
  // fal sometimes returns 200 with an error envelope — surface it instead of silently passing
  if (data && !data.video && !data.images && (data.error || data.detail || data.message)) {
    const e = data.error
    const msg = (e && (e.message || e)) || data.detail || data.message
    throw new Error('fal: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 240))
  }
  return data
}

// ── fal.ai storage upload (2-step presigned) ────────────────
export async function falUpload(fileOrBlob, filename = 'image.jpg') {
  if (!_falKey) throw new Error('fal.ai API key belum di-set')
  const contentType = fileOrBlob.type || 'application/octet-stream'
  const initRes = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { Authorization: `Key ${_falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: filename }),
  })
  if (!initRes.ok) {
    const err = await initRes.text().catch(() => '')
    throw new Error(`Upload init failed (${initRes.status}): ${err.slice(0, 200)}`)
  }
  const { upload_url, file_url } = await initRes.json()
  const putRes = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: fileOrBlob,
  })
  if (!putRes.ok) throw new Error(`Upload PUT failed (${putRes.status})`)
  return file_url
}

// Quality boosters appended to every prompt so first-gen looks good and we re-roll less.
// Positive-only phrasing (image models like gpt-image render negative words literally).
const IMG_QUALITY = 'Professional high-detail photography, sharp focus, natural realistic skin texture, anatomically correct hands and proportions, accurate product packaging with a clean legible logo and label, well-balanced composition.'
const VID_STABILITY = 'Keep the character identity, face, wardrobe and product appearance consistent and stable throughout; smooth, natural, continuous motion with steady framing.'

// ── per-model video input builder ───────────────────────────
// opts: { prompt, image_url, reference_urls[], duration, aspect_ratio, resolution }
// reference-to-video models take reference_urls -> image_urls[]; i2v models take one image_url.
export function buildVidInput(vidModel, opts) {
  const { prompt: rawPrompt, image_url, reference_urls, duration, aspect_ratio, resolution } = opts
  const prompt = rawPrompt ? `${rawPrompt} ${VID_STABILITY}` : rawPrompt
  const isRef = vidModel.includes('reference-to-video')
  const srcField = isRef
    ? { image_urls: (reference_urls || []).filter(Boolean).slice(0, 9) }
    : { image_url }

  if (vidModel.includes('seedance')) {
    const okAR = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
    const d = parseInt(duration)
    return {
      prompt,
      ...srcField,
      duration: d ? String(Math.max(4, Math.min(15, d))) : 'auto',
      resolution: resolution || '720p',
      aspect_ratio: okAR.includes(aspect_ratio) ? aspect_ratio : 'auto',
    }
  }
  if (vidModel.includes('happy-horse')) {
    return { prompt, ...srcField, duration: parseInt(duration) || 5, aspect_ratio, resolution: resolution || '720p' }
  }
  // Kling (v3 / o3) — image-to-video AND reference-to-video
  if (vidModel.includes('kling-video')) {
    const isO3 = vidModel.includes('/o3/')
    const dur = Math.max(5, Math.min(15, parseInt(duration) || 5))
    if (isRef) {
      // O3 reference-to-video — one element per character (frontal_image_url) + @ElementN tags in prompt
      const refs = (reference_urls || []).filter(Boolean).slice(0, 4)
      const elements = refs.map((u) => ({ frontal_image_url: u }))
      const tags = elements.map((_, i) => `@Element${i + 1}`).join(' and ')
      return {
        prompt: tags ? `${tags}. ${prompt}` : prompt,
        ...(elements.length ? { elements } : {}),
        duration: dur, aspect_ratio, generate_audio: true,
      }
    }
    // image-to-video: start frame + optional top-level reference_image_urls
    const out = { prompt, image_url, duration: dur, aspect_ratio }
    if (reference_urls && reference_urls.length) out.reference_image_urls = reference_urls.slice(0, 4)
    if (isO3) out.generate_audio = true   // O3 documents audio; v3 stays minimal (silently rejected it before)
    return out
  }
  return { prompt, image_url, duration: parseInt(duration) || 5, aspect_ratio }
}

// ── per-model image input builder ───────────────────────────
// opts: { prompt, refUrls[], ar }
// nano-banana + gpt-image-2/edit take image_urls[] (multi-ref); plain gpt-image-2 is text-to-image.
export function buildImgInput(imgModel, { prompt: rawPrompt, refUrls = [], ar = '9:16' }) {
  const prompt = `${rawPrompt} ${IMG_QUALITY}`
  const refs = refUrls.filter(Boolean)
  if (imgModel.includes('nano-banana')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 12) } : {}), num_images: 1, output_format: 'png', aspect_ratio: ar }
  }
  // gpt-image-2 wants image_size as an object {width,height} (NOT the "1024x1536" string)
  const image_size = ar === '9:16' ? { width: 1024, height: 1536 } : ar === '16:9' ? { width: 1536, height: 1024 } : { width: 1024, height: 1024 }
  if (imgModel.includes('gpt-image-2/edit')) {
    return { prompt, ...(refs.length ? { image_urls: refs.slice(0, 10) } : {}), image_size, quality: 'medium', num_images: 1 }
  }
  return { prompt, ...(refs.length ? { image_url: refs[0] } : {}), image_size, quality: 'medium' }
}

// ── Gemini ──────────────────────────────────────────────────
export async function callGemini(prompt, opts = {}) {
  if (!_geminiKey) throw new Error('Gemini API key belum di-set. Buka ⚙️ Settings.')
  const genConfig = { temperature: 0.7, maxOutputTokens: opts.maxTokens || 8192 }
  if (opts.json) genConfig.responseMimeType = 'application/json'
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig })
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${_geminiKey}`
  const TRANSIENT = /high demand|overload|unavailable|try again|temporarily|rate/i

  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) {
      opts.onLog && opts.onLog(`⏳ Gemini lagi rame — retry ${attempt}/3...`)
      await sleep(1800 * attempt)
    }
    let res
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    } catch (e) { lastErr = e; continue }
    // transient server-side errors → retry
    if (res.status === 503 || res.status === 429 || res.status === 500) {
      lastErr = new Error(`Gemini ${res.status} (lagi rame)`)
      continue
    }
    const data = await res.json()
    if (data.error) {
      if (TRANSIENT.test(data.error.message || '')) { lastErr = new Error(data.error.message); continue }
      throw new Error(data.error.message)
    }
    if (!data.candidates?.length) throw new Error('Gemini returned no candidates (possibly safety-blocked)')
    return data.candidates[0].content.parts[0].text
  }
  throw new Error('Gemini lagi rame banget (high demand) — udah di-retry 4x. Coba lagi bentar ya, biasanya cuma sebentar.')
}

export function extractJSON(raw) {
  if (!raw) throw new Error('Empty response')
  let s = raw.replace(/```json|```/g, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) s = s.slice(first, last + 1)
  try { return JSON.parse(s) } catch { /* fall through to repair */ }
  // best-effort repair for truncated/cut-off model output: close open string + balance brackets
  let t = s.slice(s.indexOf('{'))
  const stack = []
  let inStr = false, esc = false
  for (const ch of t) {
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inStr) t += '"'
  t = t.replace(/,\s*$/, '')                          // drop dangling comma
  while (stack.length) t += stack.pop() === '{' ? '}' : ']'
  return JSON.parse(t)
}

export async function withRetry(fn, tries = 2, delayMs = 2000) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { lastErr = e; if (i < tries - 1) await sleep(delayMs) }
  }
  throw lastErr
}

export function downloadFile(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.target = '_blank'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
