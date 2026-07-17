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
  // STRICTLY inside — fal rejected an image at exactly 2.50 ("expected the aspect
  // ratio to be between 0.40 and 2.50, but received image with aspect ratio: 2.50"),
  // so the bound is exclusive and landing on it is still a 422.
  const safe = (d) => d.width / d.height > 0.40 && d.width / d.height < 2.50

  it('pads the reported 2.60 case to strictly inside the bound', () => {
    expect(safe(padDimsForAspectRange(2600, 1000, 0.40, 2.50))).toBe(true)
  })
  it('never lands ON the bound — the 2.50 case fal rejected', () => {
    for (const [w, h] of [[2600, 1000], [2601, 1000], [1920, 738], [2500, 1000]]) {
      const d = padDimsForAspectRange(w, h, 0.40, 2.50)
      expect(d.width / d.height).not.toBe(2.50)
      expect(safe(d)).toBe(true)
    }
  })
  it('re-pads an image already sitting exactly on the bound', () => {
    expect(padDimsForAspectRange(2500, 1000, 0.40, 2.50)).not.toBeNull()
    expect(padDimsForAspectRange(400, 1000, 0.40, 2.50)).not.toBeNull()
  })
  it('grows width for too-tall images', () => {
    expect(safe(padDimsForAspectRange(300, 1000, 0.40, 2.50))).toBe(true)
  })
  it('returns null when comfortably in range (no re-encode, no re-upload)', () => {
    expect(padDimsForAspectRange(1080, 1920, 0.40, 2.50)).toBeNull()  // 9:16
    expect(padDimsForAspectRange(1920, 1080, 0.40, 2.50)).toBeNull()  // 16:9
    expect(padDimsForAspectRange(1000, 1000, 0.40, 2.50)).toBeNull()  // 1:1
  })
  it('returns null on degenerate dims instead of throwing', () => {
    expect(padDimsForAspectRange(0, 1000, 0.40, 2.50)).toBeNull()
  })
})
