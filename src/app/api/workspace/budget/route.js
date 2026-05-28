import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

// GET — current budget_settings for the active workspace.
// PATCH — update daily_limit_usd / monthly_limit_usd / alert_at_pct.
// 0 = unlimited (treated as no limit by the gate).
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
  const { data } = await supabase.from('budget_settings').select('*').eq('workspace_id', wsId).maybeSingle()
  return NextResponse.json({
    ok: true,
    workspace_id: wsId,
    daily_limit_usd: data?.daily_limit_usd ?? 50,
    monthly_limit_usd: data?.monthly_limit_usd ?? 500,
    alert_at_pct: data?.alert_at_pct ?? 80,
  })
}

export async function PATCH(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const body = await req.json()
  const patch = { workspace_id: wsId, updated_at: new Date().toISOString() }
  for (const k of ['daily_limit_usd', 'monthly_limit_usd', 'alert_at_pct']) {
    if (k in body) {
      const n = Number(body[k])
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ ok: false, error: `${k} harus angka >= 0` }, { status: 400 })
      }
      patch[k] = n
    }
  }
  // Upsert so workspace doesn't need an init row to set limits the first time.
  const { error } = await supabase.from('budget_settings').upsert(patch, { onConflict: 'workspace_id' })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
