// Centralized Gemini caller with retry + fallback model.
//
// Why this exists: Google's `gemini-2.5-flash` periodically hits capacity
// limits and returns 503 UNAVAILABLE with "currently experiencing high demand".
// Direct callers used to surface that raw string into the UI. This helper:
//   1. Retries 3× with exponential backoff (1s → 2s → 4s) on 429/503
//   2. Falls back to `gemini-2.0-flash` on persistent 503 (older but reliable)
//   3. Normalizes errors so callers get a humane message
//
// All Gemini routes should use this — direct fetch() calls bypass these
// safeguards and will eventually break under traffic spikes.

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
const PRIMARY_MODEL = 'gemini-2.5-flash'
const FALLBACK_MODEL = 'gemini-2.0-flash'
const MAX_RETRIES = 3

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function isTransientError(err) {
  if (!err) return false
  if (TRANSIENT_STATUS.has(err.status)) return true
  const msg = String(err.message || '').toLowerCase()
  return msg.includes('high demand') || msg.includes('unavailable') || msg.includes('overload') || msg.includes('rate limit') || msg.includes('quota')
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
    throw err
  }
  if (!data.candidates?.length) {
    const reason = data.promptFeedback?.blockReason || 'unknown'
    const err = new Error(`Gemini blocked: ${reason}`)
    err.status = 400
    err.body = data
    throw err
  }
  return data.candidates[0].content.parts[0].text || ''
}

// Main entry. Returns the raw text from Gemini.
// opts: { contents, generationConfig, maxRetries }
//   contents = [{ parts: [...] }] (same shape as Google's API)
export async function callGemini({ contents, generationConfig = {}, maxRetries = MAX_RETRIES } = {}) {
  const geminiKey = process.env.GEMINI_KEY
  if (!geminiKey) {
    const e = new Error('GEMINI_KEY belum di-set di Vercel env vars')
    e.status = 500
    throw e
  }
  if (!contents) throw new Error('contents required')

  let lastErr
  // Phase 1: retry primary model
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callOnce(PRIMARY_MODEL, geminiKey, contents, generationConfig)
    } catch (e) {
      lastErr = e
      if (!isTransientError(e)) throw e // non-retryable — surface immediately
      if (attempt < maxRetries - 1) {
        const delayMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        await sleep(delayMs)
      }
    }
  }

  // Phase 2: fallback to older but more available model
  try {
    return await callOnce(FALLBACK_MODEL, geminiKey, contents, generationConfig)
  } catch (e) {
    // Final failure — humanize the message for the UI.
    if (isTransientError(e) || isTransientError(lastErr)) {
      const friendly = new Error('Gemini lagi sibuk — udah retry 3x + fallback model, semuanya gagal. Coba lagi 1-2 menit. Kalau persistent, cek status.cloud.google.com.')
      // Mark as transient so API routes can return HTTP 200 with ok:false
      // instead of 503 — keeps browser console clean (no scary red errors).
      friendly.transient = true
      friendly.status = 503
      friendly.cause = e
      throw friendly
    }
    throw e
  }
}

// JSON-mode convenience wrapper. Adds responseMimeType + parses + strips
// stray markdown fences that Gemini sometimes leaks despite the JSON flag.
export async function callGeminiJSON({ contents, temperature = 0.7, maxOutputTokens = 4096, maxRetries } = {}) {
  const text = await callGemini({
    contents,
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
    maxRetries,
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
