// Content-pipeline aggregation for the external analytics API. Pure functions —
// the route fetches, these shape.

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

export function aggregateContent({ pipeline = [], naskah = [], genJobs = [], qcFlags = [] }) {
  const posted = pipeline.filter((r) => r.stage === 'posted')
  const scored = pipeline.filter((r) => r.performance_score != null)

  return {
    pipelineByStage: countBy(pipeline, 'stage', 'stage'),
    byFormat: countBy(pipeline, 'content_format', 'format'),
    byType: countBy(pipeline, 'content_type', 'type'),
    naskahByStatus: countBy(naskah, 'status', 'status'),
    genJobsByStatus: countBy(genJobs, 'status', 'status'),
    qcFlags: {
      total: qcFlags.length,
      bySeverity: countBy(qcFlags, 'severity', 'severity'),
    },
    postedCount: posted.length,
    avgPerformanceScore: scored.length
      ? scored.reduce((sum, r) => sum + r.performance_score, 0) / scored.length
      : null,
    withProductionUrl: pipeline.filter((r) => r.production_url).length,
  }
}
