import { describe, it, expect } from 'vitest'
import { normalizeToGrid, totalSeconds } from './storyboard-grid.js'

const mk = (n, secs = 3) => Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `B${i + 1}`, seconds: secs }))

describe('normalizeToGrid — never drops a beat (the Acekid-CTA bug)', () => {
  it('keeps a clean 4-panel grid as-is', () => {
    expect(normalizeToGrid(mk(4)).length).toBe(4)
  })
  it('rounds a 5-panel script UP to 6 (NOT down to 4 — that deleted the CTA)', () => {
    const out = normalizeToGrid(mk(5))
    expect(out.length).toBe(6) // clean 2x3 grid, no beat lost
  })
  it('preserves total seconds when splitting (15s stays 15s)', () => {
    // 5 beats: 3+3+3+2+4 = 15 (the real Orla script shape)
    const panels = [
      { n: 1, seconds: 3 }, { n: 2, seconds: 3 }, { n: 3, seconds: 3 },
      { n: 4, seconds: 2 }, { n: 5, seconds: 4 },
    ]
    const out = normalizeToGrid(panels)
    expect(out.length).toBe(6)
    expect(totalSeconds(out)).toBe(15) // duration unchanged — was collapsing to 11
  })
  it('splits the LONGEST panel to fill the extra cell', () => {
    const panels = [{ n: 1, seconds: 2 }, { n: 2, seconds: 2 }, { n: 3, seconds: 2 }, { n: 4, seconds: 2 }, { n: 5, seconds: 8 }]
    const out = normalizeToGrid(panels)
    expect(out.length).toBe(6)
    // the 8s beat became two 4s beats; everything else intact
    const fours = out.filter((p) => p.seconds === 4)
    expect(fours.length).toBe(2)
    expect(totalSeconds(out)).toBe(16)
  })
  it('rounds 7 and 8 panels up to 9', () => {
    expect(normalizeToGrid(mk(7)).length).toBe(9)
    expect(normalizeToGrid(mk(8)).length).toBe(9)
  })
  it('rounds 2-3 panels up to 4', () => {
    expect(normalizeToGrid(mk(2)).length).toBe(4)
    expect(normalizeToGrid(mk(3)).length).toBe(4)
  })
  it('renumbers n sequentially after splitting', () => {
    const out = normalizeToGrid(mk(5))
    expect(out.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('caps >9 panels at 9 (grid cannot show more)', () => {
    expect(normalizeToGrid(mk(11)).length).toBe(9)
  })
  it('handles empty / single panel without crashing', () => {
    expect(normalizeToGrid([])).toEqual([])
    expect(normalizeToGrid(mk(1)).length).toBe(1)
  })
})
