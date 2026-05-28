// Simple in-memory rate limiter for API routes. Resets every minute.
// Production-grade would use Redis, but for single-instance Vercel this is OK.
// For multi-region/multi-instance, swap to Upstash Redis or KV.

const buckets = new Map() // key (ip+userId) -> { count, resetAt }

export function rateLimitCheck(key, { perMin = 60 } = {}) {
  const now = Date.now()
  const slot = buckets.get(key)
  if (!slot || slot.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 })
    return { ok: true, remaining: perMin - 1 }
  }
  if (slot.count >= perMin) {
    const retryAfter = Math.ceil((slot.resetAt - now) / 1000)
    return { ok: false, retryAfter }
  }
  slot.count += 1
  return { ok: true, remaining: perMin - slot.count }
}

// Optional cleanup (call from periodic task)
export function rateLimitGc() {
  const now = Date.now()
  for (const [k, v] of buckets.entries()) if (v.resetAt < now) buckets.delete(k)
}

// Helper: extract client key from request (IP-ish + userId)
export function clientKey(req, userId) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('x-real-ip')
    || 'unknown'
  return `${ip}:${userId || 'anon'}`
}
