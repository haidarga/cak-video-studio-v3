// Pure aggregation helpers for the external analytics API.
//
// Kept free of Supabase/IO on purpose: the route handlers fetch rows, these
// functions shape them. That keeps the numbers unit-testable without a network.

export const MAX_RANGE_DAYS = 90
const DEFAULT_RANGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export class RangeError extends Error {}

/** Resolve ?from/?to into an ISO window, defaulting to the last 30 days. */
export function parseRange(params = {}, now = new Date()) {
  const to = params.to ? new Date(params.to) : now
  const from = params.from
    ? new Date(params.from)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS)

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new RangeError('Invalid range (400) — from/to must be ISO dates')
  }
  if (from.getTime() > to.getTime()) {
    throw new RangeError('Invalid range (400) — from is after to')
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new RangeError(`Invalid range (400) — window exceeds ${MAX_RANGE_DAYS} days`)
  }

  return { from: from.toISOString(), to: to.toISOString() }
}

/** Id/name pairs the dashboard uses to populate its pickers. Personas carry
 * brand_id because it is the only link from generated output back to a brand. */
export function buildDimensions(brands, personas) {
  return {
    brands: (brands || []).map((b) => ({ id: b.id, name: b.name })),
    personas: (personas || []).map((p) => ({
      id: p.id,
      name: p.name,
      brandId: p.brand_id ?? null,
    })),
  }
}
