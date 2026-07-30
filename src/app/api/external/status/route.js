// GET /api/external/status — query status of pushed studio jobs.
//
// Auth: Bearer API key (validated via external-auth.js).
// Caketing polls this to update status badges on pushed naskah.
//
// Query: ?job_ids=uuid1,uuid2,uuid3  (comma-separated, max 50)
// Response: { ok, jobs: [{ id, status, result_urls, error }] }

import { NextResponse } from 'next/server'
import { validateExternalApiKey, hasPermission } from '@/lib/external-auth'
import { createAdminClient } from '@/lib/supabase/admin'

const MAX_IDS_PER_REQUEST = 50

export async function GET(req) {
  // 1. Validate API key
  const auth = await validateExternalApiKey(req)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  }
  if (!hasPermission(auth, 'status')) {
    return NextResponse.json({ ok: false, error: 'API key lacks status permission' }, { status: 403 })
  }

  // 2. Parse job IDs from query
  const { searchParams } = new URL(req.url)
  const rawIds = searchParams.get('job_ids') || ''
  const jobIds = rawIds.split(',').map(id => id.trim()).filter(Boolean)

  if (jobIds.length === 0) {
    return NextResponse.json({ ok: false, error: 'job_ids query parameter is required' }, { status: 400 })
  }
  if (jobIds.length > MAX_IDS_PER_REQUEST) {
    return NextResponse.json({ ok: false, error: `Max ${MAX_IDS_PER_REQUEST} job IDs per request` }, { status: 400 })
  }

  // Validate UUID format
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const invalidIds = jobIds.filter(id => !uuidRe.test(id))
  if (invalidIds.length > 0) {
    return NextResponse.json({ ok: false, error: `Invalid UUID format: ${invalidIds.join(', ')}` }, { status: 400 })
  }

  // 3. Fetch from DB (workspace-scoped for security)
  const admin = createAdminClient()
  const { data: jobs, error } = await admin
    .from('studio_jobs')
    .select('id, status, result_ids, error, updated_at')
    .eq('workspace_id', auth.workspaceId)
    .in('id', jobIds)

  if (error) {
    return NextResponse.json({ ok: false, error: `Failed to fetch job status: ${error.message}` }, { status: 500 })
  }

  // 4. Fetch result URLs for completed jobs
  const doneJobs = (jobs || []).filter(j => j.status === 'done' && j.result_ids?.length > 0)
  let resultUrls = new Map()

  if (doneJobs.length > 0) {
    const allResultIds = doneJobs.flatMap(j => j.result_ids)
    if (allResultIds.length > 0) {
      const { data: results } = await admin
        .from('results')
        .select('id, url, type')
        .in('id', allResultIds)
      if (results) {
        for (const r of results) {
          resultUrls.set(r.id, { url: r.url, type: r.type })
        }
      }
    }
  }

  // 5. Build response
  return NextResponse.json({
    ok: true,
    jobs: (jobs || []).map(j => ({
      id: j.id,
      status: j.status,
      error: j.error || null,
      updated_at: j.updated_at,
      result_urls: (j.result_ids || [])
        .map(rid => resultUrls.get(rid))
        .filter(Boolean),
    })),
  })
}
