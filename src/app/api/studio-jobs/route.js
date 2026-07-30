import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function DELETE(req) {
  let body
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const url = new URL(req.url)
  const jobId = body.job_id || url.searchParams.get('job_id')
  const batchId = body.batch_id || url.searchParams.get('batch_id')
  const jobIds = body.job_ids || (url.searchParams.get('job_ids') ? url.searchParams.get('job_ids').split(',') : null)

  const admin = createAdminClient()

  try {
    if (jobId) {
      const { error } = await admin.from('studio_jobs').delete().eq('id', jobId)
      if (error) throw error
      return NextResponse.json({ ok: true, deleted: 1 })
    }

    if (jobIds && Array.isArray(jobIds) && jobIds.length > 0) {
      const { error } = await admin.from('studio_jobs').delete().in('id', jobIds)
      if (error) throw error
      return NextResponse.json({ ok: true, deleted: jobIds.length })
    }

    if (batchId) {
      const { data: batchJobs, error: fetchErr } = await admin
        .from('studio_jobs')
        .select('id, source_ref')

      if (fetchErr) throw fetchErr

      const targetIds = (batchJobs || [])
        .filter(j => j.source_ref?.push_batch_id === batchId || j.source_ref?.batch_id === batchId)
        .map(j => j.id)

      if (targetIds.length > 0) {
        const { error: delErr } = await admin.from('studio_jobs').delete().in('id', targetIds)
        if (delErr) throw delErr
      }

      return NextResponse.json({ ok: true, deleted: targetIds.length })
    }

    return NextResponse.json({ ok: false, error: 'job_id, job_ids, or batch_id is required' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || String(e) }, { status: 500 })
  }
}
