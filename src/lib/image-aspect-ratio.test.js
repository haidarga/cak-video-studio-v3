import { describe, it, expect } from 'vitest'
import { isAspectRatioOutOfBounds, padDimsForAspectRange } from './image-aspect-ratio.js'

describe('isAspectRatioOutOfBounds', () => {
  it('flags the exact ratio from the reported fal.ai error (2.60, bound 0.40-2.50)', () => {
    expect(isAspectRatioOutOfBounds(2.60, 0.40, 2.50)).toBe(true)
  })
  it('allows ratios inside the bound', () => {
    expect(isAspectRatioOutOfBounds(1.0, 0.40, 2.50)).toBe(false)
    expect(isAspectRatioOutOfBounds(0.40, 0.40, 2.50)).toBe(false)
    expect(isAspectRatioOutOfBounds(2.50, 0.40, 2.50)).toBe(false)
  })
  it('flags below the lower bound (very tall images)', () => {
    expect(isAspectRatioOutOfBounds(0.2, 0.40, 2.50)).toBe(true)
  })
  it('fails open (not flagged) when ratio is null/NaN — probe failure should never block a gen', () => {
    expect(isAspectRatioOutOfBounds(null, 0.40, 2.50)).toBe(false)
    expect(isAspectRatioOutOfBounds(undefined, 0.40, 2.50)).toBe(false)
    expect(isAspectRatioOutOfBounds(NaN, 0.40, 2.50)).toBe(false)
  })
})

describe('padDimsForAspectRange', () => {
  const inBounds = (d) => d.width / d.height >= 0.40 && d.width / d.height <= 2.50

  it('pads the reported 2.60 case back inside the bound', () => {
    const d = padDimsForAspectRange(2600, 1000, 0.40, 2.50)
    expect(d).toEqual({ width: 2600, height: 1040 })
    expect(inBounds(d)).toBe(true)
  })
  it('ceil() lands inside the bound on ratios that do not divide evenly', () => {
    const d = padDimsForAspectRange(2601, 1000, 0.40, 2.50)
    expect(inBounds(d)).toBe(true)
  })
  it('grows width for too-tall images', () => {
    const d = padDimsForAspectRange(300, 1000, 0.40, 2.50)
    expect(d).toEqual({ width: 400, height: 1000 })
    expect(inBounds(d)).toBe(true)
  })
  it('returns null when already in range (no re-encode, no re-upload)', () => {
    expect(padDimsForAspectRange(1080, 1920, 0.40, 2.50)).toBeNull()
    expect(padDimsForAspectRange(2500, 1000, 0.40, 2.50)).toBeNull()
  })
  it('returns null on degenerate dims instead of throwing', () => {
    expect(padDimsForAspectRange(0, 1000, 0.40, 2.50)).toBeNull()
  })
})
