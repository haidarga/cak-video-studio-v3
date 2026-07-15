// Pre-flight aspect-ratio validation for reference images sent to models with
// a hard AR constraint (e.g. Seedance reference-to-video rejects anything
// outside 0.40-2.50 with a 422 AFTER submission — a wasted gen + a cryptic
// error the user can only see by digging into the fal.ai dashboard). This
// catches it client-side, before the API call, with a message naming the
// actual offending image.

// Pure bounds check — split out from the browser Image() loader below so it's
// unit-testable without a DOM.
export function isAspectRatioOutOfBounds(ratio, min, max) {
  if (ratio == null || !Number.isFinite(ratio)) return false
  return ratio < min || ratio > max
}

// Loads an image in the browser just to read its natural dimensions (no pixel
// access, so no CORS requirement). Resolves null on any load failure — the
// caller should fail OPEN (skip validation) rather than block a gen on a
// network hiccup unrelated to the actual aspect-ratio constraint.
export function probeImageAspectRatio(url) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || !url) { resolve(null); return }
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Probes every url in parallel, returns only the ones outside [min, max] as
// { url, ratio }. Urls that fail to load are silently skipped (fail open).
export async function findOutOfBoundsRefs(urls, min, max) {
  const list = (urls || []).filter(Boolean)
  const results = await Promise.all(list.map(async (url) => ({ url, ratio: await probeImageAspectRatio(url) })))
  return results.filter((r) => isAspectRatioOutOfBounds(r.ratio, min, max))
}
