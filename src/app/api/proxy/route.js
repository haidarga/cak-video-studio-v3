// COEP-safe proxy for cross-origin assets fetched by the editor render
// pipeline (ffmpeg.wasm).
//
// Background: /editor sets COEP=require-corp so SharedArrayBuffer is available
// for ffmpeg.wasm. That makes the document cross-origin-isolated, which means
// ANY cross-origin fetch must come back with a Cross-Origin-Resource-Policy
// header (or be an opaque no-cors fetch, which fetch-to-arraybuffer can't use).
// fal.media + Supabase storage etc. don't set CORP, so the browser blocks the
// fetch with ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep.
//
// This route fetches the upstream URL server-side and re-streams it with the
// headers the editor needs. From the browser's perspective it's a same-origin
// fetch, so COEP is happy.
//
// Usage: /api/proxy?url=<encoded absolute https url>
// Allowlist hosts to prevent SSRF abuse.

const ALLOWED_HOSTS = new Set([
  'v3b.fal.media',
  'v3.fal.media',
  'fal.media',
  'storage.googleapis.com',  // fal sometimes redirects here
  // Supabase storage host derived from env at request time below.
])

function isAllowedHost(host) {
  if (ALLOWED_HOSTS.has(host)) return true
  if (host.endsWith('.fal.media')) return true
  if (host.endsWith('.supabase.co')) return true   // any project's storage subdomain
  if (host.endsWith('.supabase.in')) return true
  return false
}

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const target = searchParams.get('url')
  if (!target) return new Response('url required', { status: 400 })

  let upstream
  try { upstream = new URL(target) } catch { return new Response('invalid url', { status: 400 }) }
  if (upstream.protocol !== 'https:') return new Response('https only', { status: 400 })
  if (!isAllowedHost(upstream.hostname)) {
    return new Response(`host not allowed: ${upstream.hostname}`, { status: 403 })
  }

  // Forward Range so the browser's video element can seek through the proxied
  // stream. Without this seeking a large mp4 would re-download from the start.
  const fwdHeaders = {}
  const range = req.headers.get('range')
  if (range) fwdHeaders['range'] = range

  let res
  try {
    res = await fetch(upstream.toString(), { headers: fwdHeaders, cache: 'no-store' })
  } catch (e) {
    return new Response('upstream fetch failed: ' + (e?.message || e), { status: 502 })
  }

  // Re-stream the body with COEP-friendly headers.
  const headers = new Headers()
  const contentType = res.headers.get('content-type'); if (contentType) headers.set('content-type', contentType)
  const contentLength = res.headers.get('content-length'); if (contentLength) headers.set('content-length', contentLength)
  const contentRange = res.headers.get('content-range'); if (contentRange) headers.set('content-range', contentRange)
  const acceptRanges = res.headers.get('accept-ranges'); if (acceptRanges) headers.set('accept-ranges', acceptRanges)
  // The headers that make this work under COEP:
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges')
  // Cache aggressively — these are immutable asset URLs (fal returns content-hash URLs).
  headers.set('Cache-Control', 'public, max-age=86400, immutable')

  return new Response(res.body, { status: res.status, headers })
}

// HEAD support so <video preload="metadata"> works.
export async function HEAD(req) {
  const { searchParams } = new URL(req.url)
  const target = searchParams.get('url')
  if (!target) return new Response(null, { status: 400 })
  let upstream
  try { upstream = new URL(target) } catch { return new Response(null, { status: 400 }) }
  if (upstream.protocol !== 'https:') return new Response(null, { status: 400 })
  if (!isAllowedHost(upstream.hostname)) return new Response(null, { status: 403 })
  const res = await fetch(upstream.toString(), { method: 'HEAD', cache: 'no-store' })
  const headers = new Headers()
  const contentType = res.headers.get('content-type'); if (contentType) headers.set('content-type', contentType)
  const contentLength = res.headers.get('content-length'); if (contentLength) headers.set('content-length', contentLength)
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(null, { status: res.status, headers })
}
