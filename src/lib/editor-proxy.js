// proxify() — now a PASSTHROUGH. Media streams DIRECT from its host.
//
// History: /editor used to set COEP=require-corp (SharedArrayBuffer for
// multi-threaded ffmpeg.wasm), which forced every cross-origin asset
// through /api/proxy. COEP was removed (ffmpeg runs single-threaded now)
// but proxify kept routing ALL editor media through the Vercel function
// "as a defensive net" — and that net cost real money: every video
// preview/render streamed its full bytes through Vercel = 63GB of Fast
// Origin Transfer against the 10GB Hobby cap → ACCOUNT PAUSED.
//
// Current reality: fal.media sends Access-Control-Allow-Origin: * and the
// R2 bucket has CORS rules, so direct fetch + crossOrigin='anonymous'
// canvas access both work without any proxy. R2 egress is free; Vercel
// origin transfer is not.
//
// The defensive net lives on ONLY in fetchToUint8 (editor-render.js):
// direct fetch first, /api/proxy retry on CORS failure. Media elements
// (<video>/<img>/<audio>) get the raw URL — playback never needed CORS,
// and canvas capture works because the hosts send ACAO.

export function proxify(url) {
  return url
}

// Explicit proxy-wrapping for the rare host that doesn't send CORS headers.
// Used by fetchToUint8's retry path — never as a default route.
export function proxyUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('/')) return url
  return `/api/proxy?url=${encodeURIComponent(url)}`
}
