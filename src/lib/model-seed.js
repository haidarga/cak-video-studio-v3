// Which fal models accept a `seed` input — ALLOWLIST, verified against the fal
// OpenAPI schemas (Jun 2026). Sending `seed` to a model that doesn't declare it
// can 422 the whole gen, so this is default-DENY: only emit seed for families
// confirmed to support it.
//
//   ✓ supported : nano-banana-2, seedance-2.0 (i2v/ref2v/t2v), happy-horse (gen)
//   ✗ NOT       : kling-video (all), grok-imagine-* (image+video), gpt-image-2 (+/edit)
//   ? unverified: treated as NOT supported (safe) until confirmed.
export function modelAcceptsSeed(modelId) {
  const m = String(modelId || '').toLowerCase()
  if (!m) return false
  // explicit denies first
  if (m.includes('grok-imagine')) return false
  if (m.includes('kling-video')) return false
  if (m.includes('gpt-image')) return false
  // verified allows
  if (m.includes('nano-banana')) return true
  if (m.includes('seedance-2.0')) return true
  if (m.includes('happy-horse') && !m.includes('video-edit')) return true
  return false // default-deny — unknown model, don't risk a 422
}

// Return a NEW input object with `seed` attached, but ONLY when the model
// supports it and the seed is a finite number. Otherwise returns the input
// unchanged. Call as: applySeed(model, buildImgInput(model, {...}), seed)
export function applySeed(modelId, input, seed) {
  const n = Number(seed)
  if (!Number.isFinite(n)) return input
  if (!modelAcceptsSeed(modelId)) return input
  return { ...input, seed: Math.floor(n) }
}

// Generate a fresh fal-valid seed (0 .. 2_147_483_647).
export function randomSeed() {
  return Math.floor(Math.random() * 2147483647)
}
