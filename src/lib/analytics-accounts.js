// Account health + KPI aggregation. Pure functions — the route fetches, these shape.

import { countBy } from './analytics-content.js'

export function aggregateAccounts(accounts = [], warmupRuns = []) {
  const done = warmupRuns.filter((r) => r.status === 'done').length
  const failed = warmupRuns.filter((r) => r.status === 'failed').length

  return {
    total: accounts.length,
    byPlatform: countBy(accounts, 'platform', 'platform'),
    byPhase: countBy(accounts, 'warmup_phase', 'phase'),
    byStatus: countBy(accounts, 'status', 'status'),
    flagged: accounts.filter((a) => a.status === 'flagged').length,
    totalFollowers: accounts.reduce((sum, a) => sum + (a.follower_count ?? 0), 0),
    warmup: {
      runs: warmupRuns.length,
      done,
      failed,
      successRate: warmupRuns.length ? done / warmupRuns.length : 0,
    },
  }
}

const METRICS = [
  ['views', 'total_views'],
  ['likes', 'total_likes'],
  ['comments', 'total_comments'],
  ['shares', 'total_shares'],
  ['saves', 'total_saves'],
  ['followersGained', 'followers_gained'],
  ['postsPublished', 'posts_published'],
]

export function aggregateKpi(rows = [], brands = []) {
  const nameById = new Map((brands || []).map((b) => [b.id, b.name]))
  const totals = Object.fromEntries(METRICS.map(([key]) => [key, 0]))
  const byDay = new Map()
  const byBrand = new Map()
  let engagementSum = 0

  for (const row of rows) {
    for (const [key, column] of METRICS) totals[key] += row[column] ?? 0
    engagementSum += row.engagement_rate ?? 0

    const day = byDay.get(row.date) ?? {
      views: 0,
      followersGained: 0,
      postsPublished: 0,
      engagementSum: 0,
      count: 0,
    }
    day.views += row.total_views ?? 0
    day.followersGained += row.followers_gained ?? 0
    day.postsPublished += row.posts_published ?? 0
    day.engagementSum += row.engagement_rate ?? 0
    day.count += 1
    byDay.set(row.date, day)

    const brand = byBrand.get(row.brand_id) ?? {
      views: 0,
      followersGained: 0,
      postsPublished: 0,
      engagementSum: 0,
      count: 0,
    }
    brand.views += row.total_views ?? 0
    brand.followersGained += row.followers_gained ?? 0
    brand.postsPublished += row.posts_published ?? 0
    brand.engagementSum += row.engagement_rate ?? 0
    brand.count += 1
    byBrand.set(row.brand_id, brand)
  }

  return {
    totals: {
      ...totals,
      avgEngagementRate: rows.length ? engagementSum / rows.length : 0,
    },
    daily: [...byDay]
      .map(([date, d]) => ({
        date,
        views: d.views,
        followersGained: d.followersGained,
        postsPublished: d.postsPublished,
        engagementRate: d.count ? d.engagementSum / d.count : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byBrand: [...byBrand]
      .map(([brandId, b]) => ({
        brandId,
        brandName: brandId ? (nameById.get(brandId) ?? null) : null,
        views: b.views,
        followersGained: b.followersGained,
        postsPublished: b.postsPublished,
        engagementRate: b.count ? b.engagementSum / b.count : 0,
      }))
      .sort((a, b) => b.views - a.views),
  }
}
