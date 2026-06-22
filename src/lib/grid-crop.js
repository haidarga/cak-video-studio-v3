// Fast continuity anchor for storyboard Continue / Long-form.
//
// Extracting the last frame from the gen'd VIDEO is slow: fal's mp4 often has
// no faststart, so the browser downloads the WHOLE file just to read metadata,
// then ffmpeg.wasm (30MB) decodes the full stream for one frame — tens of
// seconds, repeated per segment.
//
// The akalan: a storyboard's LAST PANEL already IS the planned ending frame.
// Crop that cell straight out of the approved grid IMAGE — no video download,
// no decode, no wasm. Instant. The crop matches the same layout fal-client's
// gridDims() builds, so the cell lands exactly on the last still.

import { mediaUrl } from './editor-proxy'

// Mirror of fal-client gridDims layout (4→2x2, 6→2x3, 9→3x3). Kept local to
// avoid pulling the heavy fal-client module into this client util; a test pins
// it to the same values.
export function gridLayout(count) {
  const n = Math.max(1, Math.min(9, count | 0))
  const cols = n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  return { count: n, rows, cols }
}

// Pixel rectangle of cell `cellIndex` (0-based, left→right, top→bottom) inside a
// grid image of `imgW`×`imgH`. cellIndex is clamped to [0, count-1].
export function cellRect(count, cellIndex, imgW, imgH) {
  const { rows, cols } = gridLayout(count)
  const idx = Math.max(0, Math.min(count - 1, cellIndex | 0))
  const w = imgW / cols
  const h = imgH / rows
  const c = idx % cols
  const r = Math.floor(idx / cols)
  return { x: Math.round(c * w), y: Math.round(r * h), w: Math.round(w), h: Math.round(h) }
}

// Crop the LAST cell of the grid image → JPEG Blob. Browser-only (canvas).
export async function cropLastGridCell(gridUrl, count) {
  if (typeof document === 'undefined') throw new Error('grid crop requires browser env')
  const img = await new Promise((resolve, reject) => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('grid image load failed'))
    im.src = mediaUrl(gridUrl)
  })
  const W = img.naturalWidth, H = img.naturalHeight
  if (!W || !H) throw new Error('grid image dimensions zero')
  const { x, y, w, h } = cellRect(count, count - 1, W, H)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h)
  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b && b.size > 100 ? resolve(b) : reject(new Error('crop produced empty blob'))), 'image/jpeg', 0.92)
  })
}
