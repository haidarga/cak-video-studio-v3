import { describe, it, expect } from 'vitest'
import { estimateFalCost } from './budget-gate.js'

// estimateFalCost is the projected-spend the budget gate adds before a fal
// call. Money math — a wrong branch means overspend or false blocks.
describe('estimateFalCost', () => {
  it('returns 0 when no model (gate still checks already-spent)', () => {
    expect(estimateFalCost('')).toBe(0)
    expect(estimateFalCost(null)).toBe(0)
  })

  it('prices video models by duration', () => {
    expect(estimateFalCost('xai/grok-imagine-video/text-to-video', { duration: 5 })).toBeCloseTo(0.35, 5)
    expect(estimateFalCost('bytedance/seedance-2.0/fast/reference-to-video', { duration: 10 })).toBeCloseTo(2.4, 5)
    expect(estimateFalCost('fal-ai/veo3', { duration: 8 })).toBeCloseTo(4.0, 5)
    expect(estimateFalCost('alibaba/happy-horse/v1.1/image-to-video', { duration: 10 })).toBeCloseTo(1.4, 5)
    expect(estimateFalCost('google/gemini-omni-flash', { duration: 8 })).toBeCloseTo(1.0, 5) // 0.125 * 8
    expect(estimateFalCost('google/gemini-omni-flash/image-to-video', { duration: 10 })).toBeCloseTo(1.3, 5) // 0.13 * 10
  })

  it('defaults video duration to 5s when the input has none (e.g. LTX uses num_frames)', () => {
    expect(estimateFalCost('fal-ai/ltx-2.3-quality/text-to-video', {})).toBeCloseTo(0.3, 5) // 0.06 * 5
  })

  it('reads alternate duration keys', () => {
    expect(estimateFalCost('xai/grok-imagine-video/image-to-video', { duration_seconds: 10 })).toBeCloseTo(0.7, 5)
  })

  it('prices image models as a flat per-call cost (no duration)', () => {
    expect(estimateFalCost('openai/gpt-image-2/edit', {})).toBe(0.06)
    expect(estimateFalCost('fal-ai/nano-banana/edit', {})).toBe(0.03)
  })

  it('routes wan/kling/seedance/veo3/gemini-omni names to the video path', () => {
    expect(estimateFalCost('fal-ai/wan/v2.7/image-to-video', { duration: 5 })).toBeCloseTo(0.5, 5)
    expect(estimateFalCost('fal-ai/kling-video/v3/pro/image-to-video', { duration: 5 })).toBeCloseTo(1.4, 5)
    expect(estimateFalCost('google/gemini-omni-flash/reference-to-video', { duration: 10 })).toBeCloseTo(1.3, 5)
  })
})
