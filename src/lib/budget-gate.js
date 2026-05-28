// Budget hard-limit gate. Called from expensive API routes BEFORE the actual
// 3rd-party call. Blocks the request if the workspace's daily or monthly
// spend (current + projected) would exceed limits in budget_settings.
//
// budget_settings has defaults (daily=$50, monthly=$500); workspace can edit
// via /api/workspace/budget. To disable a limit, set it to 0 (treated as
// "no limit").
//
// Usage:
//   import { assertBudget } from '@/lib/budget-gate'
//   const gate = await assertBudget(supabase, wsId, { projectedUsd: 0.25 })
//   if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

import { createAdminClient } from '@/lib/supabase/admin'

const DEFAULT_LIMITS = { daily_limit_usd: 50, monthly_limit_usd: 500, alert_at_pct: 80 }

export async function assertBudget(_supabase, workspaceId, { projectedUsd = 0 } = {}) {
  if (!workspaceId) return { ok: false, reason: 'No workspace' }

  // Use the admin client for the budget check so that an RLS hiccup can't
  // accidentally let an over-budget request through (fail-closed on read).
  const admin = createAdminClient()
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [{ data: monthRows, error: usageErr }, { data: limitsRow }] = await Promise.all([
    admin.from('usage_log').select('cost_usd, created_at').eq('workspace_id', workspaceId).gte('created_at', startOfMonth).limit(5000),
    admin.from('budget_settings').select('*').eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (usageErr) {
    // Fail-closed: if we can't read usage, refuse the call rather than risk
    // burning unbounded $.
    return { ok: false, reason: 'budget read failed: ' + usageErr.message }
  }
  const limits = limitsRow || DEFAULT_LIMITS
  const dailyLimit = parseFloat(limits.daily_limit_usd || 0)
  const monthlyLimit = parseFloat(limits.monthly_limit_usd || 0)

  const monthSpent = (monthRows || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0)
  const todaySpent = (monthRows || [])
    .filter((r) => r.created_at >= startOfDay)
    .reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0)

  const dailyAfter = todaySpent + projectedUsd
  const monthlyAfter = monthSpent + projectedUsd

  const state = {
    today: todaySpent, month: monthSpent,
    projected: projectedUsd, dailyAfter, monthlyAfter,
    dailyLimit, monthlyLimit,
    dailyPct: dailyLimit > 0 ? (dailyAfter / dailyLimit) * 100 : 0,
    monthlyPct: monthlyLimit > 0 ? (monthlyAfter / monthlyLimit) * 100 : 0,
  }

  // A zero limit = unlimited (intentional escape hatch for the workspace owner)
  if (dailyLimit > 0 && dailyAfter > dailyLimit) {
    return { ok: false, reason: `Daily budget habis — $${todaySpent.toFixed(2)} dipakai, projected +$${projectedUsd.toFixed(2)} > limit $${dailyLimit.toFixed(2)}. Naikkin limit di /settings → Budget atau tunggu besok.`, ...state }
  }
  if (monthlyLimit > 0 && monthlyAfter > monthlyLimit) {
    return { ok: false, reason: `Monthly budget habis — $${monthSpent.toFixed(2)} dipakai, projected +$${projectedUsd.toFixed(2)} > limit $${monthlyLimit.toFixed(2)}. Naikkin limit di /settings → Budget atau tunggu bulan depan.`, ...state }
  }
  return { ok: true, ...state }
}

// Estimate cost from a fal.ai submit payload. Looks at model name + the
// duration/num_frames hint in input. Returns 0 if not recognized — the gate
// still runs but only checks already-spent, not projected.
import { imageCost, videoCost } from '@/lib/cost-table'

export function estimateFalCost(model, input = {}) {
  if (!model) return 0
  // Video models have duration in seconds (kling/seedance) or are fixed length
  if (/video|veo3|kling|seedance|wan/i.test(model)) {
    const duration = parseFloat(input.duration || input.duration_seconds || input.length_seconds || 5)
    return videoCost(model, duration)
  }
  return imageCost(model)
}
