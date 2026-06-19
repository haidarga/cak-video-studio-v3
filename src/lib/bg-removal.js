// Clean-background product reference (Product Anchoring L4).
//
// A product ref shot on a busy table splits the model's attention (~35% to the
// product). Stripping the background concentrates it (~90%), which sharply
// improves shape/label fidelity and cuts drift/morph — i.e. fewer regenerates.
//
// Design: FAIL-SAFE. If bg removal errors (bad model id, fal hiccup, dead URL)
// we return the ORIGINAL url so the gen still runs — product fidelity just
// stays at L2/L3 instead of L4. We never throw, never block a gen.
//
// Cached at module level (per warm serverless instance) keyed by source URL, so
// the same product isn't re-processed on every variant in a batch.

export const BIREFNET_MODEL = 'fal-ai/birefnet'

// birefnet input — isolate the foreground (product), drop the background.
export function buildBgRemovalInput(imageUrl) {
  return { image_url: imageUrl, model: 'General Use (Light)', output_type: 'foreground' }
}

// Pull the result URL across birefnet's response shapes.
export function extractCleanUrl(res) {
  return res?.image?.url || res?.images?.[0]?.url || res?.url || null
}

const _cache = new Map() // sourceUrl -> cleanedUrl (or original on failure)

// falCall: (model, input, key) => Promise<falResponse> — injected so this stays
// testable without a network. Returns a clean-bg URL, or the original on any
// failure. Never throws.
export async function cleanProductBg(imageUrl, falKey, falCall) {
  if (!imageUrl || typeof imageUrl !== 'string') return imageUrl
  if (_cache.has(imageUrl)) return _cache.get(imageUrl)
  let out = imageUrl
  try {
    const res = await falCall(BIREFNET_MODEL, buildBgRemovalInput(imageUrl), falKey)
    out = extractCleanUrl(res) || imageUrl
  } catch {
    out = imageUrl // graceful degrade — gen proceeds with the original ref
  }
  _cache.set(imageUrl, out)
  return out
}

// Test-only: reset the module cache between cases.
export function _resetBgCache() { _cache.clear() }
