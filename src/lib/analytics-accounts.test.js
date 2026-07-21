import { describe, it, expect } from 'vitest'
import { aggregateAccounts, aggregateKpi } from './analytics-accounts.js'

describe('aggregateAccounts', () => {
  const accounts = [
    { platform: 'tiktok', warmup_phase: 'warm', status: 'active', follower_count: 1000 },
    { platform: 'tiktok', warmup_phase: 'cold', status: 'flagged', follower_count: 250 },
    { platform: 'instagram', warmup_phase: 'warm', status: 'active', follower_count: null },
  ]

  it('counts accounts by platform, phase and status', () => {
    const a = aggregateAccounts(accounts, [])
    expect(a.total).toBe(3)
    expect(a.byPlatform).toEqual([
      { platform: 'tiktok', count: 2 },
      { platform: 'instagram', count: 1 },
    ])
    expect(a.byPhase).toEqual([
      { phase: 'warm', count: 2 },
      { phase: 'cold', count: 1 },
    ])
    expect(a.byStatus).toEqual([
      { status: 'active', count: 2 },
      { status: 'flagged', count: 1 },
    ])
  })

  it('surfaces the flagged count on its own', () => {
    expect(aggregateAccounts(accounts, []).flagged).toBe(1)
  })

  it('sums followers, treating null as zero', () => {
    expect(aggregateAccounts(accounts, []).totalFollowers).toBe(1250)
  })

  it('computes the warmup success rate', () => {
    const runs = [{ status: 'done' }, { status: 'done' }, { status: 'failed' }]
    expect(aggregateAccounts(accounts, runs).warmup).toEqual({
      runs: 3,
      done: 2,
      failed: 1,
      successRate: 2 / 3,
    })
  })

  it('reports a zero success rate when every run failed', () => {
    // The live dataset is exactly this shape — 100% failures.
    const runs = [{ status: 'failed' }, { status: 'failed' }]
    expect(aggregateAccounts(accounts, runs).warmup.successRate).toBe(0)
  })

  it('reports a zero rate rather than NaN when there are no runs', () => {
    expect(aggregateAccounts(accounts, []).warmup).toEqual({
      runs: 0,
      done: 0,
      failed: 0,
      successRate: 0,
    })
  })

  it('handles an empty account list', () => {
    const a = aggregateAccounts([], [])
    expect(a.total).toBe(0)
    expect(a.totalFollowers).toBe(0)
    expect(a.byPlatform).toEqual([])
  })
})

describe('aggregateKpi', () => {
  const brands = [
    { id: 'b1', name: 'AceKid' },
    { id: 'b2', name: 'UGREEN' },
  ]
  const rows = [
    { brand_id: 'b1', date: '2026-06-30', total_views: 100, total_likes: 10, total_comments: 2, total_shares: 1, total_saves: 3, followers_gained: 5, posts_published: 1, engagement_rate: 0.08 },
    { brand_id: 'b1', date: '2026-06-29', total_views: 50, total_likes: 5, total_comments: 1, total_shares: 0, total_saves: 1, followers_gained: 2, posts_published: 1, engagement_rate: 0.04 },
    { brand_id: 'b2', date: '2026-06-30', total_views: 200, total_likes: 20, total_comments: 4, total_shares: 2, total_saves: 6, followers_gained: 10, posts_published: 2, engagement_rate: 0.06 },
  ]

  it('sums every headline metric', () => {
    const k = aggregateKpi(rows, brands)
    expect(k.totals.views).toBe(350)
    expect(k.totals.likes).toBe(35)
    expect(k.totals.followersGained).toBe(17)
    expect(k.totals.postsPublished).toBe(4)
  })

  it('averages engagement rate across rows', () => {
    const k = aggregateKpi(rows, brands)
    expect(k.totals.avgEngagementRate).toBeCloseTo((0.08 + 0.04 + 0.06) / 3, 6)
  })

  it('rolls days up chronologically', () => {
    const k = aggregateKpi(rows, brands)
    expect(k.daily.map((d) => d.date)).toEqual(['2026-06-29', '2026-06-30'])
    expect(k.daily[1].views).toBe(300)
  })

  it('groups by brand with names resolved, biggest first', () => {
    const k = aggregateKpi(rows, brands)
    expect(k.byBrand).toEqual([
      { brandId: 'b2', brandName: 'UGREEN', views: 200, followersGained: 10, postsPublished: 2, engagementRate: 0.06 },
      { brandId: 'b1', brandName: 'AceKid', views: 150, followersGained: 7, postsPublished: 2, engagementRate: (0.08 + 0.04) / 2 },
    ])
  })

  it('zeroes out cleanly with no rows', () => {
    const k = aggregateKpi([], brands)
    expect(k.totals.views).toBe(0)
    expect(k.totals.avgEngagementRate).toBe(0)
    expect(k.daily).toEqual([])
    expect(k.byBrand).toEqual([])
  })
})
