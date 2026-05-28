import { NextResponse } from 'next/server'
import { falSubmit } from '@/lib/fal-server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const { model, input } = await req.json()
    if (!model) throw new Error('model required')

    // Hard budget gate — refuse expensive gens once limit is hit.
    const wsId = await getActiveWorkspace(supabase, user)
    const projected = estimateFalCost(model, input || {})
    const gate = await assertBudget(supabase, wsId, { projectedUsd: projected })
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

    const result = await falSubmit(model, input)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
