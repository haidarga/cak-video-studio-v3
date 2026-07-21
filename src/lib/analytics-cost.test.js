import { describe, it, expect } from 'vitest'
import { aggregateCost, allocateCostByBrand } from './analytics-cost.js'

const usage = [
  { kind: 'video_gen', model: 'xai/grok-imagine-video', cost_usd: '4.00', created_at: '2026-07-20T06:00:00Z' },
  { kind: 'video_gen', model: 'xai/grok-imagine-video', cost_usd: '2.00', created_at: '2026-07-20T08:00:00Z' },
  { kind: 'image_gen', model: 'openai/gpt-image-2/edit', cost_usd: '0.06', created_at: '2026-07-19T06:00:00Z' },
]

describe('aggregateCost', () => {
  it('sums the real cost_usd column, not an estimate', () => {
    const c = aggregateCost(usage)
    expect(c.estimated).toBe(false)
    expect(c.totalUsd).toBeCloseTo(6.06, 6)
    expect(c.totalCalls).toBe(3)
  })

  it('parses numeric strings coming back from PostgREST', () => {
    // Supabase returns numeric(10,4) as a string; naive summing would concatenate.
    expect(aggregateCost([{ kind: 'a', model: 'm', cost_usd: '1.50', created_at: '2026-07-20T00:00:00Z' }]).totalUsd).toBe(1.5)
  })

  it('groups by kind, biggest spend first', () => {
    expect(aggregateCost(usage).byKind).toEqual([
      { kind: 'video_gen', costUsd: 6, calls: 2 },
      { kind: 'image_gen', costUsd: 0.06, calls: 1 },
    ])
  })

  it('groups by model', () => {
    expect(aggregateCost(usage).byModel).toEqual([
      { model: 'xai/grok-imagine-video', costUsd: 6, calls: 2 },
      { model: 'openai/gpt-image-2/edit', costUsd: 0.06, calls: 1 },
    ])
  })

  it('buckets by calendar day chronologically', () => {
    expect(aggregateCost(usage).daily).toEqual([
      { date: '2026-07-19', costUsd: 0.06, calls: 1 },
      { date: '2026-07-20', costUsd: 6, calls: 2 },
    ])
  })

  it('treats a null cost as zero without dropping the call', () => {
    const c = aggregateCost([{ kind: 'parse', model: null, cost_usd: null, created_at: '2026-07-20T00:00:00Z' }])
    expect(c.totalUsd).toBe(0)
    expect(c.totalCalls).toBe(1)
  })

  it('zeroes out cleanly with no rows', () => {
    expect(aggregateCost([])).toEqual({
      estimated: false,
      totalUsd: 0,
      totalCalls: 0,
      byKind: [],
      byModel: [],
      daily: [],
    })
  })
})

describe('allocateCostByBrand', () => {
  const brands = [
    { id: 'b1', name: 'Ugreen' },
    { id: 'b2', name: 'Acekid' },
  ]
  const personas = [
    { id: 'p1', brand_id: 'b1' },
    { id: 'p2', brand_id: 'b2' },
  ]
  // b1 made 3 of 4 videos, b2 made 1. Images: b1 1, b2 1.
  const results = [
    { persona_id: 'p1', type: 'video' },
    { persona_id: 'p1', type: 'video' },
    { persona_id: 'p1', type: 'video' },
    { persona_id: 'p2', type: 'video' },
    { persona_id: 'p1', type: 'image' },
    { persona_id: 'p2', type: 'image' },
  ]

  it('splits video spend by each brand share of videos produced', () => {
    const rows = allocateCostByBrand(
      [{ kind: 'video_gen', cost_usd: '100', created_at: 'x' }],
      results,
      personas,
      brands
    )
    const b1 = rows.find((r) => r.brandId === 'b1')
    const b2 = rows.find((r) => r.brandId === 'b2')
    expect(b1.costUsd).toBeCloseTo(75, 6)
    expect(b2.costUsd).toBeCloseTo(25, 6)
  })

  it('splits image spend by image share, independently of video share', () => {
    const rows = allocateCostByBrand(
      [{ kind: 'image_gen', cost_usd: '10', created_at: 'x' }],
      results,
      personas,
      brands
    )
    expect(rows.find((r) => r.brandId === 'b1').costUsd).toBeCloseTo(5, 6)
    expect(rows.find((r) => r.brandId === 'b2').costUsd).toBeCloseTo(5, 6)
  })

  it('marks every row as an allocation, never a measurement', () => {
    const rows = allocateCostByBrand(
      [{ kind: 'video_gen', cost_usd: '10', created_at: 'x' }],
      results,
      personas,
      brands
    )
    expect(rows.every((r) => r.allocated === true)).toBe(true)
  })

  it('exposes the output counts the split was based on', () => {
    const rows = allocateCostByBrand(
      [{ kind: 'video_gen', cost_usd: '10', created_at: 'x' }],
      results,
      personas,
      brands
    )
    expect(rows.find((r) => r.brandId === 'b1').basisResults).toBe(4)
  })

  it('reports spend with no attributable output under a null brand', () => {
    const rows = allocateCostByBrand(
      [{ kind: 'video_gen', cost_usd: '10', created_at: 'x' }],
      [],
      personas,
      brands
    )
    expect(rows).toEqual([
      { brandId: null, brandName: null, costUsd: 10, basisResults: 0, allocated: true },
    ])
  })

  it('attributes results from an unknown persona to the null brand', () => {
    const rows = allocateCostByBrand(
      [{ kind: 'video_gen', cost_usd: '10', created_at: 'x' }],
      [{ persona_id: 'ghost', type: 'video' }],
      personas,
      brands
    )
    expect(rows[0].brandId).toBeNull()
    expect(rows[0].costUsd).toBeCloseTo(10, 6)
  })

  it('never lets one brand absorb spend that other brands also produced', () => {
    // Guard against allocating on a brand-filtered basis: b1 made 3 of 4 videos,
    // so it must get 75% even when the caller only cares about b1.
    const rows = allocateCostByBrand(
      [{ kind: 'video_gen', cost_usd: '100', created_at: 'x' }],
      results,
      personas,
      brands
    )
    expect(rows.find((r) => r.brandId === 'b1').costUsd).toBeLessThan(100)
  })

  it('returns nothing when there is no spend at all', () => {
    expect(allocateCostByBrand([], results, personas, brands)).toEqual([])
  })

  it('keeps the allocated total equal to the real total', () => {
    const rows = allocateCostByBrand(
      [
        { kind: 'video_gen', cost_usd: '100', created_at: 'x' },
        { kind: 'image_gen', cost_usd: '10', created_at: 'x' },
        { kind: 'transcribe', cost_usd: '5', created_at: 'x' },
      ],
      results,
      personas,
      brands
    )
    const sum = rows.reduce((s, r) => s + r.costUsd, 0)
    expect(sum).toBeCloseTo(115, 6)
  })
})
