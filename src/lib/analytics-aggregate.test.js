import { describe, it, expect } from 'vitest'
import { parseRange, buildDimensions, MAX_RANGE_DAYS } from './analytics-aggregate.js'

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

describe('buildDimensions', () => {
  it('maps brands and personas to id/name pairs', () => {
    const dims = buildDimensions(
      [{ id: 'b1', name: 'Ugreen', extra: 'ignored' }],
      [{ id: 'p1', name: 'Ben', brand_id: 'b1' }]
    )
    expect(dims).toEqual({
      brands: [{ id: 'b1', name: 'Ugreen' }],
      personas: [{ id: 'p1', name: 'Ben', brandId: 'b1' }],
    })
  })

  it('carries a null brand for personas with no brand assigned', () => {
    const dims = buildDimensions([], [{ id: 'p1', name: 'Lepas' }])
    expect(dims.personas[0].brandId).toBeNull()
  })

  it('tolerates missing tables by returning empty lists', () => {
    expect(buildDimensions(null, undefined)).toEqual({ brands: [], personas: [] })
  })
})
