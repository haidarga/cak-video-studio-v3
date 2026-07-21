// Shared helpers for the external analytics API.

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

/** Count rows by a field, biggest bucket first, under a caller-chosen key name. */
export function countBy(rows = [], field, keyName) {
  const counts = new Map()
  for (const row of rows) {
    const value = row[field] ?? null
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .map(([value, count]) => ({ [keyName]: value, count }))
    .sort((a, b) => b.count - a.count)
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

export function parsePaging(params = {}) {
  const rawLimit = toInt(params.limit, DEFAULT_PAGE_SIZE)
  const rawOffset = toInt(params.offset, 0)
  const limit = rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  return { limit, offset: rawOffset > 0 ? rawOffset : 0 }
}

export const round = (n) => Math.round(n * 1_000_000) / 1_000_000

/** persona_id -> brand_id, the only path from generated output back to a brand. */
export function personaBrandIndex(personas = []) {
  return new Map(personas.map((p) => [p.id, p.brand_id ?? null]))
}
