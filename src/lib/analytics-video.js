// Output, publishing and ops aggregation for the external analytics API.

import { countBy, personaBrandIndex } from './analytics-util.js'

const TOP_PERSONAS = 10
const ERROR_SAMPLE = 10

export function aggregateVideo({
  results = [],
  genJobs = [],
  factoryRuns = [],
  personas = [],
  brands = [],
}) {
  const brandNameById = new Map(brands.map((b) => [b.id, b.name]))
  const personaById = new Map(personas.map((p) => [p.id, p]))
  const brandByPersona = personaBrandIndex(personas)

  const byDay = new Map()
  const byPersona = new Map()
  for (const r of results) {
    const day = String(r.created_at).slice(0, 10)
    const entry = byDay.get(day) ?? { videos: 0, images: 0 }
    if (r.type === 'video') entry.videos += 1
    if (r.type === 'image') entry.images += 1
    byDay.set(day, entry)

    if (r.persona_id) {
      byPersona.set(r.persona_id, (byPersona.get(r.persona_id) ?? 0) + 1)
    }
  }

  const durations = genJobs
    .map((j) => Number.parseFloat(j.duration_seconds ?? ''))
    .filter((n) => Number.isFinite(n))

  return {
    totalResults: results.length,
    videos: results.filter((r) => r.type === 'video').length,
    images: results.filter((r) => r.type === 'image').length,
    withUrl: results.filter((r) => r.url).length,
    byType: countBy(results, 'type', 'type'),
    byQc: countBy(results, 'qc_status', 'qcStatus'),
    daily: [...byDay]
      .map(([date, v]) => ({ date, videos: v.videos, images: v.images }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topPersonas: [...byPersona]
      .map(([personaId, count]) => {
        const brandId = brandByPersona.get(personaId)
        return {
          personaId,
          personaName: personaById.get(personaId)?.name ?? null,
          brandName: brandId ? (brandNameById.get(brandId) ?? null) : null,
          results: count,
        }
      })
      .sort((a, b) => b.results - a.results)
      .slice(0, TOP_PERSONAS),
    genJobs: {
      total: genJobs.length,
      byStatus: countBy(genJobs, 'status', 'status'),
      byKind: countBy(genJobs, 'kind', 'kind'),
      errorRate: genJobs.length
        ? genJobs.filter((j) => j.status === 'error').length / genJobs.length
        : 0,
      retried: genJobs.filter((j) => (j.retry_count ?? 0) > 0).length,
      avgDurationSeconds: durations.length
        ? durations.reduce((s, n) => s + n, 0) / durations.length
        : null,
    },
    factoryRuns: {
      total: factoryRuns.length,
      byStatus: countBy(factoryRuns, 'status', 'status'),
    },
  }
}

export function aggregatePublishing(posts = []) {
  const byDay = new Map()
  for (const p of posts) {
    if (!p.posted_at) continue
    const day = String(p.posted_at).slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }

  return {
    total: posts.length,
    posted: posts.filter((p) => p.status === 'posted').length,
    scheduled: posts.filter((p) => p.status === 'scheduled').length,
    failed: posts.filter((p) => p.status === 'failed').length,
    byStatus: countBy(posts, 'status', 'status'),
    byPlatform: countBy(posts, 'target_platform', 'platform'),
    daily: [...byDay]
      .map(([date, posted]) => ({ date, posted }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}

export function aggregateOps({ errors = [], jobs = [] }) {
  return {
    errors: {
      total: errors.length,
      byLevel: countBy(errors, 'level', 'level'),
      bySource: countBy(errors, 'source', 'source'),
      recent: [...errors]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, ERROR_SAMPLE)
        .map((e) => ({
          level: e.level,
          source: e.source,
          message: e.message,
          at: e.created_at,
        })),
    },
    jobs: {
      total: jobs.length,
      byStatus: countBy(jobs, 'status', 'status'),
    },
  }
}
