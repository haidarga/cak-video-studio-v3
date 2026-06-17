// POST /api/gen-jobs/retry { request_id }
//
// Retry a failed gen_jobs row. Reads the original input from the row,
// resubmits to fal.ai via the same /api/fal/submit pipeline (so it gets
// budget-gated again + a fresh webhook callback), and links the new
// request_id back to the original via parent_request_id.
//
// Use cases:
//   - Mass variant burst where 2/20 failed on content checker — retry
//     just those 2 without re-firing the 18 that succeeded.
//   - Network glitch or fal.ai 5xx during a one-shot gen.
//   - Stuck "pending" job that never got webhook callback (would be
//     status='error' after timeout reaper; for now we manually retry).
//
// Safety:
//   - retry_count capped at 3 — beyond that, content/payload is probably
//     fundamentally bad, not transient.
//   - Workspace-scoped lookup — caller can only retry their own jobs.
//   - Budget gate fires again on resubmit (free escape if budget cap
//     changed between original gen and retry).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/workspace'
import { falSubmit } from '@/lib/fal-server'
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'

export const runtime = 'nodejs'

const MAX_RETRIES = 3

function webhookUrlFromReq(req) {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (!host) return null
  const secret = process.env.FAL_WEBHOOK_SECRET || ''
  const qs = secret ? `?secret=${encodeURIComponent(secret)}` : ''
  return `${proto}://${host}/api/fal/webhook${qs}`
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    const { request_id } = await req.json()
    if (!request_id) throw new Error('request_id required')

    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

    const admin = createAdminClient()
    const { data: job, error } = await admin
      .from('gen_jobs')
      .select('*')
      .eq('request_id', request_id)
      .eq('workspace_id', wsId)
      .maybeSingle()
    if (error || !job) return NextResponse.json({ ok: false, error: 'gen job not found' }, { status: 404 })

    // Don't re-charge a job that already succeeded or is still in flight.
    if (job.status === 'done') return NextResponse.json({ ok: false, error: 'job sudah selesai (done) — gak perlu retry' }, { status: 409 })
    if (job.status === 'pending' || job.status === 'retrying') return NextResponse.json({ ok: false, error: 'job masih jalan — tunggu dulu sebelum retry' }, { status: 409 })

    if (!job.input) {
      return NextResponse.json({ ok: false, error: 'no input payload stored — this job predates retry support, please re-run from source UI' }, { status: 400 })
    }

    const currentRetries = job.retry_count || 0
    if (currentRetries >= MAX_RETRIES) {
      return NextResponse.json({ ok: false, error: `retry limit (${MAX_RETRIES}) hit — input may be fundamentally broken` }, { status: 429 })
    }

    // Budget re-check.
    const projected = estimateFalCost(job.model, job.input)
    const gate = await assertBudget(supabase, wsId, { projectedUsd: projected })
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

    // Resubmit. parent_request_id tracks lineage back to the original
    // (or the original retry's parent — flat chain, not nested).
    const root = job.parent_request_id || job.request_id
    const webhookUrl = webhookUrlFromReq(req)
    const result = await falSubmit(job.model, job.input, { webhookUrl })

    await admin.from('gen_jobs').insert({
      request_id: result.request_id,
      workspace_id: wsId,
      user_id: user.id,
      kind: job.kind,
      model: job.model,
      status: 'pending',
      duration_seconds: job.duration_seconds,
      input: job.input,
      retry_count: currentRetries + 1,
      parent_request_id: root,
      meta: {
        ...(job.meta || {}),
        status_url: result.status_url,
        response_url: result.response_url,
        retried_from: request_id,
      },
    })

    return NextResponse.json({
      ok: true,
      request_id: result.request_id,
      status_url: result.status_url,
      response_url: result.response_url,
      retry_count: currentRetries + 1,
      parent_request_id: root,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
