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
import { aggregateContent } from '@/lib/analytics-content'
import { aggregateAccounts, aggregateKpi } from '@/lib/analytics-accounts'
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

  const buildAgentQuery = () => {
    const q = supabase
      .from('agent_logs')
      .select('agent_name, run_type, status, tokens_used, duration_ms, brand_id, created_at')
      .gte('created_at', range.from)
      .lte('created_at', range.to)
      .order('created_at', { ascending: true })
    return brandId ? q.eq('brand_id', brandId) : q
  }

  const buildPipelineQuery = () => {
    const q = supabase
      .from('content_pipeline')
      .select('stage, content_type, content_format, production_url, performance_score, posted_at, created_at')
      .gte('created_at', range.from)
      .lte('created_at', range.to)
      .order('created_at', { ascending: true })
    return brandId ? q.eq('brand_id', brandId) : q
  }

  // sw_naskah / sw_gen_jobs / sw_qc_flags carry no brand column, and the
  // brief_id -> brand chain is broken (sw_briefs is empty), so they cannot be
  // scoped to a brand. Skip them entirely rather than pass off global counts
  // as brand-specific.
  const brandScopable = !brandId

  const [agentRes, pipelineRes, naskahRes, genJobRes, qcRes, brandRes, personaRes] =
    await Promise.all([
      fetchAllRows(buildAgentQuery),
      fetchAllRows(buildPipelineQuery),
      brandScopable
        ? fetchAllRows(() =>
            supabase
              .from('sw_naskah')
              .select('status, created_at')
              .gte('created_at', range.from)
              .lte('created_at', range.to)
              .order('created_at', { ascending: true })
          )
        : { data: [], error: null },
      brandScopable
        ? fetchAllRows(() =>
            supabase
              .from('sw_gen_jobs')
              .select('status, created_at')
              .gte('created_at', range.from)
              .lte('created_at', range.to)
              .order('created_at', { ascending: true })
          )
        : { data: [], error: null },
      brandScopable
        ? fetchAllRows(() =>
            supabase
              .from('sw_qc_flags')
              .select('severity, created_at')
              .gte('created_at', range.from)
              .lte('created_at', range.to)
              .order('created_at', { ascending: true })
          )
        : { data: [], error: null },
      supabase.from('brands').select('id, name').order('name'),
      supabase.from('personas').select('id, name').order('name'),
    ])

  const [accountRes, warmupRes, kpiRes] = await Promise.all([
    fetchAllRows(() => {
      const q = supabase
        .from('accounts')
        .select('platform, warmup_phase, status, follower_count, brand_id')
        .order('created_at', { ascending: true })
      return brandId ? q.eq('brand_id', brandId) : q
    }),
    fetchAllRows(() =>
      supabase
        .from('warmup_runs')
        .select('phase, status, actions_planned, actions_done, created_at')
        .gte('created_at', range.from)
        .lte('created_at', range.to)
        .order('created_at', { ascending: true })
    ),
    fetchAllRows(() => {
      const q = supabase
        .from('kpi_metrics')
        .select(
          'brand_id, date, total_views, total_likes, total_comments, total_shares, total_saves, followers_gained, posts_published, engagement_rate'
        )
        .gte('date', range.from.slice(0, 10))
        .lte('date', range.to.slice(0, 10))
        .order('date', { ascending: true })
      return brandId ? q.eq('brand_id', brandId) : q
    }),
  ])

  const failed =
    agentRes.error ||
    pipelineRes.error ||
    naskahRes.error ||
    genJobRes.error ||
    qcRes.error ||
    brandRes.error ||
    personaRes.error ||
    accountRes.error ||
    warmupRes.error ||
    kpiRes.error
  if (failed) {
    return NextResponse.json(
      { ok: false, error: `Analytics query failed (500) — ${failed.message}` },
      { status: 500 }
    )
  }

  const content = aggregateContent({
    pipeline: pipelineRes.data,
    naskah: naskahRes.data,
    genJobs: genJobRes.data,
    qcFlags: qcRes.data,
  })

  return NextResponse.json({
    ok: true,
    range,
    brandId,
    cost: aggregateCost(agentRes.data, brandRes.data),
    content: {
      ...content,
      // Null (not zero) so the dashboard can say "not available per brand"
      // instead of drawing an empty chart that reads as "nothing happened".
      naskahByStatus: brandScopable ? content.naskahByStatus : null,
      genJobsByStatus: brandScopable ? content.genJobsByStatus : null,
      qcFlags: brandScopable ? content.qcFlags : null,
    },
    accounts: aggregateAccounts(accountRes.data, warmupRes.data),
    kpi: aggregateKpi(kpiRes.data, brandRes.data),
    dimensions: buildDimensions(brandRes.data, personaRes.data),
  })
}
