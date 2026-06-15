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

// The old r2.dev public host is rate-limited, doesn't reliably send CORS, and
// serves files as octet-stream (→ browser DOWNLOADS instead of plays). Our free
// Cloudflare Worker serves the SAME bucket+keys with ACAO:* + correct
// Content-Type. Rewrite the host on the way out so BOTH already-stored (old DB)
// URLs and freshly-generated ones route through the Worker — no re-generation,
// no dependency on the R2_PUBLIC_URL env having propagated yet.
const OLD_R2_HOST = 'pub-b9676bf1c1f748b4bf99a4bb0f29e3b8.r2.dev'
const WORKER_HOST = 'cak-media.yellowbrio.workers.dev'

export function mediaUrl(url) {
  if (!url || typeof url !== 'string') return url
  return url.replace(OLD_R2_HOST, WORKER_HOST)
}

export function proxify(url) {
  return mediaUrl(url)
}

// Explicit proxy-wrapping for the rare host that doesn't send CORS headers.
// Used by fetchToUint8's retry path — never as a default route.
export function proxyUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('/')) return url
  return `/api/proxy?url=${encodeURIComponent(url)}`
}
