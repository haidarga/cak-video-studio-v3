import { NextResponse } from 'next/server'
import { falSubmit } from '@/lib/fal-server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'
import { canonicalFalPath } from '@/lib/fal-paths'

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
  // FAIL-CLOSED, matching /api/fal/webhook which 503s when the secret is unset.
  // The old behaviour registered a secret-less callback URL that the webhook
  // then rejected — so fal called us, got refused, gave up, and the gen_jobs row
  // sat at 'pending' forever with the result stranded on fal. Returning null
  // makes the caller submit WITHOUT a webhook and rely on polling, which is at
  // least honest, instead of registering a callback that can never succeed.
  if (!secret) {
    console.error('[fal/submit] FAL_WEBHOOK_SECRET not set — submitting without a webhook (polling only). Set it in Vercel env to enable server-side result ingestion.')
    return null
  }
  return `${proto}://${host}/api/fal/webhook?secret=${encodeURIComponent(secret)}`
}

// Heuristic — duration in seconds for cost calc.
function extractDuration(input = {}) {
  const d = parseFloat(input.duration || input.duration_seconds || input.length_seconds || 0)
  return Number.isFinite(d) && d > 0 ? d : null
}

function classify(model = '') {
  if (/video|veo3|kling|seedance|wan|grok-imagine|gemini-omni/i.test(model)) return 'video'
  return 'image'
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const { model: rawModel, input, meta } = await req.json()
    if (!rawModel) throw new Error('model required')

    // Canonicalize at submit so gen_jobs.model is ALWAYS the wire-correct
    // path. Later status pollers (webhook, gen-status, manual fetches) can
    // trust this row's `model` column without re-running alias resolution.
    // See src/lib/fal-paths.js for the alias→canonical map and rationale.
    const model = canonicalFalPath(rawModel)

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
    // STORE status_url / response_url in meta — fall-back pollers can use
    // them directly without path-guessing (see src/lib/fal-paths.js).
    const admin = createAdminClient()
    const kind = classify(model)
    const duration_seconds = kind === 'video' ? extractDuration(input) : null
    const { error: insErr } = await admin.from('gen_jobs').insert({
      request_id: result.request_id,
      workspace_id: wsId,
      user_id: user.id,
      kind, model,
      status: 'pending',
      duration_seconds,
      // Store the input payload so failed jobs can be retried via
      // /api/gen-jobs/retry without callers having to re-build the
      // payload from scratch.
      input: input || {},
      meta: {
        ...(meta || {}),
        raw_model: rawModel !== model ? rawModel : undefined,
        status_url: result.status_url,
        response_url: result.response_url,
      },
    })

    // Insert failure used to be SILENT — the fal job was already submitted,
    // the webhook would later find no row to update, and the UI sat on
    // "pending/unknown" forever with zero clue. Classic cause: wrong
    // SUPABASE_SERVICE_ROLE_KEY (anon key works → login fine, admin writes
    // fail). Surface it loudly with the request_id so the gen is recoverable.
    if (insErr) {
      return NextResponse.json({
        ok: false,
        error: `Gen UDAH ke-submit ke fal (request_id ${result.request_id}) tapi gagal nyatet job ke DB: ${insErr.message}. Kemungkinan SUPABASE_SERVICE_ROLE_KEY di Vercel salah/lama. Video tetap jalan di fal — cek fal.ai dashboard.`,
        request_id: result.request_id,
      }, { status: 500 })
    }

    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
