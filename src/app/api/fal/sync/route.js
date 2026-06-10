// POST /api/fal/sync — sync fal.run for IMAGE gen.
//
// Why this exists:
// /api/fal/submit uses the queue + webhook + Supabase realtime pattern
// which is necessary for VIDEO gen (>60s = Vercel function timeout).
// But for image gen normally <30s, the queue overhead adds 45-80s on
// top of actual gen time:
//   - fal queue scheduling delay
//   - Webhook POST latency back to our Vercel function
//   - Supabase realtime broadcast hop
//   - Browser realtime subscription + 45s fallback poll interval
//
// User saw god-mode (falCall direct sync) finish in 10-15s while
// /generate (falRun webhook) took 100s for the SAME model + refs.
// This endpoint kills the overhead by doing the fal.run sync call
// inline — single HTTP response, no queue/webhook involved.
//
// Still preserves what /api/fal/submit gave us:
//   - Budget gate (refuse if over daily/monthly cap)
//   - gen_jobs row insertion (for usage tracking + retry support)
//   - canonical fal path resolution
//
// Caller: falRun in src/lib/fal-client.js — detects image-kind model
// and routes here; video gen keeps the webhook path.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'
import { canonicalFalPath } from '@/lib/fal-paths'

export const runtime = 'nodejs'
export const maxDuration = 60 // fal image gen max ~45s; 60s gives slack

async function getFalKey(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspaces').select('fal_key').eq('id', workspaceId).maybeSingle()
  return data?.fal_key || process.env.FAL_KEY || ''
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    const { model: rawModel, input, meta } = await req.json()
    if (!rawModel) throw new Error('model required')

    const wsId = await getActiveWorkspace(supabase, user)
    const projected = estimateFalCost(rawModel, input || {})
    const gate = await assertBudget(supabase, wsId, { projectedUsd: projected })
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

    const falKey = await getFalKey(supabase, wsId)
    if (!falKey) throw new Error('no fal.ai key configured')

    const model = canonicalFalPath(rawModel)
    const t0 = Date.now()

    // Sync fal.run — blocks until completion. fal returns the full result
    // payload (images array / image / video URL depending on model).
    const r = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = data?.detail || data?.error || `fal.ai ${r.status}`
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    const durationMs = Date.now() - t0

    // Record to gen_jobs as if a webhook had completed it — keeps usage
    // analytics + retry-by-request_id flow consistent across both code paths.
    // Synthetic request_id since sync calls don't return one from fal.run.
    const admin = createAdminClient()
    const syntheticRequestId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const payloadUrl =
      data?.images?.[0]?.url ||
      data?.image?.url ||
      data?.url ||
      null

    await admin.from('gen_jobs').insert({
      request_id: syntheticRequestId,
      workspace_id: wsId,
      user_id: user.id,
      kind: 'image',
      model,
      status: 'done',
      payload_url: payloadUrl,
      payload: data,
      input: input || {},
      meta: { ...(meta || {}), raw_model: rawModel !== model ? rawModel : undefined, duration_ms: durationMs, sync: true },
    })

    return NextResponse.json({ ok: true, request_id: syntheticRequestId, ...data, _duration_ms: durationMs })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
