// GET /api/external/analytics/overview?from&to&brandId
//
// Read-only analytics feed consumed server-to-server by cakai-ugc-backend, which
// renders it at /dashboard/cak-gacor. Uses the service_role client because the
// caller is not a Supabase user — authorisation is the shared secret instead.
//
// Token counts are returned raw; the USD estimate is applied downstream so the
// price table can change without redeploying this app.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnalyticsKey } from '@/lib/analytics-auth'
import {
  parseRange,
  aggregateCost,
  buildDimensions,
  RangeError,
} from '@/lib/analytics-aggregate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST caps a single response at db-max-rows (1000 here), so a plain
// .limit() silently truncates and every total comes out wrong. Page instead.
const PAGE_SIZE = 1000
const MAX_ROWS = 20000

async function fetchAllRows(buildQuery) {
  const rows = []
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return { data: rows, error: null }
}

export async function GET(req) {
  const denied = requireAnalyticsKey(req)
  if (denied) return denied

  const url = new URL(req.url)
  const brandId = url.searchParams.get('brandId') || null

  let range
  try {
    range = parseRange({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    })
  } catch (err) {
    if (err instanceof RangeError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 })
    }
    throw err
  }

  const supabase = createAdminClient()

  const buildAgentQuery = () => {
    const q = supabase
      .from('agent_logs')
      .select('agent_name, run_type, status, tokens_used, duration_ms, brand_id, created_at')
      .gte('created_at', range.from)
      .lte('created_at', range.to)
      .order('created_at', { ascending: true })
    return brandId ? q.eq('brand_id', brandId) : q
  }

  const [agentRes, brandRes, personaRes] = await Promise.all([
    fetchAllRows(buildAgentQuery),
    supabase.from('brands').select('id, name').order('name'),
    supabase.from('personas').select('id, name').order('name'),
  ])

  const failed = agentRes.error || brandRes.error || personaRes.error
  if (failed) {
    return NextResponse.json(
      { ok: false, error: `Analytics query failed (500) — ${failed.message}` },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok: true,
    range,
    brandId,
    cost: aggregateCost(agentRes.data, brandRes.data),
    dimensions: buildDimensions(brandRes.data, personaRes.data),
  })
}
