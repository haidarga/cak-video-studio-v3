// Reference degradation (Realism Law #2: "reference dominates prompt").
//
// The model anchors OUTPUT quality to the REFERENCE quality — so a clean/HD
// persona ref makes "cheap Samsung A13" tokens lose. This is THE fix for
// "looks too perfect on a lo-fi preset". Especially effective with pixel-locking
// edit models (GPT Image 2 Edit): degrade the ref → the output inherits the
// grain/compression directly.
//
// degradeLevelForPreset + DEGRADE_SETTINGS are pure (tested). The Canvas
// degrade + fetch/upload run client-side only and are fail-safe (any error →
// original url, gen never breaks).

export const DEGRADE_SETTINGS = {
  light:  { maxDim: 1280, jpegQuality: 0.75, grain: 10 },
  medium: { maxDim: 720,  jpegQuality: 0.60, grain: 25 },
  heavy:  { maxDim: 480,  jpegQuality: 0.45, grain: 40 },
}

// Which degrade level a camera preset wants. null = don't degrade.
const AUTO_DEGRADE_MAP = {
  samsung_a13_candid: 'heavy',     // cheapest phone look → most degradation
  documentary_handheld: 'medium',  // organic but not cheap
  iphone_15_clean: 'light',        // clean, just shave the studio sheen
}
export function degradeLevelForPreset(presetId) {
  return AUTO_DEGRADE_MAP[presetId] || null // cinema/animation/unknown → no degrade
}

const _cache = new Map() // `${level}|${url}` -> degraded url (or original on failure)
export function _resetDegradeCache() { _cache.clear() }

// Degrade an <img>-loadable source to a lo-fi JPEG blob (BROWSER only).
async function degradeToBlob(srcUrl, settings) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = reject
    el.src = srcUrl
  })
  const scale = Math.min(settings.maxDim / img.width, settings.maxDim / img.height, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(img.width * scale))
  canvas.height = Math.max(1, Math.floor(img.height * scale))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  if (settings.grain > 0) {
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = id.data
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * settings.grain
      d[i] = Math.min(255, Math.max(0, d[i] + n))
      d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n))
      d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n))
    }
    ctx.putImageData(id, 0, 0)
  }
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', settings.jpegQuality))
}

// Degrade a ref URL for the given preset, upload the result, return the new URL.
// uploadBlob: (blob, name, folder) => Promise<{url}>. Fail-safe + cached.
export async function degradeRefUrl(url, presetId, uploadBlob) {
  const level = degradeLevelForPreset(presetId)
  if (!url || !level) return url
  const key = `${level}|${url}`
  if (_cache.has(key)) return _cache.get(key)
  let out = url
  try {
    const blob = await degradeToBlob(url, DEGRADE_SETTINGS[level])
    if (blob) {
      const up = await uploadBlob(blob, `ref-degraded-${level}.jpg`, 'ref-degraded')
      if (up?.url) out = up.url
    }
  } catch { out = url } // graceful — keep the original ref, gen proceeds
  _cache.set(key, out)
  return out
}
