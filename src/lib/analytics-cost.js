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

const dayOf = (v) => String(v).slice(0, 10)

/** Core allocation: split every day's spend by THAT day's output share.
 *
 * usage_log records no persona or brand, and neither does gen_jobs — the only
 * link from output back to a brand is results.persona_id -> personas.brand_id.
 * So per-brand cost is an ALLOCATION, never a measurement.
 *
 * Allocating day by day rather than across the whole window keeps the headline
 * total and the daily chart telling the same story, and stops a brand that was
 * idle on a busy spending day from being charged for it. Spend whose output type
 * produced nothing that day lands on the null brand instead of being dropped, so
 * the allocated total always equals the real total. */
function allocateByDay(usageRows = [], results = [], personas = []) {
  const brandByPersona = personaBrandIndex(personas)

  // day -> result type -> brandId -> count
  const outputByDay = new Map()
  const basisByBrand = new Map()
  for (const r of results) {
    const day = dayOf(r.created_at)
    const perType = outputByDay.get(day) ?? new Map()
    const perBrand = perType.get(r.type) ?? new Map()
    const brandId = brandByPersona.get(r.persona_id) ?? null
    perBrand.set(brandId, (perBrand.get(brandId) ?? 0) + 1)
    perType.set(r.type, perBrand)
    outputByDay.set(day, perType)
    basisByBrand.set(brandId, (basisByBrand.get(brandId) ?? 0) + 1)
  }

  // brandId -> { total, daily: Map<date, amount> }
  const allocated = new Map()
  const add = (brandId, day, amount) => {
    const entry = allocated.get(brandId) ?? { total: 0, daily: new Map() }
    entry.total += amount
    entry.daily.set(day, (entry.daily.get(day) ?? 0) + amount)
    allocated.set(brandId, entry)
  }

  for (const row of usageRows) {
    const day = dayOf(row.created_at)
    const spend = usd(row.cost_usd)
    const perBrand = outputByDay.get(day)?.get(KIND_TO_RESULT_TYPE[row.kind])
    const total = perBrand ? [...perBrand.values()].reduce((s, n) => s + n, 0) : 0
    if (!total) {
      add(null, day, spend)
      continue
    }
    for (const [brandId, count] of perBrand) add(brandId, day, (spend * count) / total)
  }

  return { allocated, basisByBrand }
}

export function allocateCostByBrand(usageRows = [], results = [], personas = [], brands = []) {
  if (!usageRows.length) return []

  const brandNameById = new Map(brands.map((b) => [b.id, b.name]))
  const { allocated, basisByBrand } = allocateByDay(usageRows, results, personas)

  return [...allocated]
    .map(([brandId, entry]) => ({
      brandId,
      brandName: brandId ? (brandNameById.get(brandId) ?? null) : null,
      costUsd: round(entry.total),
      basisResults: basisByBrand.get(brandId) ?? 0,
      allocated: true,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}

/** One brand's day-by-day slice, consistent with its total in allocateCostByBrand. */
export function allocateBrandDaily(usageRows = [], results = [], personas = [], brandId = null) {
  if (!brandId || !usageRows.length) return []

  const { allocated } = allocateByDay(usageRows, results, personas)
  const daily = allocated.get(brandId)?.daily ?? new Map()

  // Days with spend but nothing from this brand must read zero, not go missing.
  const days = [...new Set(usageRows.map((r) => dayOf(r.created_at)))].sort()
  return days.map((date) => ({ date, costUsd: round(daily.get(date) ?? 0) }))
}
