// Cost aggregation over usage_log — real money, not an estimate. Every fal/Gemini
// call is written here with its own cost_usd at the moment it is billed.

import { personaBrandIndex, round } from './analytics-util.js'

/** PostgREST returns numeric(10,4) as a string; naive summing would concatenate. */
const usd = (v) => Number.parseFloat(v ?? 0) || 0

function sortBySpend(entries) {
  return entries.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
}

export function aggregateCost(rows = []) {
  const byKind = new Map()
  const byModel = new Map()
  const byDay = new Map()
  let totalUsd = 0

  for (const row of rows) {
    const cost = usd(row.cost_usd)
    totalUsd += cost

    const kind = byKind.get(row.kind) ?? { costUsd: 0, calls: 0 }
    kind.costUsd += cost
    kind.calls += 1
    byKind.set(row.kind, kind)

    if (row.model) {
      const model = byModel.get(row.model) ?? { costUsd: 0, calls: 0 }
      model.costUsd += cost
      model.calls += 1
      byModel.set(row.model, model)
    }

    const day = String(row.created_at).slice(0, 10)
    const dayEntry = byDay.get(day) ?? { costUsd: 0, calls: 0 }
    dayEntry.costUsd += cost
    dayEntry.calls += 1
    byDay.set(day, dayEntry)
  }

  return {
    estimated: false,
    totalUsd: round(totalUsd),
    totalCalls: rows.length,
    byKind: sortBySpend(
      [...byKind].map(([kind, v]) => ({ kind, costUsd: round(v.costUsd), calls: v.calls }))
    ),
    byModel: sortBySpend(
      [...byModel].map(([model, v]) => ({ model, costUsd: round(v.costUsd), calls: v.calls }))
    ),
    daily: [...byDay]
      .map(([date, v]) => ({ date, costUsd: round(v.costUsd), calls: v.calls }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}

/** Which result type each spend kind produced, so the split uses a like-for-like basis. */
const KIND_TO_RESULT_TYPE = { video_gen: 'video', image_gen: 'image' }

/** Spread spend across brands by their share of the output it produced.
 *
 * usage_log records no persona or brand, and neither does gen_jobs — the only
 * link from output back to a brand is results.persona_id -> personas.brand_id.
 * So per-brand cost is an ALLOCATION, never a measurement, and every row says so.
 * Spend whose output type has no attributable results lands on the null brand
 * rather than being silently dropped, keeping the allocated total honest. */
export function allocateCostByBrand(usageRows = [], results = [], personas = [], brands = []) {
  if (!usageRows.length) return []

  const brandNameById = new Map(brands.map((b) => [b.id, b.name]))
  const brandByPersona = personaBrandIndex(personas)

  const countsByType = new Map()
  const basisByBrand = new Map()
  for (const r of results) {
    const brandId = brandByPersona.get(r.persona_id) ?? null
    const perType = countsByType.get(r.type) ?? new Map()
    perType.set(brandId, (perType.get(brandId) ?? 0) + 1)
    countsByType.set(r.type, perType)
    basisByBrand.set(brandId, (basisByBrand.get(brandId) ?? 0) + 1)
  }

  const spendByKind = new Map()
  for (const row of usageRows) {
    spendByKind.set(row.kind, (spendByKind.get(row.kind) ?? 0) + usd(row.cost_usd))
  }

  const allocated = new Map()
  const add = (brandId, amount) =>
    allocated.set(brandId, (allocated.get(brandId) ?? 0) + amount)

  for (const [kind, spend] of spendByKind) {
    const perType = countsByType.get(KIND_TO_RESULT_TYPE[kind]) ?? new Map()
    const total = [...perType.values()].reduce((s, n) => s + n, 0)
    if (!total) {
      add(null, spend)
      continue
    }
    for (const [brandId, count] of perType) add(brandId, (spend * count) / total)
  }

  return [...allocated]
    .map(([brandId, costUsd]) => ({
      brandId,
      brandName: brandId ? (brandNameById.get(brandId) ?? null) : null,
      costUsd: round(costUsd),
      basisResults: basisByBrand.get(brandId) ?? 0,
      allocated: true,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}
