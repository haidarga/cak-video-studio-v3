// fal.ai webhook receiver. fal POSTs here when a job we submitted finishes.
//
// Payload shape (per fal docs):
//   { request_id, gateway_request_id, status: 'OK' | 'ERROR', payload }
// We look up the gen_jobs row by request_id and flip status='done' (with the
// extracted image/video URL) or status='error'. Browser subscribes to that
// row via Supabase realtime — when it flips, the gen completes in the UI.
//
// Auth: we gate via ?secret=FAL_WEBHOOK_SECRET (set in Vercel env). fal will
// echo the secret because it's part of the URL we registered at submit time.
// FAIL-CLOSED when the env var is unset — /api/fal/submit now refuses to
// register a callback in that case too, so the two sides agree instead of
// registering a URL this endpoint would always reject.
//
// This receiver is ALSO the authoritative result-ingestion point: it creates the
// `results` row (see lib/gen-ingest.js), so a generation survives the browser
// tab being closed.
//
// Idempotent: fal may retry on delivery failure. We UPDATE on conflict-safe
// matching by request_id (PK), so a duplicate webhook just overwrites with
// the same final state. No double-counting.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logUsage } from '@/lib/usage-log'
import { imageCost, videoCost } from '@/lib/cost-table'
import { ingestGenJobResult } from '@/lib/gen-ingest'
import { extractFalUrl } from '@/lib/fal-payload'

// Extract the displayable URL from fal's payload. Different model families
// return different shapes; we handle the common ones.
// extractUrl moved to lib/fal-payload.js so the reconcile cron uses the SAME
// shape coverage — a weaker copy there marked good jobs as failed.
const extractUrl = extractFalUrl

export async function POST(req) {
  const { searchParams } = new URL(req.url)
  const secret = searchParams.get('secret') || ''
  const expected = process.env.FAL_WEBHOOK_SECRET || ''
  // Fail-CLOSED: this URL is public. Without the secret configured, anyone could
  // forge job completions (fake result URLs, billed to the workspace). Refuse.
  if (!expected) {
    console.error('[fal/webhook] FAL_WEBHOOK_SECRET not set — refusing all webhooks (fail-closed)')
    return NextResponse.json({ ok: false, error: 'webhook not configured' }, { status: 503 })
  }
  if (secret !== expected) {
    return NextResponse.json({ ok: false, error: 'invalid secret' }, { status: 401 })
  }

  let body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  const requestId = body.request_id || body.gateway_request_id
  if (!requestId) return NextResponse.json({ ok: false, error: 'no request_id' }, { status: 400 })

  const admin = createAdminClient()
  // Fetch the job row so we know workspace_id + kind + duration for usage log.
  const { data: job, error: jobErr } = await admin
    .from('gen_jobs')
    .select('request_id, workspace_id, user_id, kind, model, duration_seconds, status, meta')
    .eq('request_id', requestId)
    .maybeSingle()
  if (jobErr || !job) {
    // No matching row — could be a stale retry after the row was deleted, or
    // a fal callback for a request we never registered. Acknowledge 200 so
    // fal stops retrying; nothing else to do.
    return NextResponse.json({ ok: true, ignored: true })
  }
  // Already finalized — idempotent no-op.
  if (job.status === 'done' || job.status === 'error') {
    return NextResponse.json({ ok: true, already: job.status })
  }

  const ok = (body.status || '').toUpperCase() === 'OK'
  const url = ok ? extractUrl(body.payload) : null
  const error = ok ? null : (body.payload?.detail || body.payload?.error || body.error || 'fal job failed')

  // COMPARE-AND-SET on status='pending'. The `job.status` check above is a
  // read-then-write, so a webhook and the reconcile cron finishing the same job
  // within the same window could BOTH pass it and both log usage — corrupting
  // the workspace cost total that budget-gate locks generations against.
  // Gating the update means exactly one of them sees a row come back.
  const { data: claimed } = await admin.from('gen_jobs').update({
    status: ok ? 'done' : 'error',
    payload_url: url,
    payload: body.payload || null,
    error,
    updated_at: new Date().toISOString(),
  }).eq('request_id', requestId).eq('status', 'pending').select('request_id')

  if (!claimed?.length) {
    // Someone else finalized it between our read and this write.
    return NextResponse.json({ ok: true, already: 'claimed-elsewhere' })
  }

  // INGEST — create the `results` row server-side. Previously this webhook only
  // flipped gen_jobs and the insert lived in the browser after `await falRun`,
  // so closing the tab mid-generation lost the asset forever even though fal had
  // finished and the account was billed. Idempotent: if the tab was open and got
  // there first, this no-ops on the unique index from migration 0032.
  let ingested = null
  if (ok && url) {
    try {
      ingested = await ingestGenJobResult(admin, job, url)
    } catch (e) {
      // Never fail the webhook over ingestion — fal would retry the whole
      // callback and we'd re-log usage below.
      console.warn('[fal/webhook] ingest failed', e)
    }
  }

  // Log usage on successful completions only — errors didn't burn $.
  if (ok && job.workspace_id) {
    const isVideo = job.kind === 'video'
    const cost = isVideo ? videoCost(job.model, job.duration_seconds || 5) : imageCost(job.model)
    try {
      await logUsage({
        workspaceId: job.workspace_id, userId: job.user_id,
        kind: isVideo ? 'video_gen' : 'image_gen',
        model: job.model, costUsd: cost,
        meta: { request_id: requestId, duration: job.duration_seconds, via: 'webhook' },
      })
    } catch (e) {
      // Don't fail the webhook over usage logging — already returned ok.
      console.warn('webhook: usage log failed', e)
    }
  }
  return NextResponse.json({ ok: true, ingested: ingested?.reason || (ingested?.inserted ? 'inserted' : null) })
}

// GET is convenient for sanity-checking the deployed URL from a browser.
export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST only — fal webhook receiver' })
}
