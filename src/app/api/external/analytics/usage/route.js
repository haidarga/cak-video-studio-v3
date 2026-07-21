// GET /api/external/analytics/usage?from&to&kind&model&limit&offset
//
// Paged usage_log rows — the itemised cost ledger behind the headline totals.
// No brand filter: usage_log records no persona or brand (see the overview route).

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnalyticsKey } from '@/lib/analytics-auth'
import { parseRange, RangeError } from '@/lib/analytics-aggregate'
import { parsePaging } from '@/lib/analytics-util'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const denied = requireAnalyticsKey(req)
  if (denied) return denied

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') || null
  const model = url.searchParams.get('model') || null
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
    .from('usage_log')
    .select('id, kind, model, cost_usd, meta, created_at', { count: 'exact' })
    .gte('created_at', range.from)
    .lte('created_at', range.to)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (kind) query = query.eq('kind', kind)
  if (model) query = query.eq('model', model)

  const rowsRes = await query
  if (rowsRes.error) {
    return NextResponse.json(
      { ok: false, error: `Usage query failed (500) — ${rowsRes.error.message}` },
      { status: 500 }
    )
  }

  const total = rowsRes.count ?? 0

  return NextResponse.json({
    ok: true,
    range,
    total,
    hasMore: offset + (rowsRes.data?.length ?? 0) < total,
    items: (rowsRes.data ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      model: r.model,
      costUsd: Number.parseFloat(r.cost_usd ?? 0) || 0,
      durationSeconds: r.meta?.duration ?? null,
      via: r.meta?.via ?? null,
      createdAt: r.created_at,
    })),
  })
}
