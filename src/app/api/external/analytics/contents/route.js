// GET /api/external/analytics/contents?from&to&brandId&stage&format&limit&offset
//
// Paged content_pipeline rows for the dashboard table. Brand and persona names
// are resolved here so the caller does not need a second round-trip.

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
  const stage = url.searchParams.get('stage') || null
  const format = url.searchParams.get('format') || null
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
    .from('content_pipeline')
    .select(
      'id, brand_id, persona_id, stage, content_type, content_format, production_url, performance_score, batch_number, week_number, scheduled_at, posted_at, created_at, updated_at',
      { count: 'exact' }
    )
    .gte('created_at', range.from)
    .lte('created_at', range.to)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (brandId) query = query.eq('brand_id', brandId)
  if (stage) query = query.eq('stage', stage)
  if (format) query = query.eq('content_format', format)

  const [rowsRes, brandRes, personaRes] = await Promise.all([
    query,
    supabase.from('brands').select('id, name'),
    supabase.from('personas').select('id, name'),
  ])

  const failed = rowsRes.error || brandRes.error || personaRes.error
  if (failed) {
    return NextResponse.json(
      { ok: false, error: `Contents query failed (500) — ${failed.message}` },
      { status: 500 }
    )
  }

  const brandName = new Map((brandRes.data ?? []).map((b) => [b.id, b.name]))
  const personaName = new Map((personaRes.data ?? []).map((p) => [p.id, p.name]))
  const total = rowsRes.count ?? 0

  return NextResponse.json({
    ok: true,
    range,
    total,
    hasMore: offset + (rowsRes.data?.length ?? 0) < total,
    items: (rowsRes.data ?? []).map((r) => ({
      id: r.id,
      brandId: r.brand_id,
      brandName: r.brand_id ? (brandName.get(r.brand_id) ?? null) : null,
      personaId: r.persona_id,
      personaName: r.persona_id ? (personaName.get(r.persona_id) ?? null) : null,
      stage: r.stage,
      contentType: r.content_type,
      contentFormat: r.content_format,
      productionUrl: r.production_url,
      performanceScore: r.performance_score,
      batchNumber: r.batch_number,
      weekNumber: r.week_number,
      scheduledAt: r.scheduled_at,
      postedAt: r.posted_at,
      createdAt: r.created_at,
    })),
  })
}
