import { describe, it, expect } from 'vitest'
import { aggregateScore, verdict, scoreOutput, QUALITY_DIMENSIONS } from './output-quality.js'

describe('aggregateScore', () => {
  it('weights product_fidelity highest (0.30)', () => {
    // only product scored low, rest high → overall pulled down more than a 0.20 dim would
    expect(aggregateScore({ skin_realism: 10, motion_authenticity: 10, product_fidelity: 0, composition_candid: 10 }))
      .toBeCloseTo(7, 2) // (10*.25+10*.25+0*.30+10*.20)/1.0 = 7.0
  })
  it('averages only the dimensions that have a score', () => {
    expect(aggregateScore({ skin_realism: 8 })).toBe(8) // single dim → its own value
  })
  it('returns null when nothing scored', () => {
    expect(aggregateScore({})).toBeNull()
    expect(aggregateScore(null)).toBeNull()
  })
})

describe('verdict', () => {
  it('flags below threshold', () => {
    expect(verdict(4).flagged).toBe(true)
    expect(verdict(4).recommendation).toMatch(/re-generate/i)
  })
  it('passes at/above threshold', () => {
    expect(verdict(5).flagged).toBe(false)
    expect(verdict(9).flagged).toBe(false)
  })
  it('null overall is never flagged', () => {
    expect(verdict(null).flagged).toBe(false)
  })
})

describe('scoreOutput (fail-safe)', () => {
  it('scores all dimensions and aggregates', async () => {
    const scorer = async () => 8
    const r = await scoreOutput('u', scorer)
    expect(r.overall).toBe(8)
    expect(Object.keys(r.dimensions)).toHaveLength(QUALITY_DIMENSIONS.length)
    expect(r.flagged).toBe(false)
  })
  it('flags a low-scoring output', async () => {
    const r = await scoreOutput('u', async () => 3)
    expect(r.flagged).toBe(true)
  })
  it('skips a dimension that throws, still aggregates the rest', async () => {
    let n = 0
    const scorer = async () => { n++; if (n === 1) throw new Error('vision hiccup'); return 9 }
    const r = await scoreOutput('u', scorer)
    expect(Object.keys(r.dimensions).length).toBe(QUALITY_DIMENSIONS.length - 1)
    expect(r.overall).toBe(9)
  })
  it('all dimensions fail → null overall, not flagged (never blocks)', async () => {
    const r = await scoreOutput('u', async () => { throw new Error('down') })
    expect(r.overall).toBeNull()
    expect(r.flagged).toBe(false)
  })
  it('clamps out-of-range scores', async () => {
    const r = await scoreOutput('u', async () => 99)
    expect(r.overall).toBe(10)
  })
})
