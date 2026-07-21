// GET /api/external/analytics/overview?from&to&brandId
//
// Read-only analytics feed consumed server-to-server by cakai-ugc-backend, which
// renders it at /dashboard/cak-gacor. Uses the service_role client because the
// caller is not a Supabase user — authorisation is the shared secret instead.
//
// Cost here is REAL: usage_log stores cost_usd per billed call. Only the
// per-brand split is derived, because usage_log records no persona or brand.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnalyticsKey } from '@/lib/analytics-auth'
import { parseRange, buildDimensions, RangeError } from '@/lib/analytics-aggregate'
import { aggregateCost, allocateCostByBrand } from '@/lib/analytics-cost'
import {
  aggregateVideo,
  aggregatePublishing,
  aggregateOps,
} from '@/lib/analytics-video'
import { fetchAllRows } from '@/lib/analytics-fetch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const inRange = (q, column = 'created_at') =>
    q.gte(column, range.from).lte(column, range.to).order(column, { ascending: true })

  const [brandRes, personaRes] = await Promise.all([
    supabase.from('brands').select('id, name').order('name'),
    supabase.from('personas').select('id, name, brand_id').order('name'),
  ])
  if (brandRes.error || personaRes.error) {
    const failed = brandRes.error || personaRes.error
    return NextResponse.json(
      { ok: false, error: `Analytics query failed (500) — ${failed.message}` },
      { status: 500 }
    )
  }

  // Only results and scheduled_posts reach a brand, via persona_id. Everything
  // else in this schema is workspace-scoped, so a brand filter narrows the
  // output tables and leaves cost to be allocated from those.
  const personaIds = brandId
    ? (personaRes.data ?? []).filter((p) => p.brand_id === brandId).map((p) => p.id)
    : null

  const [usageRes, resultRes, basisRes, genJobRes, factoryRes, postRes, errorRes, jobRes] =
    await Promise.all([
      fetchAllRows(() =>
        inRange(supabase.from('usage_log').select('kind, model, cost_usd, created_at'))
      ),
      fetchAllRows(() => {
        const q = inRange(
          supabase
            .from('results')
            .select('persona_id, type, qc_status, url, group_label, created_at')
        )
        return personaIds ? q.in('persona_id', personaIds) : q
      }),
      // Cost allocation must always weigh a brand against ALL output in the
      // window. Allocating on the brand-filtered set would hand that brand 100%
      // of the workspace spend.
      personaIds
        ? fetchAllRows(() =>
            inRange(supabase.from('results').select('persona_id, type, created_at'))
          )
        : { data: null, error: null },
      fetchAllRows(() =>
        inRange(
          supabase
            .from('gen_jobs')
            .select('kind, model, status, duration_seconds, retry_count, created_at')
        )
      ),
      fetchAllRows(() => inRange(supabase.from('factory_runs').select('status, created_at'))),
      fetchAllRows(() => {
        const q = inRange(
          supabase
            .from('scheduled_posts')
            .select('persona_id, status, target_platform, posted_at, scheduled_for, created_at')
        )
        return personaIds ? q.in('persona_id', personaIds) : q
      }),
      fetchAllRows(() =>
        inRange(supabase.from('error_log').select('level, source, message, created_at'))
      ),
      fetchAllRows(() => inRange(supabase.from('jobs').select('status, created_at'))),
    ])

  const failed =
    usageRes.error ||
    resultRes.error ||
    basisRes.error ||
    genJobRes.error ||
    factoryRes.error ||
    postRes.error ||
    errorRes.error ||
    jobRes.error
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
    cost: {
      ...aggregateCost(usageRes.data),
      // Derived, not measured — usage_log has no brand column. Always computed
      // over every brand so the shares stay comparable under a brand filter.
      byBrand: allocateCostByBrand(
        usageRes.data,
        basisRes.data ?? resultRes.data,
        personaRes.data,
        brandRes.data
      ),
    },
    video: aggregateVideo({
      results: resultRes.data,
      genJobs: genJobRes.data,
      factoryRuns: factoryRes.data,
      personas: personaRes.data,
      brands: brandRes.data,
    }),
    publishing: aggregatePublishing(postRes.data),
    ops: aggregateOps({ errors: errorRes.data, jobs: jobRes.data }),
    dimensions: buildDimensions(brandRes.data, personaRes.data),
  })
}
