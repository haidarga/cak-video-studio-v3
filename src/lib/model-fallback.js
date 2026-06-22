// Self-healing model fallback. Some models refuse content that others accept:
//   - OpenAI gpt-image-2: aggressive moderation, false-positives on innocent
//     selfies/real people.
//   - Google Veo: a HARD guardrail on REAL-PERSON likeness — refuses real face
//     refs with `no_media_generated` ("unsafe content") even at safety_tolerance 6.
// When a gen fails with a content REFUSAL (not a transient/real error), retry
// with the next more-permissive / more-appropriate model instead of dead-ending.

// fal surfaces refusals in a few shapes: a `no_media_generated` error type, the
// `partner_validation_failed` reason (OpenAI), or generic policy/moderation text.
const REFUSAL_RE = /no_media_generated|partner_validation_failed|content[_\s]?policy|moderation|\bnsfw\b|inappropriate|unsafe content|flagged|content checker|blocked/i

export function isContentRefusal(err) {
  return REFUSAL_RE.test(String(err?.message ?? err ?? ''))
}

// Image models ranked most → least permissive (fallback tries permissive first).
// gpt-image-2 (OpenAI) is the strictest, so it's never a fallback TARGET.
const IMAGE_FALLBACK_ORDER = [
  'xai/grok-imagine-image/edit', // xAI — most permissive
  'fal-ai/nano-banana-2/edit',   // Google — moderate
]
export function nextImageModel(current, tried = []) {
  const seen = new Set([current, ...(tried || [])])
  return IMAGE_FALLBACK_ORDER.find((m) => !seen.has(m)) || null
}

// Video: Veo refuses real people. Fall back to real-person-friendly families
// (Seedance/Kling), preserving the variant (ref-to-video / image / text).
const VIDEO_FALLBACK = {
  r2v: ['bytedance/seedance-2.0/fast/reference-to-video', 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video'],
  i2v: ['bytedance/seedance-2.0/fast/image-to-video', 'fal-ai/kling-video/v3/standard/image-to-video'],
  t2v: ['bytedance/seedance-2.0/text-to-video', 'fal-ai/kling-video/v3/standard/text-to-video'],
}
export function videoVariant(model) {
  const m = String(model || '')
  if (/reference-to-video|ref-to-video/.test(m)) return 'r2v'
  if (/text-to-video/.test(m)) return 't2v'
  return 'i2v'
}
export function nextVideoModel(current, tried = []) {
  const order = VIDEO_FALLBACK[videoVariant(current)] || VIDEO_FALLBACK.i2v
  const seen = new Set([current, ...(tried || [])])
  return order.find((m) => !seen.has(m)) || null
}
