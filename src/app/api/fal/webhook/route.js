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
// Without the env var set we allow through (so dev setup works without it).
//
// Idempotent: fal may retry on delivery failure. We UPDATE on conflict-safe
// matching by request_id (PK), so a duplicate webhook just overwrites with
// the same final state. No double-counting.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logUsage } from '@/lib/usage-log'
import { imageCost, videoCost } from '@/lib/cost-table'

// Extract the displayable URL from fal's payload. Different model families
// return different shapes; we handle the common ones.
function extractUrl(payload) {
  if (!payload || typeof payload !== 'object') return null
  
  // 1. Gambar
  if (payload.images?.[0]?.url) return payload.images[0].url
  if (typeof payload.images?.[0] === 'string') return payload.images[0]
  if (payload.image?.url) return payload.image.url
  if (payload.image_url) return payload.image_url

  // 2. Video
  if (payload.video?.url) return payload.video.url
  if (typeof payload.video === 'string') return payload.video
  if (payload.video_url) return payload.video_url
  if (payload.videos?.[0]?.url) return payload.videos[0].url
  if (typeof payload.videos?.[0] === 'string') return payload.videos[0]

  // 3. Output Generic / File / Audio
  if (payload.output?.url) return payload.output.url
  if (payload.output?.video?.url) return payload.output.video.url
  if (payload.file?.url) return payload.file.url
  if (payload.audio?.url) return payload.audio.url
  if (typeof payload.url === 'string') return payload.url

  return null
}

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
    .select('workspace_id, user_id, kind, model, duration_seconds, status')
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

  await admin.from('gen_jobs').update({
    status: ok ? 'done' : 'error',
    payload_url: url,
    payload: body.payload || null,
    error,
    updated_at: new Date().toISOString(),
  }).eq('request_id', requestId)

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
  return NextResponse.json({ ok: true })
}

// GET is convenient for sanity-checking the deployed URL from a browser.
export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST only — fal webhook receiver' })
}
