// Route cross-origin asset URLs through /api/proxy so they ride past the
// COEP=require-corp header set on /editor.
//
// Why this exists: /editor needs SharedArrayBuffer for ffmpeg.wasm, which
// requires the document to be cross-origin-isolated (COEP=require-corp,
// COOP=same-origin). Side effect: any cross-origin resource the browser
// fetches must have Cross-Origin-Resource-Policy: cross-origin or it gets
// blocked with ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep.
// fal.media and Supabase storage don't send CORP — so we proxy.
//
// Same-origin URLs, blob:, data:, and falsy values pass through unchanged.

export function proxify(url) {
  if (!url || typeof url !== 'string') return url
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  if (url.startsWith('/')) return url // already same-origin
  try {
    const here = typeof window !== 'undefined' ? window.location.href : 'https://x.local'
    const u = new URL(url, here)
    if (typeof window !== 'undefined' && u.origin === window.location.origin) return url
    return `/api/proxy?url=${encodeURIComponent(url)}`
  } catch { return url }
}
