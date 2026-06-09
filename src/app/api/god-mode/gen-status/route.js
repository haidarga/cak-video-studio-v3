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

  const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
    headers: { 'Authorization': `Key ${falKey}` },
  })
  const statusData = await statusRes.json().catch(() => ({}))

  if (statusData?.status === 'COMPLETED') {
    const fullRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
      headers: { 'Authorization': `Key ${falKey}` },
    })
    const fullData = await fullRes.json().catch(() => ({}))
    const videoUrl = fullData?.video?.url || fullData?.url

    if (videoUrl) {
      // Optional context from query (matches what was returned in the
      // queued response) so we can save the result with proper metadata.
      const ar = url.searchParams.get('ar') || 'auto'
      const duration = parseInt(url.searchParams.get('duration')) || 5
      const motion = url.searchParams.get('motion') || ''
      const personaId = url.searchParams.get('persona_id') || null

      // Insert into results so it shows up in /qc.
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
    return NextResponse.json({ ok: false, error: 'completed but no video url' }, { status: 500 })
  }

  if (statusData?.status === 'FAILED' || statusData?.status === 'CANCELLED') {
    return NextResponse.json({ ok: true, status: 'failed', error: statusData?.error || 'gen failed' })
  }

  // Still in queue or processing — return progress info.
  return NextResponse.json({
    ok: true,
    status: 'queued',
    fal_status: statusData?.status || 'unknown',
    queue_position: statusData?.queue_position,
  })
}
