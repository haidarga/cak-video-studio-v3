// GET /api/external/analytics/agent-runs?from&to&brandId&status&agent&limit&offset
//
// Paged agent_logs rows for the dashboard's ops table.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnalyticsKey } from '@/lib/analytics-auth'
import { parseRange, RangeError } from '@/lib/analytics-aggregate'
import { parsePaging } from '@/lib/analytics-content'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const denied = requireAnalyticsKey(req)
  if (denied) return denied

  const url = new URL(req.url)
  const brandId = url.searchParams.get('brandId') || null
  const status = url.searchParams.get('status') || null
  const agent = url.searchParams.get('agent') || null
  const { limit, offset } = parsePaging({
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
  })

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

  let query = supabase
    .from('agent_logs')
    .select(
      'id, agent_name, run_type, status, brand_id, tokens_used, duration_ms, error_message, created_at',
      { count: 'exact' }
    )
    .gte('created_at', range.from)
    .lte('created_at', range.to)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (brandId) query = query.eq('brand_id', brandId)
  if (status) query = query.eq('status', status)
  if (agent) query = query.eq('agent_name', agent)

  const [rowsRes, brandRes] = await Promise.all([
    query,
    supabase.from('brands').select('id, name'),
  ])

  const failed = rowsRes.error || brandRes.error
  if (failed) {
    return NextResponse.json(
      { ok: false, error: `Agent runs query failed (500) — ${failed.message}` },
      { status: 500 }
    )
  }

  const brandName = new Map((brandRes.data ?? []).map((b) => [b.id, b.name]))
  const total = rowsRes.count ?? 0

  return NextResponse.json({
    ok: true,
    range,
    total,
    hasMore: offset + (rowsRes.data?.length ?? 0) < total,
    items: (rowsRes.data ?? []).map((r) => ({
      id: r.id,
      agent: r.agent_name,
      runType: r.run_type,
      status: r.status,
      brandId: r.brand_id,
      brandName: r.brand_id ? (brandName.get(r.brand_id) ?? null) : null,
      tokensUsed: r.tokens_used,
      durationMs: r.duration_ms,
      error: r.error_message,
      createdAt: r.created_at,
    })),
  })
}
