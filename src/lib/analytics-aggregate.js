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

function sortByTokens(entries) {
  return entries.sort((a, b) => b.tokens - a.tokens || b.runs - a.runs)
}

/** Fold agent_logs rows into the `cost` section. Brands resolve run counts to names. */
export function aggregateCost(rows = [], brands = []) {
  const nameById = new Map((brands || []).map((b) => [b.id, b.name]))
  const byAgent = new Map()
  const byRunType = new Map()
  const byBrand = new Map()
  const byDay = new Map()

  let totalTokens = 0
  let totalRuns = 0
  let runsWithTokens = 0

  for (const row of rows || []) {
    const tokens = row.tokens_used ?? 0
    totalTokens += tokens
    totalRuns += 1
    if (row.tokens_used != null) runsWithTokens += 1

    const agent = byAgent.get(row.agent_name) ?? { tokens: 0, runs: 0, durationMs: 0 }
    agent.tokens += tokens
    agent.runs += 1
    agent.durationMs += row.duration_ms ?? 0
    byAgent.set(row.agent_name, agent)

    const runType = byRunType.get(row.run_type) ?? { tokens: 0, runs: 0 }
    runType.tokens += tokens
    runType.runs += 1
    byRunType.set(row.run_type, runType)

    const brandKey = row.brand_id ?? null
    const brand = byBrand.get(brandKey) ?? { tokens: 0, runs: 0 }
    brand.tokens += tokens
    brand.runs += 1
    byBrand.set(brandKey, brand)

    const day = String(row.created_at).slice(0, 10)
    const dayEntry = byDay.get(day) ?? { tokens: 0, runs: 0 }
    dayEntry.tokens += tokens
    dayEntry.runs += 1
    byDay.set(day, dayEntry)
  }

  return {
    totalTokens,
    totalRuns,
    runsWithTokens,
    byAgent: sortByTokens(
      [...byAgent].map(([agent, v]) => ({
        agent,
        tokens: v.tokens,
        runs: v.runs,
        avgDurationMs: Math.round(v.durationMs / v.runs),
      }))
    ),
    byRunType: sortByTokens(
      [...byRunType].map(([runType, v]) => ({ runType, tokens: v.tokens, runs: v.runs }))
    ),
    byBrand: sortByTokens(
      [...byBrand].map(([brandId, v]) => ({
        brandId,
        brandName: brandId ? (nameById.get(brandId) ?? null) : null,
        tokens: v.tokens,
        runs: v.runs,
      }))
    ),
    daily: [...byDay]
      .map(([date, v]) => ({ date, tokens: v.tokens, runs: v.runs }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}

/** Id/name pairs the dashboard uses to populate its brand + persona pickers. */
export function buildDimensions(brands, personas) {
  return {
    brands: (brands || []).map((b) => ({ id: b.id, name: b.name })),
    personas: (personas || []).map((p) => ({ id: p.id, name: p.name })),
  }
}
