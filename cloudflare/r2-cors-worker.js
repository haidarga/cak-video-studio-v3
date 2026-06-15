// Cloudflare Worker — serves the R2 bucket with proper CORS headers + HTTP
// range support, on the FREE *.workers.dev subdomain. Replaces the r2.dev
// public URL (which doesn't reliably send CORS + is rate-limited).
//
// Why this exists: the browser editor/render fetches video bytes with
// crossOrigin='anonymous'. r2.dev wasn't returning Access-Control-Allow-Origin,
// so loads failed (black preview) AND the render path fell back to the Vercel
// proxy → egress → account pause. This Worker reads R2 via a binding (zero
// egress) and returns the bytes with ACAO:* so CORS just works.
//
// ── SETUP (Cloudflare dashboard, all free) ──────────────────────────────
// 1. Workers & Pages → Create → Worker → name it e.g. "cak-media". Deploy.
// 2. Worker → Settings → Bindings → Add → R2 bucket binding:
//      Variable name: BUCKET   |   Bucket: cak-video-refs
// 3. Worker → Edit code → paste THIS file → Deploy.
// 4. Your free URL is shown: https://cak-media.<your-subdomain>.workers.dev
// 5. In Vercel env, set:  R2_PUBLIC_URL = https://cak-media.<your-subdomain>.workers.dev
//    (no trailing slash) → redeploy. Done. CORS fixed, $0, no domain bought.

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Accept-Ranges',
      'Access-Control-Max-Age': '86400',
    }

    // CORS preflight
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: cors })
    }

    // The object key is the URL path (e.g. /qc/5b07c93e....mp4 → "qc/5b07c93e....mp4")
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1))
    if (!key) return new Response('Missing object key', { status: 400, headers: cors })

    // Range support — videos seek via HTTP range requests; without it, scrubbing
    // and some browsers' playback break.
    const rangeHeader = request.headers.get('range')
    const opts = {}
    let status = 200
    if (rangeHeader) {
      const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
      if (m) {
        const offset = Number(m[1])
        const end = m[2] ? Number(m[2]) : undefined
        opts.range = end !== undefined ? { offset, length: end - offset + 1 } : { offset }
        status = 206
      }
    }

    const object = await env.BUCKET.get(key, opts)
    if (!object) return new Response('Not found', { status: 404, headers: cors })

    const headers = new Headers(cors)
    object.writeHttpMetadata(headers) // content-type, etc. from the stored object
    headers.set('ETag', object.httpEtag)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')

    if (status === 206 && object.range) {
      const size = object.size // full object size
      const start = object.range.offset || 0
      const len = object.range.length ?? (size - start)
      headers.set('Content-Range', `bytes ${start}-${start + len - 1}/${size}`)
      headers.set('Content-Length', String(len))
    }

    return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
  },
}
