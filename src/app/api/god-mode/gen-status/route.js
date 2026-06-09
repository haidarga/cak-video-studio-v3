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

  // Try the status endpoint first. fal returns { status: "IN_QUEUE" |
  // "IN_PROGRESS" | "COMPLETED" | "FAILED" }. If status check returns
  // anything weird (e.g. fal aliased the endpoint and routed status to a
  // different path), we fall back to fetching the result directly as a
  // probe — if it returns a video URL, the gen IS done regardless of what
  // /status said.
  const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
    headers: { 'Authorization': `Key ${falKey}` },
    cache: 'no-store',
  })
  const statusData = await statusRes.json().catch(() => ({}))
  const falStatus = statusData?.status

  const ar = url.searchParams.get('ar') || 'auto'
  const duration = parseInt(url.searchParams.get('duration')) || 5
  const motion = url.searchParams.get('motion') || ''
  const personaId = url.searchParams.get('persona_id') || null

  async function fetchResultAndPersist() {
    const fullRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
      headers: { 'Authorization': `Key ${falKey}` },
      cache: 'no-store',
    })
    const fullData = await fullRes.json().catch(() => ({}))
    // Try every common shape fal uses across video models.
    const videoUrl =
      fullData?.video?.url ||
      fullData?.video_url ||
      fullData?.output?.video?.url ||
      fullData?.output?.url ||
      fullData?.url ||
      (Array.isArray(fullData?.videos) && fullData.videos[0]?.url) ||
      null
    if (!videoUrl) return null

    const { data: row } = await supabase.from('results').insert({
      workspace_id: wsId,
      persona_id: personaId,
      type: 'video', url: videoUrl,
      label: 'God Mode — video',
      ar,
      meta: { source: 'god-mode', motion, model, request_id: requestId },
      created_by: user.id,
    }).select('id').single()

    return NextResponse.json({
      ok: true,
      status: 'done',
      url: videoUrl, model, ar, duration, result_id: row?.id, motion,
    })
  }

  if (falStatus === 'COMPLETED') {
    const r = await fetchResultAndPersist()
    if (r) return r
    return NextResponse.json({ ok: false, error: 'completed but no video url in fal response' }, { status: 500 })
  }

  if (falStatus === 'FAILED' || falStatus === 'CANCELLED') {
    return NextResponse.json({ ok: true, status: 'failed', error: statusData?.error || statusData?.detail || 'gen failed' })
  }

  // If status was unreadable (no status field, HTTP error response, weird shape),
  // probe the result endpoint anyway — fal sometimes serves results even when
  // /status returns 404 or alias mismatch.
  if (!falStatus || falStatus === 'unknown') {
    const r = await fetchResultAndPersist()
    if (r) return r
  }

  return NextResponse.json({
    ok: true,
    status: 'queued',
    fal_status: falStatus || 'unknown',
    queue_position: statusData?.queue_position,
    // surface a hint if fal returned an error-shape response from /status
    fal_hint: statusData?.detail || statusData?.error || null,
  })
}
