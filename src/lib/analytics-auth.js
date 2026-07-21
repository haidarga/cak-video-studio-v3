// Shared-secret gate for /api/external/analytics/*.
//
// These routes are called server-to-server by cakai-ugc-backend, so there is no
// Supabase session to check — the caller proves itself with ANALYTICS_API_KEY.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

function matches(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Returns a 401 response when the caller is not authorised, or null when it is. */
export function requireAnalyticsKey(req) {
  const expected = process.env.ANALYTICS_API_KEY
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'Analytics API unavailable (503) — ANALYTICS_API_KEY is not set' },
      { status: 503 }
    )
  }

  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!provided || !matches(provided, expected)) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized (401) — missing or invalid analytics key' },
      { status: 401 }
    )
  }

  return null
}
