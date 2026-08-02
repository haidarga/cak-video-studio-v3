// GET /api/cron/reconcile-posts
//
// Recovers scheduled_posts rows that got stranded, and closes the loop on rows
// Postiz already published. Before this existed, nothing ever reconciled
// scheduled_posts against reality, which produced two invisible failures:
//
//   A. STUCK 'posting' — /api/postiz/post sets status='posting' BEFORE the
//      Postiz round-trip. If the serverless function is killed (maxDuration,
//      OOM on a large media buffer) the row stays 'posting' forever with
//      error=null. The UI shows an orange pill and offers no Retry button
//      (Retry only renders for 'failed'), so the row is unrecoverable by hand.
//
//   B. PHANTOM 'scheduled' — a future-dated row is INSERTED as 'scheduled' and,
//      on success, UPDATED to 'scheduled' again. The two states are identical,
//      so if the fire-and-forget push never landed (tab closed, navigation,
//      network drop) the row looks perfectly healthy and NOTHING ever publishes
//      it. `external_id IS NULL` is the only tell.
//
//   C. NEVER-CLOSED 'scheduled' — even on the happy path a scheduled row stops
//      at 'scheduled'. Postiz publishes it later; v3 never learns, so it never
//      counts toward analytics (which filters status='posted').
//
// A and B are marked 'failed' with an actionable message, which makes the
// existing Retry button appear. We deliberately do NOT auto-repost: republishing
// something that may already be live is worse than asking for one click.
//
// HOW TO TRIGGER (same constraint as retry-failed-gens — Vercel Hobby cron is
// daily-only, so use an external scheduler every ~10 min):
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/reconcile-posts

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPostizPost } from '@/lib/postiz'

export const runtime = 'nodejs'
// Without this Next.js statically optimizes the GET handler (the request is only
// touched inside a helper, so the dynamic-API scan misses it) and the cron would
// serve a cached response forever instead of running.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Grace windows — must exceed the worst-case runtime of /api/postiz/post
// (maxDuration=60) so we never kill a request that is still in flight.
const POSTING_STALE_MIN = 10
const SCHEDULED_UNPUSHED_MIN = 15
const BATCH = 50
const VERIFY_BATCH = 25

// This endpoint runs on the service-role client and sweeps EVERY workspace, so
// an unauthenticated call could mass-flip rows across the whole tenant base.
// It therefore fails closed: no CRON_SECRET configured means nobody gets in.
// (Deliberately NOT keyed off NODE_ENV — a host that doesn't set it to
// 'production' would silently open the endpoint to the world.)
function authorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true
  // Query fallback kept for parity with /api/cron/retry-failed-gens, which the
  // external scheduler already uses. Prefer the header — a URL secret ends up in
  // access logs and browser history.
  return new URL(req.url).searchParams.get('secret') === secret
}

async function credsFor(admin, row) {
  const accountId = row.target_postiz_account_id || row.personas?.postiz_account_id
  if (accountId) {
    // Workspace-scoped — target_postiz_account_id is client-written on insert and
    // nothing guarantees it points inside the row's own workspace.
    const { data } = await admin.from('postiz_accounts').select('url, api_key')
      .eq('id', accountId).eq('workspace_id', row.workspace_id).maybeSingle()
    if (data) return { url: data.url, key: data.api_key }
  }
  const { data } = await admin.from('postiz_accounts').select('url, api_key')
    .eq('workspace_id', row.workspace_id).order('created_at', { ascending: true }).limit(1).maybeSingle()
  return data ? { url: data.url, key: data.api_key } : null
}

export async function GET(req) {
  if (!authorized(req)) {
    return NextResponse.json({
      ok: false,
      error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET belum di-set — endpoint ini dimatiin biar gak bisa dipanggil sembarang orang.',
    }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = Date.now()
  const postingCutoff = new Date(now - POSTING_STALE_MIN * 60_000).toISOString()
  const scheduledCutoff = new Date(now - SCHEDULED_UNPUSHED_MIN * 60_000).toISOString()

  const out = { stuck_posting: 0, phantom_scheduled: 0, confirmed_posted: 0, errors: [] }

  // ── A. stuck in 'posting' ────────────────────────────────────────
  const { data: stuck, error: stuckErr } = await admin
    .from('scheduled_posts')
    .select('id')
    .eq('status', 'posting')
    .lt('updated_at', postingCutoff)
    .limit(BATCH)
  if (stuckErr) out.errors.push(`posting scan: ${stuckErr.message}`)
  else if (stuck?.length) {
    const { error } = await admin.from('scheduled_posts').update({
      status: 'failed',
      error: `Push ke Postiz kepotong di tengah jalan (kemungkinan timeout waktu upload media, atau file kegedean) — gak ada konfirmasi dari Postiz. Cek dulu di akunnya: kalau BELUM ke-post, klik Retry.`,
    }).in('id', stuck.map((r) => r.id))
    if (error) out.errors.push(`posting update: ${error.message}`)
    else out.stuck_posting = stuck.length
  }

  // ── B. 'scheduled' that never reached Postiz ─────────────────────
  const { data: phantom, error: phantomErr } = await admin
    .from('scheduled_posts')
    .select('id')
    .eq('status', 'scheduled')
    .is('external_id', null)
    .lt('updated_at', scheduledCutoff)
    .limit(BATCH)
  if (phantomErr) out.errors.push(`scheduled scan: ${phantomErr.message}`)
  else if (phantom?.length) {
    const { error } = await admin.from('scheduled_posts').update({
      status: 'failed',
      error: `Post ini gak pernah kekirim ke Postiz (request-nya putus sebelum nyampe — biasanya tab ke-close atau pindah halaman pas lagi submit). Klik Retry buat kirim ulang.`,
    }).in('id', phantom.map((r) => r.id))
    if (error) out.errors.push(`scheduled update: ${error.message}`)
    else out.phantom_scheduled = phantom.length
  }

  // ── C. 'scheduled' + pushed + due — ask Postiz if it went out ────
  const { data: due, error: dueErr } = await admin
    .from('scheduled_posts')
    .select('id, workspace_id, external_id, scheduled_for, target_postiz_account_id, personas(postiz_account_id)')
    .eq('status', 'scheduled')
    .not('external_id', 'is', null)
    .lt('scheduled_for', new Date(now - 10 * 60_000).toISOString())
    .limit(VERIFY_BATCH)
  if (dueErr) out.errors.push(`due scan: ${dueErr.message}`)
  else {
    for (const row of due || []) {
      try {
        const creds = await credsFor(admin, row)
        if (!creds) continue
        const post = await getPostizPost(creds, row.external_id)
        const state = String(post?.state || post?.status || '').toUpperCase()
        const releaseURL = post?.releaseURL || post?.releaseUrl || post?.posts?.[0]?.releaseURL || null
        if (state === 'PUBLISHED' || releaseURL) {
          await admin.from('scheduled_posts').update({
            status: 'posted',
            posted_at: new Date().toISOString(),
            external_response: post,
            error: null,
          }).eq('id', row.id)
          out.confirmed_posted++
        } else if (state === 'ERROR') {
          await admin.from('scheduled_posts').update({
            status: 'failed',
            error: `Postiz nolak post ini di level platform (state=ERROR). Cek koneksi channel-nya di Postiz, lalu Retry.`,
          }).eq('id', row.id)
        }
      } catch (e) {
        // Transient Postiz failure — leave the row alone, next tick retries.
        out.errors.push(`verify ${row.id.slice(0, 8)}: ${String(e?.message || e).slice(0, 120)}`)
      }
    }
  }

  return NextResponse.json({ ok: true, ...out })
}
