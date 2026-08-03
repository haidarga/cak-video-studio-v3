// GET /api/cron/reconcile-gens
//
// Rescues fal generations that finished but never reached the app.
//
// THE GAP THIS FILLS: `gen_jobs` rows are created at 'pending' and only ever
// leave that state via the fal webhook or a live browser poll. If the webhook is
// rejected (wrong/unset FAL_WEBHOOK_SECRET), unreachable (preview/localhost
// host), or simply lost, and the tab is closed before the 15-20 min client
// timeout, the row stays 'pending' FOREVER:
//   - retry-failed-gens only scans status='error', so it never sees it
//   - /api/gen-jobs/failed only lists status='error' too
//   - the client-side timeout rejects a JS promise; it never touches the DB
// Meanwhile the asset exists on fal and was billed.
//
// This sweeper re-asks fal directly using the response_url we stored at submit
// time, then either ingests the result (creating the `results` row the browser
// never got to create) or marks the row 'error' so retry-failed-gens can take
// over and the UI can surface it.
//
// HOW TO TRIGGER (external scheduler, ~every 10 min):
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/reconcile-gens

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ingestGenJobResult } from '@/lib/gen-ingest'
import { extractFalUrl } from '@/lib/fal-payload'
import { logUsage } from '@/lib/usage-log'
import { imageCost, videoCost } from '@/lib/cost-table'

export const runtime = 'nodejs'
// Without this Next statically optimizes the GET handler (the request is only
// touched inside a helper) and the cron would serve a cached response forever.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Must exceed the longest client-side wait (20 min for video, fal-client.js)
// so we never contradict a tab that is still legitimately waiting.
const STALE_MIN = 25
// Past this we stop paying attention — fal's response_url does not live forever
// and the user has long since moved on or re-generated.
const GIVE_UP_HOURS = 24
const BATCH = 25

function authorized(req) {
  const secret = process.env.CRON_SECRET
  // Service-role sweep across every workspace — no secret, no entry.
  if (!secret) return false
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true
  return new URL(req.url).searchParams.get('secret') === secret
}

// Uses the SAME extractor as the webhook. A local copy here covered fewer fal
// payload shapes, so a job the webhook had missed could come back from fal with
// a perfectly good result, fail to match, and get marked 'error' — recreating
// the very bug this cron exists to fix, then feeding retry-failed-gens into
// re-billing it.
const extractUrl = extractFalUrl

export async function GET(req) {
  if (!authorized(req)) {
    return NextResponse.json({
      ok: false,
      error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET belum di-set — endpoint ini dimatiin.',
    }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = Date.now()
  const staleCutoff = new Date(now - STALE_MIN * 60_000).toISOString()
  const giveUpCutoff = new Date(now - GIVE_UP_HOURS * 3600_000).toISOString()

  const out = { checked: 0, recovered: 0, still_running: 0, marked_error: 0, gave_up: 0, errors: [] }

  const { data: stuck, error } = await admin
    .from('gen_jobs')
    .select('request_id, workspace_id, user_id, kind, model, duration_seconds, meta, created_at')
    .eq('status', 'pending')
    .lt('created_at', staleCutoff)
    .gt('created_at', giveUpCutoff)
    .order('created_at', { ascending: true })
    .limit(BATCH)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const falKey = process.env.FAL_KEY
  if (!falKey) return NextResponse.json({ ok: false, error: 'FAL_KEY not configured' }, { status: 500 })

  for (const job of stuck || []) {
    out.checked++
    const responseUrl = job.meta?.response_url
    if (!responseUrl) {
      // Submitted before we stored response_url, or the insert raced. Nothing to
      // ask fal with — retire it so it stops being scanned every tick.
      await admin.from('gen_jobs').update({
        status: 'error',
        error: 'Job nyangkut pending tanpa response_url — gak bisa dicek ulang ke fal. Generate ulang kalau masih dibutuhin.',
        updated_at: new Date().toISOString(),
      }).eq('request_id', job.request_id)
      out.marked_error++
      continue
    }

    try {
      const r = await fetch(responseUrl, { headers: { Authorization: `Key ${falKey}` }, cache: 'no-store' })

      // 202/queued — genuinely still running on fal's side. Leave it alone.
      if (r.status === 202) { out.still_running++; continue }

      if (!r.ok) {
        // 4xx from fal = the job failed or the result expired. Either way it is
        // not coming back; mark it so retry-failed-gens can pick it up.
        const text = await r.text().catch(() => '')
        await admin.from('gen_jobs').update({
          status: 'error',
          error: `fal ${r.status} waktu reconcile: ${text.slice(0, 300)}`,
          updated_at: new Date().toISOString(),
        }).eq('request_id', job.request_id)
        out.marked_error++
        continue
      }

      const payload = await r.json().catch(() => null)
      const url = extractUrl(payload)
      if (!url) {
        await admin.from('gen_jobs').update({
          status: 'error',
          error: 'fal balikin 200 tapi gak ada URL media di payload.',
          payload,
          updated_at: new Date().toISOString(),
        }).eq('request_id', job.request_id)
        out.marked_error++
        continue
      }

      // Recovered. Claim the job with a compare-and-set so a webhook arriving at
      // the same moment can't ALSO ingest + log usage for it (double-counted cost
      // would trip budget-gate and lock the workspace out of generating).
      const { data: claimed } = await admin.from('gen_jobs').update({
        status: 'done', payload_url: url, payload, error: null,
        updated_at: new Date().toISOString(),
      }).eq('request_id', job.request_id).eq('status', 'pending').select('request_id')
      if (!claimed?.length) { out.still_running++; continue } // webhook won the race

      const ing = await ingestGenJobResult(admin, job, url)
      out.recovered++
      if (ing.reason && ing.reason !== 'already-ingested') {
        out.errors.push(`ingest ${job.request_id.slice(0, 10)}: ${ing.reason}`)
      }

      // The webhook never ran, so usage was never logged for this gen — cost has
      // been silently under-reporting for every job recovered this way.
      try {
        const isVideo = job.kind === 'video'
        await logUsage({
          workspaceId: job.workspace_id, userId: job.user_id,
          kind: isVideo ? 'video_gen' : 'image_gen',
          model: job.model,
          costUsd: isVideo ? videoCost(job.model, job.duration_seconds || 5) : imageCost(job.model),
          meta: { request_id: job.request_id, duration: job.duration_seconds, via: 'reconcile' },
        })
      } catch (e) {
        out.errors.push(`usage ${job.request_id.slice(0, 10)}: ${String(e?.message || e).slice(0, 80)}`)
      }
    } catch (e) {
      // Network blip — leave it pending, next tick retries.
      out.errors.push(`${job.request_id.slice(0, 10)}: ${String(e?.message || e).slice(0, 120)}`)
    }
  }

  // Anything older than the give-up window is retired so the scan stays small.
  const { data: ancient } = await admin
    .from('gen_jobs')
    .select('request_id')
    .eq('status', 'pending')
    .lt('created_at', giveUpCutoff)
    .limit(BATCH)
  if (ancient?.length) {
    await admin.from('gen_jobs').update({
      status: 'error',
      error: `Nyangkut di pending lebih dari ${GIVE_UP_HOURS} jam — hasilnya udah gak bisa diambil dari fal.`,
      updated_at: new Date().toISOString(),
    }).in('request_id', ancient.map((j) => j.request_id))
    out.gave_up = ancient.length
  }

  return NextResponse.json({ ok: true, ...out })
}
