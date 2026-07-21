import { describe, it, expect } from 'vitest'
import { aggregateVideo, aggregatePublishing, aggregateOps } from './analytics-video.js'

const personas = [
  { id: 'p1', name: 'Tandy Moo', brand_id: 'b1' },
  { id: 'p2', name: 'Ben', brand_id: 'b2' },
]
const brands = [
  { id: 'b1', name: 'Acekid' },
  { id: 'b2', name: 'Ugreen' },
]
const results = [
  { persona_id: 'p1', type: 'video', qc_status: 'approved', url: 'https://x/1.mp4', created_at: '2026-07-20T00:00:00Z' },
  { persona_id: 'p1', type: 'video', qc_status: 'pending', url: 'https://x/2.mp4', created_at: '2026-07-20T00:00:00Z' },
  { persona_id: 'p2', type: 'image', qc_status: null, url: 'https://x/3.png', created_at: '2026-07-19T00:00:00Z' },
]
const genJobs = [
  { kind: 'video', status: 'done', duration_seconds: '10', retry_count: 0, model: 'a' },
  { kind: 'video', status: 'error', duration_seconds: null, retry_count: 2, model: 'a' },
  { kind: 'image', status: 'done', duration_seconds: null, retry_count: 0, model: 'b' },
]

describe('aggregateVideo', () => {
  it('counts results by type and qc status', () => {
    const v = aggregateVideo({ results, genJobs, factoryRuns: [], personas, brands })
    expect(v.totalResults).toBe(3)
    expect(v.byType).toEqual([
      { type: 'video', count: 2 },
      { type: 'image', count: 1 },
    ])
    expect(v.byQc).toEqual([
      { qcStatus: 'approved', count: 1 },
      { qcStatus: 'pending', count: 1 },
      { qcStatus: null, count: 1 },
    ])
  })

  it('separates video and image totals', () => {
    const v = aggregateVideo({ results, genJobs, factoryRuns: [], personas, brands })
    expect(v.videos).toBe(2)
    expect(v.images).toBe(1)
  })

  it('rolls results up per day chronologically', () => {
    const v = aggregateVideo({ results, genJobs, factoryRuns: [], personas, brands })
    expect(v.daily).toEqual([
      { date: '2026-07-19', videos: 0, images: 1 },
      { date: '2026-07-20', videos: 2, images: 0 },
    ])
  })

  it('ranks personas by output with their brand resolved', () => {
    const v = aggregateVideo({ results, genJobs, factoryRuns: [], personas, brands })
    expect(v.topPersonas[0]).toEqual({
      personaId: 'p1',
      personaName: 'Tandy Moo',
      brandName: 'Acekid',
      results: 2,
    })
  })

  it('summarises gen jobs including the error rate', () => {
    const v = aggregateVideo({ results, genJobs, factoryRuns: [], personas, brands })
    expect(v.genJobs.total).toBe(3)
    expect(v.genJobs.errorRate).toBeCloseTo(1 / 3, 6)
    expect(v.genJobs.retried).toBe(1)
  })

  it('averages duration only over jobs that recorded one', () => {
    const v = aggregateVideo({ results, genJobs, factoryRuns: [], personas, brands })
    expect(v.genJobs.avgDurationSeconds).toBe(10)
  })

  it('reports a null average duration when nothing recorded one', () => {
    const v = aggregateVideo({
      results: [],
      genJobs: [{ kind: 'image', status: 'done', duration_seconds: null, retry_count: 0 }],
      factoryRuns: [],
      personas,
      brands,
    })
    expect(v.genJobs.avgDurationSeconds).toBeNull()
  })

  it('counts factory runs by status', () => {
    const v = aggregateVideo({
      results,
      genJobs,
      factoryRuns: [{ status: 'done' }, { status: 'running' }],
      personas,
      brands,
    })
    expect(v.factoryRuns).toEqual({
      total: 2,
      byStatus: [
        { status: 'done', count: 1 },
        { status: 'running', count: 1 },
      ],
    })
  })

  it('zeroes out cleanly with no data', () => {
    const v = aggregateVideo({ results: [], genJobs: [], factoryRuns: [], personas, brands })
    expect(v.totalResults).toBe(0)
    expect(v.genJobs.errorRate).toBe(0)
    expect(v.topPersonas).toEqual([])
  })
})

describe('aggregatePublishing', () => {
  const posts = [
    { status: 'posted', target_platform: 'tiktok', posted_at: '2026-07-20T00:00:00Z', scheduled_for: null },
    { status: 'scheduled', target_platform: 'tiktok', posted_at: null, scheduled_for: '2026-07-25T00:00:00Z' },
    { status: 'failed', target_platform: 'instagram-standalone', posted_at: null, scheduled_for: null },
  ]

  it('counts posts by status and platform', () => {
    const p = aggregatePublishing(posts)
    expect(p.total).toBe(3)
    expect(p.posted).toBe(1)
    expect(p.scheduled).toBe(1)
    expect(p.failed).toBe(1)
    expect(p.byPlatform).toEqual([
      { platform: 'tiktok', count: 2 },
      { platform: 'instagram-standalone', count: 1 },
    ])
  })

  it('charts only days where something actually went out', () => {
    expect(aggregatePublishing(posts).daily).toEqual([
      { date: '2026-07-20', posted: 1 },
    ])
  })

  it('handles an empty list', () => {
    const p = aggregatePublishing([])
    expect(p).toEqual({
      total: 0,
      posted: 0,
      scheduled: 0,
      failed: 0,
      byStatus: [],
      byPlatform: [],
      daily: [],
    })
  })
})

describe('aggregateOps', () => {
  const errors = [
    { level: 'error', source: '/api/fal/webhook', message: 'boom', created_at: '2026-07-20T06:00:00Z' },
    { level: 'warn', source: '/api/fal/webhook', message: 'slow', created_at: '2026-07-20T07:00:00Z' },
  ]

  it('counts errors by level and source', () => {
    const o = aggregateOps({ errors, jobs: [] })
    expect(o.errors.total).toBe(2)
    expect(o.errors.byLevel).toEqual([
      { level: 'error', count: 1 },
      { level: 'warn', count: 1 },
    ])
    expect(o.errors.bySource).toEqual([
      { source: '/api/fal/webhook', count: 2 },
    ])
  })

  it('lists recent errors newest first, capped', () => {
    const o = aggregateOps({ errors, jobs: [] })
    expect(o.errors.recent[0]).toEqual({
      level: 'warn',
      source: '/api/fal/webhook',
      message: 'slow',
      at: '2026-07-20T07:00:00Z',
    })
    expect(o.errors.recent).toHaveLength(2)
  })

  it('counts background jobs by status', () => {
    const o = aggregateOps({ errors: [], jobs: [{ status: 'queued' }, { status: 'queued' }] })
    expect(o.jobs).toEqual({ total: 2, byStatus: [{ status: 'queued', count: 2 }] })
  })

  it('zeroes out with nothing supplied', () => {
    expect(aggregateOps({})).toEqual({
      errors: { total: 0, byLevel: [], bySource: [], recent: [] },
      jobs: { total: 0, byStatus: [] },
    })
  })
})
