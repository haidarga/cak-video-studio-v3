import { describe, it, expect } from 'vitest'
import { toRefToVideoModel, getVideoMaxDuration, buildStoryboardGridPrompt } from './fal-client.js'

describe('toRefToVideoModel', () => {
  it('maps each family to its OWN ref-to-video variant (respects user pick)', () => {
    expect(toRefToVideoModel('xai/grok-imagine-video/image-to-video')).toBe('xai/grok-imagine-video/reference-to-video')
    expect(toRefToVideoModel('bytedance/seedance-2.0/fast/image-to-video')).toBe('bytedance/seedance-2.0/fast/reference-to-video')
    expect(toRefToVideoModel('alibaba/happy-horse/image-to-video')).toBe('alibaba/happy-horse/reference-to-video')
    expect(toRefToVideoModel('fal-ai/kling-video/v3/image-to-video')).toBe('fal-ai/kling-video/v2.5-turbo/pro/ref-to-video')
  })
  it('returns an already-ref model unchanged', () => {
    const ref = 'xai/grok-imagine-video/reference-to-video'
    expect(toRefToVideoModel(ref)).toBe(ref)
  })
  it('falls back to seedance for unknown families', () => {
    expect(toRefToVideoModel('some/unknown/text-to-video')).toBe('bytedance/seedance-2.0/fast/reference-to-video')
  })
})

describe('getVideoMaxDuration', () => {
  it('returns per-family caps', () => {
    expect(getVideoMaxDuration('bytedance/seedance-2.0/fast/reference-to-video')).toBe(15)
    expect(getVideoMaxDuration('xai/grok-imagine-video/reference-to-video')).toBe(10)
    expect(getVideoMaxDuration('fal-ai/kling-video/v3/image-to-video')).toBe(10)
    expect(getVideoMaxDuration('fal-ai/kling-video/v3/pro/image-to-video')).toBe(15)
  })
  it('defaults to 10 for unknown / empty', () => {
    expect(getVideoMaxDuration('')).toBe(10)
    expect(getVideoMaxDuration('weird/model')).toBe(10)
  })
})

describe('buildStoryboardGridPrompt', () => {
  const panels = [
    { n: 1, shot_type: 'Medium Shot', visual: 'woman smiling', dialog: 'hai', onscreen: 'CAP' },
    { n: 2, shot_type: 'Close Up', visual: 'product in hand' },
  ]
  it('always asserts cross-panel consistency', () => {
    const out = buildStoryboardGridPrompt(panels, '9:16', '', {})
    expect(out).toMatch(/CRITICAL CONSISTENCY/)
    expect(out).toMatch(/Cell 1: medium shot/)
  })
  it('adds a CANDID anti-staging line only when candid=true (phone presets)', () => {
    expect(buildStoryboardGridPrompt(panels, '9:16', '', {}, true)).toMatch(/CANDID, NOT STAGED/)
    expect(buildStoryboardGridPrompt(panels, '9:16', '', {}, false)).not.toMatch(/CANDID, NOT STAGED/)
  })
  it('honors skipDialog / skipOnscreen (no overheard / caption)', () => {
    const out = buildStoryboardGridPrompt(panels, '9:16', '', { skipDialog: true, skipOnscreen: true })
    expect(out).not.toMatch(/\(overheard:/)
    expect(out).not.toMatch(/\[caption:/)
  })
})
