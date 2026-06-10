// GET /api/gen-jobs/failed?hours=24
//
// List recent failed gen_jobs in the caller's workspace. Used by the
// Variant Forge / mass-gen UI to surface a "Retry failed (N)" affordance
// without scanning every job. Default window is 24 hours so users see
// recent work without endless scrollback.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

export const runtime = 'nodejs'

export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const url = new URL(req.url)
  const hours = Math.max(1, Math.min(168, parseInt(url.searchParams.get('hours')) || 24))
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()

  const { data, error } = await supabase
    .from('gen_jobs')
    .select('request_id, model, kind, error, meta, retry_count, parent_request_id, created_at')
    .eq('workspace_id', wsId)
    .eq('status', 'error')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  // Group by parent_request_id so user sees "1 original + N retry attempts"
  // collapsed, not the same gen listed multiple times.
  const grouped = {}
  for (const job of data || []) {
    const key = job.parent_request_id || job.request_id
    if (!grouped[key]) grouped[key] = { root: key, attempts: [] }
    grouped[key].attempts.push(job)
  }
  const groups = Object.values(grouped).map((g) => ({
    ...g,
    latest_request_id: g.attempts[0].request_id,
    latest_error: g.attempts[0].error,
    retry_count: g.attempts[0].retry_count || 0,
    model: g.attempts[0].model,
    kind: g.attempts[0].kind,
    created_at: g.attempts[g.attempts.length - 1].created_at,
  }))

  return NextResponse.json({ ok: true, since, hours, groups, total_failed: data?.length || 0 })
}
