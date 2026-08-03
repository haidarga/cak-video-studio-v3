// SERVER-ONLY. Promote a finished `gen_jobs` row into a `results` row.
//
// WHY THIS EXISTS: nothing on the server ever created a `results` row for the
// generate flow. The fal webhook only flipped `gen_jobs.status`, and the actual
// insert lived in the browser, AFTER `await falRun(...)` resolved. So closing
// the tab mid-generation lost the asset permanently — fal had finished, the
// account was billed, and no process would ever pick it up. The `gen_jobs` row
// just sat at 'pending' forever, invisible even to retry-failed-gens (which only
// scans status='error').
//
// Now the browser and the server race to ingest, and whoever loses hits the
// unique index from migration 0032 and adopts the winner's row.

// Pure — the row we would insert, or null if this job should not be ingested.
// Split out so the decision logic is unit-testable without a DB.
export function buildResultRowFromJob(job, url) {
  if (!job || !url) return null
  if (!job.workspace_id) return null
  // Ingestion is OPT-IN via meta.ingest, recorded at submit time by the surface
  // that wants the asset persisted. god-mode and one-off jobs handle their own
  // persistence; auto-ingesting them would create assets nobody asked to keep.
  const ingest = job.meta?.ingest
  if (!ingest || typeof ingest !== 'object') return null

  return {
    workspace_id: job.workspace_id,
    persona_id: ingest.persona_id || null,
    type: ingest.type || (job.kind === 'image' ? 'image' : 'video'),
    url,
    label: ingest.label || null,
    ar: ingest.ar || null,
    group_label: ingest.group_label || null,
    request_id: job.request_id,
    // Preview image so grids can render <img> instead of a <video> element.
    poster_url: ingest.image_url || null,
    meta: {
      source: ingest.source || 'generate',
      image_url: ingest.image_url || null,
      model: job.model || null,
      // Lets you tell at a glance which rows the browser missed — i.e. how often
      // users are closing the tab mid-generation.
      ingested_by: 'server',
    },
    created_by: job.user_id || null,
  }
}

// Insert idempotently. Returns { inserted, resultId, reason }.
export async function ingestGenJobResult(admin, job, url) {
  const row = buildResultRowFromJob(job, url)
  if (!row) return { inserted: false, resultId: null, reason: 'no-ingest-intent' }

  const { data, error } = await admin.from('results').insert(row).select('id').single()
  if (!error) return { inserted: true, resultId: data.id, reason: null }

  // 23505 = the browser already ingested this exact fal job. Expected on the
  // happy path — the tab was open and won the race.
  if (error.code === '23505') {
    const { data: existing } = await admin.from('results')
      .select('id').eq('workspace_id', job.workspace_id).eq('request_id', job.request_id).maybeSingle()
    return { inserted: false, resultId: existing?.id || null, reason: 'already-ingested' }
  }
  // 42703 = `request_id` column missing → migration 0032 not applied yet.
  // Say so loudly instead of failing mysteriously.
  if (error.code === '42703') {
    console.error('[gen-ingest] results.request_id missing — apply migration 0032 before relying on server ingestion')
    return { inserted: false, resultId: null, reason: 'migration-0032-missing' }
  }
  return { inserted: false, resultId: null, reason: error.message }
}
