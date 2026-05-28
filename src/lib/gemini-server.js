// Centralized Gemini caller with retry + multi-model fallback chain.
//
// Pro tier user STILL hit 503 because Google's 2.5-flash + 2.0-flash sometimes
// experience joint capacity issues during Asia peak hours (4-8 PM WIB). We
// fan out to 4 models in cascade, picking each on transient failure:
//
//   1. gemini-2.5-flash       — primary, fastest, cheapest
//   2. gemini-2.0-flash       — older but mostly available
//   3. gemini-2.5-pro         — Pro-tier only; way lower traffic since it's
//                                priced higher (~$1.25/1M in)
//   4. gemini-1.5-flash       — legacy, low traffic, very stable
//
// Each model gets 2 attempts with exponential backoff (1s → 3s). Total worst
// case: 4 models × 2 attempts ≈ 4 × (call + 3s wait) ≈ 30-40 seconds.
//
// If ALL 4 models hit 503, then Google has a real outage and we surface a
// humane error with the suggestion to check Google Cloud Status.

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
  'gemini-1.5-flash',
]
const ATTEMPTS_PER_MODEL = 2
const BACKOFF_MS = [1000, 3000] // per-attempt-within-model delay

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function isTransientError(err) {
  if (!err) return false
  if (TRANSIENT_STATUS.has(err.status)) return true
  const msg = String(err.message || '').toLowerCase()
  return msg.includes('high demand') || msg.includes('unavailable') || msg.includes('overload') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('exhausted')
}

async function callOnce(model, geminiKey, contents, generationConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    const err = new Error(data?.error?.message || `Gemini HTTP ${res.status}`)
    err.status = res.status
    err.body = data
    err.model = model
    throw err
  }
  if (!data.candidates?.length) {
    const reason = data.promptFeedback?.blockReason || 'unknown'
    const err = new Error(`Gemini blocked: ${reason}`)
    err.status = 400
    err.body = data
    err.model = model
    throw err
  }
  return data.candidates[0].content.parts[0].text || ''
}

// Try one model with N retries. Returns text on success, throws lastErr on full failure.
async function tryModel(model, geminiKey, contents, generationConfig) {
  let lastErr
  for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
    try {
      return await callOnce(model, geminiKey, contents, generationConfig)
    } catch (e) {
      lastErr = e
      // Non-transient (e.g. 400 bad prompt, content blocked) — bail immediately.
      // No point retrying the same model OR cascading to next.
      if (!isTransientError(e)) throw e
      if (attempt < ATTEMPTS_PER_MODEL - 1) await sleep(BACKOFF_MS[attempt] || 3000)
    }
  }
  throw lastErr
}

// Main entry — cascades through MODEL_CASCADE on transient failures.
// opts: { contents, generationConfig, modelOverride }
//   modelOverride: optional single model to use (skip cascade)
export async function callGemini({ contents, generationConfig = {}, modelOverride } = {}) {
  const geminiKey = process.env.GEMINI_KEY
  if (!geminiKey) {
    const e = new Error('GEMINI_KEY belum di-set di Vercel env vars')
    e.status = 500
    throw e
  }
  if (!contents) throw new Error('contents required')

  const models = modelOverride ? [modelOverride] : MODEL_CASCADE
  let lastErr
  const triedModels = []
  for (const model of models) {
    try {
      const result = await tryModel(model, geminiKey, contents, generationConfig)
      // Log which fallback was needed (helps diagnose Gemini outages over time)
      if (triedModels.length > 0) {
        console.warn(`[gemini] fallback succeeded on ${model} after: ${triedModels.join(', ')}`)
      }
      return result
    } catch (e) {
      lastErr = e
      triedModels.push(model)
      // Non-transient — surface immediately, don't waste calls on other models.
      if (!isTransientError(e)) throw e
    }
  }

  // All models exhausted — surface humane error.
  const friendly = new Error(
    `Gemini lagi outage beneran — udah coba ${triedModels.length} model (${triedModels.join(' → ')}) semua 503. Cek status.cloud.google.com. Kalau Google OK tapi error masih persistent, mungkin quota project lu (cek aistudio.google.com).`
  )
  friendly.transient = true
  friendly.status = 503
  friendly.cause = lastErr
  friendly.triedModels = triedModels
  throw friendly
}

// JSON-mode convenience wrapper. Adds responseMimeType + parses + strips
// stray markdown fences that Gemini sometimes leaks despite the JSON flag.
export async function callGeminiJSON({ contents, temperature = 0.7, maxOutputTokens = 4096, modelOverride } = {}) {
  const text = await callGemini({
    contents,
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
    modelOverride,
  })
  let clean = text.replace(/```json|```/g, '').trim()
  const first = clean.indexOf('{')
  const last = clean.lastIndexOf('}')
  if (first >= 0 && last > first) clean = clean.slice(first, last + 1)
  try {
    return JSON.parse(clean)
  } catch (e) {
    const err = new Error(`Gemini balik bukan JSON valid: ${clean.slice(0, 200)}`)
    err.status = 502
    throw err
  }
}
