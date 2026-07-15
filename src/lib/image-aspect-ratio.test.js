import { describe, it, expect } from 'vitest'
import { isAspectRatioOutOfBounds } from './image-aspect-ratio.js'

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
