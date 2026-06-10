// GET /api/usage/breakdown?window=30d
//
// Per-workspace usage analytics. Aggregates usage_log into useful slices
// the existing "total today/month" widget doesn't show:
//   - by_kind: image_gen / video_gen / transcribe / etc — what types of
//     calls account for spend
//   - by_model: which fal/Gemini models eat the most budget
//   - by_user: per-team-member spend (for shared workspaces)
//   - by_day: daily trend (last N days) for spotting spikes
//   - top_persona: which personas drove the most gen volume (joined via
//     meta.persona_id when present)
//
// Window: ?window=7d|30d|90d|all (default 30d, max 90d for query cost)

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

export const runtime = 'nodejs'

function parseWindow(w) {
  if (w === '7d') return 7 * 24 * 3600 * 1000
  if (w === '30d') return 30 * 24 * 3600 * 1000
  if (w === '90d') return 90 * 24 * 3600 * 1000
  if (w === 'today') return 24 * 3600 * 1000
  return 30 * 24 * 3600 * 1000
}

export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const url = new URL(req.url)
  const window = url.searchParams.get('window') || '30d'
  const windowMs = parseWindow(window)
  const since = new Date(Date.now() - windowMs).toISOString()

  // Pull all usage rows in window. usage_log is workspace-scoped via RLS
  // so this only sees rows the caller is allowed to see.
  const { data: rows, error } = await supabase
    .from('usage_log')
    .select('kind, model, cost_usd, user_id, meta, created_at')
    .eq('workspace_id', wsId)
    .gte('created_at', since)
    .limit(20000)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  // Aggregate. Keep it lean — JS server-side rather than another SQL query.
  const byKind = {}
  const byModel = {}
  const byUser = {}
  const byDay = {}
  const byPersona = {}
  let total = 0

  for (const r of rows || []) {
    const cost = parseFloat(r.cost_usd || 0)
    total += cost
    const day = r.created_at.slice(0, 10) // YYYY-MM-DD

    byKind[r.kind] = (byKind[r.kind] || 0) + cost
    if (r.model) byModel[r.model] = (byModel[r.model] || 0) + cost
    byUser[r.user_id] = (byUser[r.user_id] || 0) + cost
    byDay[day] = (byDay[day] || 0) + cost
    const pid = r.meta?.persona_id
    if (pid) byPersona[pid] = (byPersona[pid] || 0) + cost
  }

  // Sort + cap each breakdown to top 10 so payload stays tight.
  const topify = (obj, n = 10) => Object.entries(obj)
    .map(([k, v]) => ({ key: k, cost_usd: Math.round(v * 10000) / 10000 }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, n)

  // Day chart — chronological, not sorted by cost
  const dayChart = Object.entries(byDay)
    .map(([d, c]) => ({ day: d, cost_usd: Math.round(c * 10000) / 10000 }))
    .sort((a, b) => a.day.localeCompare(b.day))

  // Resolve persona names for the top entries (small follow-up query).
  const topPersonaIds = topify(byPersona, 5).map((p) => p.key)
  let personaNameMap = {}
  if (topPersonaIds.length) {
    const { data: pNames } = await supabase
      .from('personas').select('id, name').in('id', topPersonaIds)
    for (const p of pNames || []) personaNameMap[p.id] = p.name
  }
  const topPersonas = topify(byPersona, 5).map((p) => ({
    persona_id: p.key,
    persona_name: personaNameMap[p.key] || '(unknown)',
    cost_usd: p.cost_usd,
  }))

  return NextResponse.json({
    ok: true,
    window,
    since,
    total_cost_usd: Math.round(total * 10000) / 10000,
    total_calls: rows?.length || 0,
    by_kind: topify(byKind),
    by_model: topify(byModel),
    by_user: topify(byUser),
    by_day: dayChart,
    top_personas: topPersonas,
  })
}
