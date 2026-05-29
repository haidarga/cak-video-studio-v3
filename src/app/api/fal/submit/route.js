import { NextResponse } from 'next/server'
import { falSubmit } from '@/lib/fal-server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'

// Compose the absolute webhook URL fal will POST to when the job finishes.
// We derive from req headers so this works on any Vercel preview / prod deploy
// without hard-coding the URL via env vars. WEBHOOK_SECRET (env) gates the
// receiver so random POSTs can't fake completions.
function webhookUrlFromReq(req) {
  // x-forwarded-* set by Vercel edge; fallback to request URL host for local dev.
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (!host) return null
  const secret = process.env.FAL_WEBHOOK_SECRET || ''
  const qs = secret ? `?secret=${encodeURIComponent(secret)}` : ''
  return `${proto}://${host}/api/fal/webhook${qs}`
}

// Heuristic — duration in seconds for cost calc.
function extractDuration(input = {}) {
  const d = parseFloat(input.duration || input.duration_seconds || input.length_seconds || 0)
  return Number.isFinite(d) && d > 0 ? d : null
}

function classify(model = '') {
  if (/video|veo3|kling|seedance|wan|grok-imagine/i.test(model)) return 'video'
  return 'image'
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const { model, input, meta } = await req.json()
    if (!model) throw new Error('model required')

    // Hard budget gate — refuse expensive gens once limit is hit.
    const wsId = await getActiveWorkspace(supabase, user)
    const projected = estimateFalCost(model, input || {})
    const gate = await assertBudget(supabase, wsId, { projectedUsd: projected })
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

    // Submit with webhookUrl so fal POSTs us when done — replaces polling.
    const webhookUrl = webhookUrlFromReq(req)
    const result = await falSubmit(model, input, { webhookUrl })

    // Record job row immediately. Browser will subscribe by request_id and
    // react when webhook flips this to done/error.
    const admin = createAdminClient()
    const kind = classify(model)
    const duration_seconds = kind === 'video' ? extractDuration(input) : null
    await admin.from('gen_jobs').insert({
      request_id: result.request_id,
      workspace_id: wsId,
      user_id: user.id,
      kind, model,
      status: 'pending',
      duration_seconds,
      meta: meta || {},
    })

    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
