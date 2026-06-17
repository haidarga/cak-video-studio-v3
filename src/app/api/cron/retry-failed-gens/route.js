// GET /api/cron/retry-failed-gens
//
// Auto-retry endpoint for transient fal failures. Scans gen_jobs for
// FAILED rows that look like transient failures (content checker,
// network, fal 5xx) and retries them up to MAX_RETRIES per chain.
//
// HOW TO TRIGGER:
// Vercel Hobby tier only allows daily cron — our previous vercel.json
// with */15 schedule blocked the build entirely. Options:
//   1. External cron service hitting this URL every 15 min:
//      curl -H "Authorization: Bearer $CRON_SECRET" \
//        https://<your-domain>/api/cron/retry-failed-gens
//      Free: cron-job.org, EasyCron, Upstash QStash
//   2. Manual trigger from settings UI (button → POST this endpoint)
//   3. Upgrade to Vercel Pro for native */15 cron schedule support.
//
// Why automated retry exists:
//   - Mass-variant burst (10-30 gens) on the fal content checker has
//     a flaky false-positive rate. Without auto-retry, a 20-gen run
//     reliably loses 2-3 to false positives that pass on resubmit.
//   - Network blips / fal 503s during scheduled batch runs would
//     otherwise sit in error state forever.
//   - User wakes up to a complete batch instead of 18/20 done + 2
//     mystery failures.
//
// What is NOT retried:
//   - Rows with retry_count >= MAX_RETRIES (3) — input is persistently
//     broken, not transient.
//   - Rows without `input` payload — predates retry support.
//   - Rows older than RETRY_WINDOW_HOURS — too stale, user has likely
//     moved on or already re-run manually.
//   - Rows with non-flaky errors (auth failures, validation errors,
//     budget rejects) — these need human intervention.
//
// Auth: Vercel cron jobs send a request from a special IP with the
// CRON_SECRET header (if set). We accept either that OR a secret in
// the URL query for manual triggering during testing.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { falSubmit } from '@/lib/fal-server'
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'

export const runtime = 'nodejs'
export const maxDuration = 60 // 1 min — process up to ~50 retries per tick

const MAX_RETRIES = 3
const RETRY_WINDOW_HOURS = 24
const BATCH_SIZE = 50

// Recognize transient/flaky errors that ARE worth retrying.
// Same heuristic as src/lib/fal-client.js isFlakyFalError but server-side.
function isTransient(errStr) {
  const s = String(errStr || '').toLowerCase()
  if (!s) return false
  return (
    s.includes('content checker') ||
    s.includes('flagged by a content checker') ||
    s.includes('content could not be processed') ||
    s.includes('partner_validation_failed') ||
    s.includes('temporarily unavailable') ||
    s.includes('please try again') ||
    s.includes('rate limit') ||
    s.includes('503') || s.includes('502') || s.includes('504') ||
    s.includes('timeout') || s.includes('etimedout') ||
    s.includes('econnreset')
  )
}

// Forge a webhook URL — cron runs server-side, so we read host from env
// (set VERCEL_URL or NEXT_PUBLIC_APP_URL).
function webhookUrl() {
  const base = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base) return null
  const secret = process.env.FAL_WEBHOOK_SECRET || ''
  const qs = secret ? `?secret=${encodeURIComponent(secret)}` : ''
  return `${base}/api/fal/webhook${qs}`
}

export async function GET(req) {
  // Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>
  // OR caller passes ?secret=... for manual trigger.
  const cronSecret = process.env.CRON_SECRET
  // Fail-CLOSED: without CRON_SECRET, anyone could trigger a mass fal retry
  // storm across every workspace (drains fal budgets). Refuse when unconfigured.
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  }
  const url = new URL(req.url)
  const authHeader = req.headers.get('authorization') || ''
  const querySecret = url.searchParams.get('secret') || ''
  if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const since = new Date(Date.now() - RETRY_WINDOW_HOURS * 3600 * 1000).toISOString()

  // Pull recent failures with input + retry budget remaining.
  const { data: failed, error } = await admin
    .from('gen_jobs')
    .select('*')
    .eq('status', 'error')
    .gte('created_at', since)
    .lt('retry_count', MAX_RETRIES)
    .not('input', 'is', null)
    .order('created_at', { ascending: false })
    .limit(BATCH_SIZE)

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const stats = { scanned: failed?.length || 0, transient: 0, retried: 0, skipped_nontransient: 0, budget_blocked: 0, fal_failed: 0 }

  for (const job of failed || []) {
    if (!isTransient(job.error)) { stats.skipped_nontransient++; continue }
    stats.transient++

    // Budget gate — if workspace is over budget, skip (will retry next tick
    // if it clears, e.g. tomorrow's reset).
    const projected = estimateFalCost(job.model, job.input)
    const gate = await assertBudget(admin, job.workspace_id, { projectedUsd: projected })
    if (!gate.ok) { stats.budget_blocked++; continue }

    try {
      const root = job.parent_request_id || job.request_id
      const result = await falSubmit(job.model, job.input, { webhookUrl: webhookUrl() })
      await admin.from('gen_jobs').insert({
        request_id: result.request_id,
        workspace_id: job.workspace_id,
        user_id: job.user_id,
        kind: job.kind,
        model: job.model,
        status: 'pending',
        duration_seconds: job.duration_seconds,
        input: job.input,
        retry_count: (job.retry_count || 0) + 1,
        parent_request_id: root,
        meta: {
          ...(job.meta || {}),
          status_url: result.status_url,
          response_url: result.response_url,
          retried_from: job.request_id,
          retry_source: 'cron',
        },
      })
      // Mark the parent so the NEXT cron tick (which may fire before this retry
      // resolves) doesn't re-submit the SAME failed job in parallel — the #1
      // cause of duplicate fal charges. status='retrying' drops it from the
      // status='error' scan above. (gen_jobs.status is plain text, no enum.)
      await admin.from('gen_jobs')
        .update({ status: 'retrying', updated_at: new Date().toISOString() })
        .eq('request_id', job.request_id)
      stats.retried++
    } catch (e) {
      stats.fal_failed++
      // Don't break the loop — keep processing other failures.
      console.warn('[cron retry-failed-gens] fal submit failed for', job.request_id, ':', e.message)
    }
  }

  return NextResponse.json({
    ok: true,
    window_hours: RETRY_WINDOW_HOURS,
    ...stats,
    timestamp: new Date().toISOString(),
  })
}
