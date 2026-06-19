import { describe, it, expect } from 'vitest'
import { assessSceneComplexity, preflightShots } from './scene-complexity.js'

describe('assessSceneComplexity', () => {
  it('flags Tier 4 object-inside-object / packing', () => {
    expect(assessSceneComplexity('dia memasukkan power bank ke dalam tas').tier).toBe(4)
    expect(assessSceneComplexity('she puts the charger into a small pouch').tier).toBe(4)
    expect(assessSceneComplexity('packing 3 barang ke ransel').tier).toBe(4)
    expect(assessSceneComplexity('masukin produk ke dalam totebag').tier).toBe(4)
  })
  it('flags Tier 3 placement / unboxing / assembly', () => {
    expect(assessSceneComplexity('unboxing the new product').tier).toBe(3)
    expect(assessSceneComplexity('taruh produk ke meja').tier).toBe(3)
    expect(assessSceneComplexity('merakit tripod').tier).toBe(3)
  })
  it('passes simple scenes as Tier 1 (no warning)', () => {
    const r = assessSceneComplexity('she smiles and speaks to the camera')
    expect(r.tier).toBe(1)
    expect(r.warning).toBeNull()
  })
  it('Tier 4 always carries an actionable warning', () => {
    expect(assessSceneComplexity('memasukkan barang').warning).toMatch(/redesign/i)
  })
})

describe('preflightShots', () => {
  it('returns only the risky shots with their 1-based index', () => {
    const shots = [
      { video_motion: 'she speaks to camera' },          // tier 1 — skipped
      { video_motion: 'memasukkan produk ke dalam tas' }, // tier 4
      { video_motion: 'unboxing the box' },               // tier 3
    ]
    const out = preflightShots(shots)
    expect(out.map((r) => r.index)).toEqual([2, 3])
    expect(out[0].tier).toBe(4)
  })
  it('handles empty input', () => {
    expect(preflightShots()).toEqual([])
    expect(preflightShots([])).toEqual([])
  })
})
