import { describe, it, expect } from 'vitest'
import { imageCost, videoCost, fmtCost } from './cost-table.js'

describe('imageCost', () => {
  it('returns the table price for known models', () => {
    expect(imageCost('openai/gpt-image-2/edit')).toBe(0.06)
    expect(imageCost('fal-ai/nano-banana/edit')).toBe(0.03)
  })
  it('falls back to the _default for unknown models', () => {
    expect(imageCost('some/unknown/model')).toBe(0.03)
  })
})

describe('videoCost', () => {
  it('multiplies per-second rate by duration', () => {
    expect(videoCost('xai/grok-imagine-video/text-to-video', 5)).toBeCloseTo(0.35, 5)
    expect(videoCost('bytedance/seedance-2.0/fast/reference-to-video', 10)).toBeCloseTo(2.4, 5)
    expect(videoCost('bytedance/seedance-2.0/mini/image-to-video', 10)).toBeCloseTo(1.55, 5)
  })
  it('defaults duration to 5s', () => {
    expect(videoCost('xai/grok-imagine-video/text-to-video')).toBeCloseTo(0.35, 5)
  })
  it('calculates cost for Happy Horse 1.1 correctly (default 720p 0.14)', () => {
    expect(videoCost('alibaba/happy-horse/v1.1/image-to-video', 10)).toBeCloseTo(1.4, 5)
  })
  it('uses _default rate (0.10/s) for unknown models', () => {
    expect(videoCost('weird/model', 5)).toBeCloseTo(0.5, 5)
  })
})

describe('fmtCost', () => {
  it('formats null as an em dash', () => {
    expect(fmtCost(null)).toBe('—')
    expect(fmtCost(undefined)).toBe('—')
  })
  it('shows <$0.01 for sub-cent (and zero)', () => {
    expect(fmtCost(0.004)).toBe('<$0.01')
    expect(fmtCost(0)).toBe('<$0.01')
  })
  it('formats normal amounts to 2dp', () => {
    expect(fmtCost(0.35)).toBe('$0.35')
    expect(fmtCost(1)).toBe('$1.00')
    expect(fmtCost(2.4)).toBe('$2.40')
  })
})
