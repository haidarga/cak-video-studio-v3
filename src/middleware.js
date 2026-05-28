import { NextResponse } from 'next/server'
import { rateLimitCheck, clientKey } from '@/lib/rate-limit'

// Rate-limit /api/* routes. 60 req/min default. Auth check happens in route
// handler; rate limit is BEFORE auth so unauth requests also count (prevent
// brute force).

export const config = {
  matcher: ['/api/:path*'],
}

// Per-route limits (kalau perlu tighter buat expensive endpoints)
const ROUTE_LIMITS = {
  '/api/fal/submit': 30,        // expensive — cap lower
  '/api/transcribe': 20,
  '/api/draft/caption': 60,
  '/api/postiz/post': 30,
}

export function middleware(req) {
  const path = req.nextUrl.pathname
  // Skip rate limit for static asset fetches under /api (rare)
  if (path.startsWith('/_next/') || path.startsWith('/favicon')) return NextResponse.next()

  // Identify limit: route-specific OR default 60/min
  const perMin = ROUTE_LIMITS[path] || 60
  // We don't have userId in middleware (auth runs in handler), so use IP-only key
  const key = clientKey(req, null)
  const result = rateLimitCheck(`${path}:${key}`, { perMin })
  if (!result.ok) {
    return new NextResponse(JSON.stringify({ ok: false, error: 'Rate limit exceeded', retryAfter: result.retryAfter }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfter),
        'X-RateLimit-Limit': String(perMin),
        'X-RateLimit-Remaining': '0',
      },
    })
  }
  const res = NextResponse.next()
  res.headers.set('X-RateLimit-Limit', String(perMin))
  res.headers.set('X-RateLimit-Remaining', String(result.remaining))
  return res
}
