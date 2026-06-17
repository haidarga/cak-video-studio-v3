// GET /api/god-mode/gen-status?request_id=...&model=...&status_url=...&response_url=...
//
// Poll a fal.ai queued generation. Used by the chat UI to follow a
// gen_video that returned `type: 'gen_video_queued'` from the agent route
// (when inline polling timed out at 30s but the gen continues server-side).
//
// THREE TIERS OF URL RESOLUTION (in priority order):
//   1. status_url / response_url passed via query params — AUTHORITATIVE
//      (fal returned them at submit time). No guessing needed.
//   2. Look up gen_jobs.meta.status_url / response_url by request_id — for
//      submissions that went through /api/fal/submit which records them.
//   3. Construct URLs from candidate model paths — fallback for legacy
//      queued messages from before status_url plumbing existed. Uses
//      candidateFalPaths() to probe canonical + alias + algorithmic
//      derivations.
//
// On completion, also persists the result to the `results` table so it
// appears in /qc. Returns the same shape the inline gen would have
// returned, so the frontend can swap the queued message for a result
// message seamlessly.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { candidateFalPaths } from '@/lib/fal-paths'

export const runtime = 'nodejs'

async function getFalKey(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspaces').select('fal_key').eq('id', workspaceId).maybeSingle()
  return data?.fal_key || process.env.FAL_KEY || ''
}

export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const requestId = url.searchParams.get('request_id')
  const model = url.searchParams.get('model')
  if (!requestId || !model) {
    return NextResponse.json({ ok: false, error: 'request_id + model required' }, { status: 400 })
  }

  // Resolve user's workspace for fal key + saving result.
  const { data: ms } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id)')
    .eq('user_id', user.id).limit(1)
  const wsId = ms?.[0]?.workspace_id
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const falKey = await getFalKey(supabase, wsId)
  if (!falKey) return NextResponse.json({ ok: false, error: 'no fal key' }, { status: 500 })

  const ar = url.searchParams.get('ar') || 'auto'
  const duration = parseInt(url.searchParams.get('duration')) || 5
  const motion = url.searchParams.get('motion') || ''
  const personaId = url.searchParams.get('persona_id') || null

  // ── URL resolution: tier 1 (query) → tier 2 (gen_jobs.meta) → tier 3 (candidates) ──
  let statusUrl = url.searchParams.get('status_url') || null
  let responseUrl = url.searchParams.get('response_url') || null

  if (!statusUrl || !responseUrl) {
    const { data: jobRow } = await supabase
      .from('gen_jobs').select('meta').eq('request_id', requestId).eq('workspace_id', wsId).maybeSingle()
    if (jobRow?.meta?.status_url) statusUrl = statusUrl || jobRow.meta.status_url
    if (jobRow?.meta?.response_url) responseUrl = responseUrl || jobRow.meta.response_url
  }

  async function tryResultFetchUrl(rUrl) {
    const fullRes = await fetch(rUrl, { headers: { 'Authorization': `Key ${falKey}` }, cache: 'no-store' })
    if (!fullRes.ok) return null
    const fullData = await fullRes.json().catch(() => ({}))
    const videoUrl =
      fullData?.video?.url ||
      fullData?.video_url ||
      fullData?.output?.video?.url ||
      fullData?.output?.url ||
      fullData?.url ||
      (Array.isArray(fullData?.videos) && fullData.videos[0]?.url) ||
      null
    return videoUrl ? { videoUrl, raw: fullData } : null
  }

  async function tryStatusFetchUrl(sUrl) {
    const r = await fetch(sUrl, { headers: { 'Authorization': `Key ${falKey}` }, cache: 'no-store' })
    const data = await r.json().catch(() => ({}))
    return { status: data?.status, queue_position: data?.queue_position, hint: data?.detail || data?.error || null }
  }

  async function persistAndRespond(videoUrl, matchedModel) {
    const { data: row } = await supabase.from('results').insert({
      workspace_id: wsId,
      persona_id: personaId,
      type: 'video', url: videoUrl,
      label: 'God Mode — video',
      ar,
      meta: { source: 'god-mode', motion, model: matchedModel || model, request_id: requestId },
      created_by: user.id,
    }).select('id').single()
    // Mark the gen_jobs row done so a late fal webhook sees status='done' and
    // skips its duplicate usage-log + results write (webhook is idempotent on
    // status). No-op if no gen_jobs row exists for this request.
    await supabase.from('gen_jobs')
      .update({ status: 'done', payload_url: videoUrl, updated_at: new Date().toISOString() })
      .eq('request_id', requestId).eq('workspace_id', wsId)
    return NextResponse.json({
      ok: true, status: 'done',
      url: videoUrl, model: matchedModel || model, ar, duration, result_id: row?.id, motion,
    })
  }

  // ── TIER 1+2 — Use authoritative URLs if we have them ──
  if (responseUrl) {
    const r = await tryResultFetchUrl(responseUrl)
    if (r) return persistAndRespond(r.videoUrl, model)
  }
  if (statusUrl) {
    const s = await tryStatusFetchUrl(statusUrl)
    if (s.status === 'COMPLETED' && responseUrl) {
      const r = await tryResultFetchUrl(responseUrl)
      if (r) return persistAndRespond(r.videoUrl, model)
    }
    if (s.status === 'FAILED' || s.status === 'CANCELLED') {
      return NextResponse.json({ ok: true, status: 'failed', error: s.hint || 'gen failed' })
    }
    if (s.status === 'IN_QUEUE' || s.status === 'IN_PROGRESS') {
      return NextResponse.json({
        ok: true, status: 'queued',
        fal_status: s.status, queue_position: s.queue_position, fal_hint: s.hint || null,
        used: 'authoritative-status-url',
      })
    }
  }

  // ── TIER 3 — fall back to candidate path probing ──
  // For legacy queued messages submitted before status_url plumbing existed,
  // or in case the authoritative URLs returned unexpected shape.
  const candidates = candidateFalPaths(model)

  async function tryResultFetch(m) {
    return tryResultFetchUrl(`https://queue.fal.run/${m}/requests/${requestId}`)
  }
  async function tryStatusFetch(m) {
    const r = await tryStatusFetchUrl(`https://queue.fal.run/${m}/requests/${requestId}/status`)
    return { ...r, matchedModel: m }
  }

  // PASS 1 — try fetching the result directly across all candidate paths.
  for (const m of candidates) {
    const r = await tryResultFetch(m)
    if (r) return persistAndRespond(r.videoUrl, m)
  }

  // PASS 2 — try /status across candidates.
  let bestStatus = null
  for (const m of candidates) {
    const s = await tryStatusFetch(m)
    if (s.status === 'COMPLETED') {
      const r = await tryResultFetch(m)
      if (r) return persistAndRespond(r.videoUrl, m)
    }
    if (s.status === 'FAILED' || s.status === 'CANCELLED') {
      return NextResponse.json({ ok: true, status: 'failed', error: s.hint || 'gen failed' })
    }
    if (s.status && !bestStatus) bestStatus = s
  }

  return NextResponse.json({
    ok: true,
    status: 'queued',
    fal_status: bestStatus?.status || 'unknown',
    queue_position: bestStatus?.queue_position,
    fal_hint: bestStatus?.hint || null,
    tried_paths: candidates,
  })
}
