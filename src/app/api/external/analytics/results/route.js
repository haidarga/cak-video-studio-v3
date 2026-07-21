// GET /api/external/analytics/results?from&to&brandId&type&qcStatus&limit&offset
//
// Paged generated output (videos + images) for the dashboard table.

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
  const brandId = url.searchParams.get('brandId') || null
  const type = url.searchParams.get('type') || null
  const qcStatus = url.searchParams.get('qcStatus') || null
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

  const [brandRes, personaRes] = await Promise.all([
    supabase.from('brands').select('id, name'),
    supabase.from('personas').select('id, name, brand_id'),
  ])
  if (brandRes.error || personaRes.error) {
    const failed = brandRes.error || personaRes.error
    return NextResponse.json(
      { ok: false, error: `Results query failed (500) — ${failed.message}` },
      { status: 500 }
    )
  }

  let query = supabase
    .from('results')
    .select(
      'id, persona_id, type, url, label, ar, group_label, qc_status, created_at',
      { count: 'exact' }
    )
    .gte('created_at', range.from)
    .lte('created_at', range.to)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (brandId) {
    const personaIds = (personaRes.data ?? [])
      .filter((p) => p.brand_id === brandId)
      .map((p) => p.id)
    // An empty .in() list is a syntax error upstream, so short-circuit instead.
    if (!personaIds.length) {
      return NextResponse.json({ ok: true, range, total: 0, hasMore: false, items: [] })
    }
    query = query.in('persona_id', personaIds)
  }
  if (type) query = query.eq('type', type)
  if (qcStatus) query = query.eq('qc_status', qcStatus)

  const rowsRes = await query
  if (rowsRes.error) {
    return NextResponse.json(
      { ok: false, error: `Results query failed (500) — ${rowsRes.error.message}` },
      { status: 500 }
    )
  }

  const brandNameById = new Map((brandRes.data ?? []).map((b) => [b.id, b.name]))
  const personaById = new Map((personaRes.data ?? []).map((p) => [p.id, p]))
  const total = rowsRes.count ?? 0

  return NextResponse.json({
    ok: true,
    range,
    total,
    hasMore: offset + (rowsRes.data?.length ?? 0) < total,
    items: (rowsRes.data ?? []).map((r) => {
      const persona = r.persona_id ? personaById.get(r.persona_id) : null
      return {
        id: r.id,
        personaId: r.persona_id,
        personaName: persona?.name ?? null,
        brandId: persona?.brand_id ?? null,
        brandName: persona?.brand_id ? (brandNameById.get(persona.brand_id) ?? null) : null,
        type: r.type,
        url: r.url,
        label: r.label,
        aspectRatio: r.ar,
        groupLabel: r.group_label,
        qcStatus: r.qc_status,
        createdAt: r.created_at,
      }
    }),
  })
}
