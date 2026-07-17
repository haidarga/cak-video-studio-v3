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

// Seedance's hard bounds — anything outside 422s at RUNTIME (submit itself
// always succeeds, so the failure only surfaces via webhook/dashboard).
export const SEEDANCE_AR_MIN = 0.40
export const SEEDANCE_AR_MAX = 2.50

// Seedance's bound is EXCLUSIVE, not inclusive: padding 2.60 to exactly 2.50
// still 422s ("received image with aspect ratio: 2.50"). It also reports the
// ratio rounded to 2dp, so a value that merely LOOKS like the bound can trip it.
// Aim 1% inside instead of at the edge — on a 2.60 banner that's ~5% extra
// height instead of ~4%, i.e. nothing, and it can never land back on the line.
const AR_MARGIN = 0.99

// Letterbox dims that bring w/h strictly inside (min, max). Null = already safe.
export function padDimsForAspectRange(width, height, min, max) {
  const ratio = width / height
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const safeMax = max * AR_MARGIN
  const safeMin = min / AR_MARGIN
  if (ratio > safeMax) return { width, height: Math.ceil(width / safeMax) }   // too wide -> grow height
  if (ratio < safeMin) return { width: Math.ceil(height * safeMin), height }  // too tall -> grow width
  return null
}

// Pads one ref into range and re-uploads it; returns the new url. Fail-safe:
// any error (CORS taint, load fail, upload fail) keeps the ORIGINAL url so a
// gen never breaks on this. Mirrors degradeRefUrl() in reference-degrader.js.
const _arCache = new Map()
export async function fitRefToAspectRange(url, min, max, uploadBlob) {
  if (!url) return url
  const key = `${min}|${max}|${url}`
  if (_arCache.has(key)) return _arCache.get(key)
  let out = url
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.crossOrigin = 'anonymous'
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const dims = padDimsForAspectRange(img.width, img.height, min, max)
    if (dims) {
      const canvas = document.createElement('canvas')
      canvas.width = dims.width
      canvas.height = dims.height
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, dims.width, dims.height)
      ctx.drawImage(img, Math.floor((dims.width - img.width) / 2), Math.floor((dims.height - img.height) / 2))
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92))
      if (blob) {
        const up = await uploadBlob(blob, 'ref-arfit.jpg', 'ref-arfit')
        if (up?.url) out = up.url
      }
    }
  } catch { out = url }
  _arCache.set(key, out)
  return out
}

// Map fitRefToAspectRange over a ref list, preserving order.
export async function fitRefsToAspectRange(urls, min, max, uploadBlob) {
  return await Promise.all((urls || []).filter(Boolean).map((u) => fitRefToAspectRange(u, min, max, uploadBlob)))
}
