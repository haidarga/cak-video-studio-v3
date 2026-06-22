import { describe, it, expect } from 'vitest'
import { toRefToVideoModel, toImageToVideoModel, getVideoMaxDuration, buildStoryboardGridPrompt, buildVidInput, gridDims } from './fal-client.js'

describe('toRefToVideoModel', () => {
  it('maps each family to its OWN ref-to-video variant (respects user pick)', () => {
    expect(toRefToVideoModel('xai/grok-imagine-video/image-to-video')).toBe('xai/grok-imagine-video/reference-to-video')
    expect(toRefToVideoModel('bytedance/seedance-2.0/fast/image-to-video')).toBe('bytedance/seedance-2.0/fast/reference-to-video')
    expect(toRefToVideoModel('alibaba/happy-horse/image-to-video')).toBe('alibaba/happy-horse/reference-to-video')
    expect(toRefToVideoModel('fal-ai/kling-video/v3/image-to-video')).toBe('fal-ai/kling-video/v2.5-turbo/pro/ref-to-video')
  })
  it('maps veo3 i2v to the veo3 ref variant', () => {
    expect(toRefToVideoModel('fal-ai/veo3.1/fast/image-to-video')).toBe('fal-ai/veo3.1/fast/reference-to-video')
  })
  it('returns an already-ref model unchanged', () => {
    const ref = 'xai/grok-imagine-video/reference-to-video'
    expect(toRefToVideoModel(ref)).toBe(ref)
  })
  it('falls back to seedance for unknown families', () => {
    expect(toRefToVideoModel('some/unknown/text-to-video')).toBe('bytedance/seedance-2.0/fast/reference-to-video')
  })
})

describe('toImageToVideoModel (long-form hybrid handoff)', () => {
  it('maps each family to its i2v variant', () => {
    expect(toImageToVideoModel('bytedance/seedance-2.0/fast/reference-to-video')).toBe('bytedance/seedance-2.0/fast/image-to-video')
    expect(toImageToVideoModel('fal-ai/kling-video/v2.5-turbo/pro/ref-to-video')).toBe('fal-ai/kling-video/v3/standard/image-to-video')
    expect(toImageToVideoModel('xai/grok-imagine-video/reference-to-video')).toBe('xai/grok-imagine-video/image-to-video')
    expect(toImageToVideoModel('fal-ai/veo3.1/fast/reference-to-video')).toBe('fal-ai/veo3.1/fast/image-to-video')
  })
  it('returns an already-i2v model unchanged', () => {
    expect(toImageToVideoModel('bytedance/seedance-2.0/fast/image-to-video')).toBe('bytedance/seedance-2.0/fast/image-to-video')
  })
})

describe('getVideoMaxDuration', () => {
  it('returns per-family caps', () => {
    expect(getVideoMaxDuration('bytedance/seedance-2.0/fast/reference-to-video')).toBe(15)
    expect(getVideoMaxDuration('xai/grok-imagine-video/reference-to-video')).toBe(10)
    expect(getVideoMaxDuration('fal-ai/kling-video/v3/image-to-video')).toBe(10)
    expect(getVideoMaxDuration('fal-ai/kling-video/v3/pro/image-to-video')).toBe(15)
  })
  it('caps veo3 at 8s', () => {
    expect(getVideoMaxDuration('fal-ai/veo3.1/fast/image-to-video')).toBe(8)
    expect(getVideoMaxDuration('fal-ai/veo3.1/fast/reference-to-video')).toBe(8)
  })
  it('defaults to 10 for unknown / empty', () => {
    expect(getVideoMaxDuration('')).toBe(10)
    expect(getVideoMaxDuration('weird/model')).toBe(10)
  })
})

describe('buildVidInput — Veo 3.1 Fast', () => {
  const base = { prompt: 'a woman speaks', image_url: 'https://x/a.jpg', reference_urls: ['https://x/1.jpg', 'https://x/2.jpg'], duration: 5, aspect_ratio: '9:16' }

  it('i2v: image_url, string duration bucket, safety_tolerance "6" (max), audio on', () => {
    const out = buildVidInput('fal-ai/veo3.1/fast/image-to-video', base)
    expect(out.image_url).toBe('https://x/a.jpg')
    expect(out.duration).toBe('6s')              // 5 → nearest bucket 6s
    expect(out.safety_tolerance).toBe('6')       // string, most permissive
    expect(out.generate_audio).toBe(true)
    expect(out.aspect_ratio).toBe('9:16')
  })
  it('i2v: duration buckets to 4s/6s/8s', () => {
    expect(buildVidInput('fal-ai/veo3.1/fast/image-to-video', { ...base, duration: 3 }).duration).toBe('4s')
    expect(buildVidInput('fal-ai/veo3.1/fast/image-to-video', { ...base, duration: 8 }).duration).toBe('8s')
    expect(buildVidInput('fal-ai/veo3.1/fast/image-to-video', { ...base, duration: 99 }).duration).toBe('8s')
  })
  it('r2v: image_urls array (max 3), locked 8s, safety_tolerance "6"', () => {
    const out = buildVidInput('fal-ai/veo3.1/fast/reference-to-video', { ...base, reference_urls: ['a', 'b', 'c', 'd'] })
    expect(out.image_urls).toEqual(['a', 'b', 'c'])  // capped at 3
    expect(out.duration).toBe('8s')
    expect(out.safety_tolerance).toBe('6')
    expect(out.image_url).toBeUndefined()
  })
  it('i2v: adds anti-morph negative_prompt (lip/mouth artifacts)', () => {
    const out = buildVidInput('fal-ai/veo3.1/fast/image-to-video', base)
    expect(out.negative_prompt).toMatch(/lips|mouth/i)
    expect(out.negative_prompt).toMatch(/morphing/i)
  })
  it('r2v: NO negative_prompt field (unsupported → 422); anti-morph rides in the positive prompt', () => {
    const out = buildVidInput('fal-ai/veo3.1/fast/reference-to-video', base)
    expect('negative_prompt' in out).toBe(false)
    expect(out.prompt).toMatch(/MOUTH, LIPS and TEETH stable/i)
  })
  it('r2v: unsupported AR (1:1) falls back to 9:16 (no auto for r2v)', () => {
    const out = buildVidInput('fal-ai/veo3.1/fast/reference-to-video', { ...base, aspect_ratio: '1:1' })
    expect(out.aspect_ratio).toBe('9:16')
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

describe('gridDims — clean rectangle for N panels (no forced 3x3)', () => {
  it('maps panel count to a clean grid', () => {
    expect(gridDims(4)).toEqual({ count: 4, rows: 2, cols: 2 })
    expect(gridDims(6)).toEqual({ count: 6, rows: 2, cols: 3 })
    expect(gridDims(9)).toEqual({ count: 9, rows: 3, cols: 3 })
  })
  it('clamps to 1..9', () => {
    expect(gridDims(0).count).toBe(1)
    expect(gridDims(99).count).toBe(9)
  })
})

describe('buildStoryboardGridPrompt — dynamic layout (not always 3x3/9)', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ n: i + 1, shot_type: 'Medium Shot', visual: `beat ${i + 1}` }))
  it('describes a 2x2 grid of 4 stills when given 4 panels', () => {
    const out = buildStoryboardGridPrompt(mk(4), '9:16', '', {})
    expect(out).toMatch(/2x2 grid layout \(2 rows × 2 columns\) of 4 sequential/)
    expect(out).toMatch(/across all 4 panels/)
  })
  it('describes a 2x3 grid of 6 stills when given 6 panels', () => {
    expect(buildStoryboardGridPrompt(mk(6), '9:16', '', {})).toMatch(/2x3 grid layout \(2 rows × 3 columns\) of 6 sequential/)
  })
  it('still describes 3x3/9 when given 9 panels', () => {
    expect(buildStoryboardGridPrompt(mk(9), '9:16', '', {})).toMatch(/3x3 grid layout \(3 rows × 3 columns\) of 9 sequential/)
  })
})
