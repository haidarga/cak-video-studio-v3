// GET /api/god-mode/gen-status?request_id=...&model=...
//
// Poll a fal.ai queued generation. Used by the chat UI to follow a
// gen_video that returned `type: 'gen_video_queued'` from the agent route
// (when inline polling timed out at 30s but the gen continues server-side).
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

  // Build candidate model paths via centralized helper. See src/lib/fal-paths.js
  // for the full rationale — TL;DR fal queue routing anchors request_ids on
  // CANONICAL paths but accepts aliases at submit, so we may need to probe
  // both directions to find where the request lives.
  const candidates = candidateFalPaths(model)

  async function tryResultFetch(m) {
    const fullRes = await fetch(`https://queue.fal.run/${m}/requests/${requestId}`, {
      headers: { 'Authorization': `Key ${falKey}` },
      cache: 'no-store',
    })
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
    return videoUrl ? { videoUrl, raw: fullData, matchedModel: m } : null
  }

  async function tryStatusFetch(m) {
    const r = await fetch(`https://queue.fal.run/${m}/requests/${requestId}/status`, {
      headers: { 'Authorization': `Key ${falKey}` },
      cache: 'no-store',
    })
    const data = await r.json().catch(() => ({}))
    return { status: data?.status, queue_position: data?.queue_position, hint: data?.detail || data?.error || null, matchedModel: m }
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
    return NextResponse.json({
      ok: true, status: 'done',
      url: videoUrl, model: matchedModel || model, ar, duration, result_id: row?.id, motion,
    })
  }

  // PASS 1 — try fetching the result directly across all candidate paths.
  // If any returns a video URL, we're done. This is the most reliable
  // signal because it sidesteps the /status flakiness entirely.
  for (const m of candidates) {
    const r = await tryResultFetch(m)
    if (r) return persistAndRespond(r.videoUrl, r.matchedModel)
  }

  // PASS 2 — try the status endpoint across candidates. Surface
  // COMPLETED/FAILED states; remember the best status info we got.
  let bestStatus = null
  for (const m of candidates) {
    const s = await tryStatusFetch(m)
    if (s.status === 'COMPLETED') {
      const r = await tryResultFetch(m)
      if (r) return persistAndRespond(r.videoUrl, r.matchedModel)
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
