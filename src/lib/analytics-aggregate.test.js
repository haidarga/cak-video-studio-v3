import { describe, it, expect } from 'vitest'
import {
  parseRange,
  aggregateCost,
  buildDimensions,
  MAX_RANGE_DAYS,
} from './analytics-aggregate.js'

describe('parseRange', () => {
  const now = new Date('2026-07-21T00:00:00.000Z')

  it('defaults to the last 30 days when nothing is given', () => {
    const range = parseRange({}, now)
    expect(range.to).toBe('2026-07-21T00:00:00.000Z')
    expect(range.from).toBe('2026-06-21T00:00:00.000Z')
  })

  it('honours explicit from and to', () => {
    const range = parseRange(
      { from: '2026-07-01', to: '2026-07-10' },
      now
    )
    expect(range.from).toBe('2026-07-01T00:00:00.000Z')
    expect(range.to).toBe('2026-07-10T00:00:00.000Z')
  })

  it('rejects a window wider than the cap', () => {
    expect(() =>
      parseRange({ from: '2026-01-01', to: '2026-07-21' }, now)
    ).toThrow(/range/i)
  })

  it('rejects from after to', () => {
    expect(() =>
      parseRange({ from: '2026-07-10', to: '2026-07-01' }, now)
    ).toThrow(/range/i)
  })

  it('rejects unparseable dates', () => {
    expect(() => parseRange({ from: 'yesterday' }, now)).toThrow(/range/i)
  })

  it('caps at 90 days', () => {
    expect(MAX_RANGE_DAYS).toBe(90)
  })
})

describe('aggregateCost', () => {
  const brands = [
    { id: 'b1', name: 'UGREEN' },
    { id: 'b2', name: 'Bareksa' },
  ]
  const rows = [
    { agent_name: 'lead', run_type: 'triggered', status: 'success', tokens_used: 1000, duration_ms: 200, brand_id: 'b1', created_at: '2026-07-20T06:00:00.000Z' },
    { agent_name: 'lead', run_type: 'scheduled', status: 'failed', tokens_used: null, duration_ms: 100, brand_id: 'b1', created_at: '2026-07-20T08:00:00.000Z' },
    { agent_name: 'account_monitor', run_type: 'scheduled', status: 'failed', tokens_used: 500, duration_ms: 300, brand_id: 'b2', created_at: '2026-07-19T06:00:00.000Z' },
  ]

  it('totals runs and tokens across every row', () => {
    const cost = aggregateCost(rows, brands)
    expect(cost.totalRuns).toBe(3)
    expect(cost.totalTokens).toBe(1500)
  })

  it('counts how many runs actually carried a token figure', () => {
    // 75% of agent_logs rows have a null tokens_used — coverage must stay visible
    // rather than silently deflating the estimate.
    const cost = aggregateCost(rows, brands)
    expect(cost.runsWithTokens).toBe(2)
  })

  it('groups by agent with average duration', () => {
    const cost = aggregateCost(rows, brands)
    const lead = cost.byAgent.find((a) => a.agent === 'lead')
    expect(lead).toEqual({ agent: 'lead', tokens: 1000, runs: 2, avgDurationMs: 150 })
  })

  it('sorts agents by token spend, biggest first', () => {
    const cost = aggregateCost(rows, brands)
    expect(cost.byAgent.map((a) => a.agent)).toEqual(['lead', 'account_monitor'])
  })

  it('groups by run type', () => {
    const cost = aggregateCost(rows, brands)
    expect(cost.byRunType).toEqual([
      { runType: 'triggered', tokens: 1000, runs: 1 },
      { runType: 'scheduled', tokens: 500, runs: 2 },
    ])
  })

  it('groups by brand and resolves the brand name', () => {
    const cost = aggregateCost(rows, brands)
    expect(cost.byBrand).toEqual([
      { brandId: 'b1', brandName: 'UGREEN', tokens: 1000, runs: 2 },
      { brandId: 'b2', brandName: 'Bareksa', tokens: 500, runs: 1 },
    ])
  })

  it('buckets rows by calendar day in chronological order', () => {
    const cost = aggregateCost(rows, brands)
    expect(cost.daily).toEqual([
      { date: '2026-07-19', tokens: 500, runs: 1 },
      { date: '2026-07-20', tokens: 1000, runs: 2 },
    ])
  })

  it('reports zeroed aggregates for an empty row set', () => {
    const cost = aggregateCost([], brands)
    expect(cost).toEqual({
      totalTokens: 0,
      totalRuns: 0,
      runsWithTokens: 0,
      byAgent: [],
      byRunType: [],
      byBrand: [],
      daily: [],
    })
  })

  it('falls back to a null brand entry when brand_id is missing', () => {
    const cost = aggregateCost(
      [{ agent_name: 'lead', run_type: 'triggered', status: 'success', tokens_used: 10, duration_ms: 1, brand_id: null, created_at: '2026-07-20T06:00:00.000Z' }],
      brands
    )
    expect(cost.byBrand).toEqual([
      { brandId: null, brandName: null, tokens: 10, runs: 1 },
    ])
  })
})

describe('buildDimensions', () => {
  it('maps brands and personas to id/name pairs', () => {
    const dims = buildDimensions(
      [{ id: 'b1', name: 'UGREEN', extra: 'ignored' }],
      [{ id: 'p1', name: 'Rina' }]
    )
    expect(dims).toEqual({
      brands: [{ id: 'b1', name: 'UGREEN' }],
      personas: [{ id: 'p1', name: 'Rina' }],
    })
  })

  it('tolerates missing tables by returning empty lists', () => {
    expect(buildDimensions(null, undefined)).toEqual({ brands: [], personas: [] })
  })
})
