import { describe, it, expect } from 'vitest'
import { isContentRefusal, nextImageModel, nextVideoModel, videoVariant } from './model-fallback.js'

describe('isContentRefusal', () => {
  it('detects the fal/Veo refusal shapes', () => {
    expect(isContentRefusal('...{"type":"no_media_generated"}...')).toBe(true)
    expect(isContentRefusal('partner_validation_failed')).toBe(true)
    expect(isContentRefusal(new Error('content policy violation'))).toBe(true)
    expect(isContentRefusal('flagged by a content checker')).toBe(true)
    expect(isContentRefusal('unsafe content detected')).toBe(true)
  })
  it('is false for ordinary errors (real failures must NOT trigger a fallback)', () => {
    expect(isContentRefusal('fetch timeout')).toBe(false)
    expect(isContentRefusal('rate limit 429')).toBe(false)
    expect(isContentRefusal(null)).toBe(false)
  })
})

describe('videoVariant', () => {
  it('classifies the variant from the model id', () => {
    expect(videoVariant('bytedance/seedance-2.0/fast/reference-to-video')).toBe('r2v')
    expect(videoVariant('fal-ai/kling-video/v2.5-turbo/pro/ref-to-video')).toBe('r2v')
    expect(videoVariant('fal-ai/veo3.1/fast/image-to-video')).toBe('i2v')
    expect(videoVariant('bytedance/seedance-2.0/text-to-video')).toBe('t2v')
  })
})

describe('nextVideoModel — preserves variant, walks the chain, skips tried', () => {
  it('Veo r2v (refused real person) → Seedance r2v → Kling r2v → Grok r2v', () => {
    const veo = 'fal-ai/veo3.1/fast/reference-to-video'
    const a = nextVideoModel(veo, [veo])
    expect(a).toBe('bytedance/seedance-2.0/fast/reference-to-video')
    const b = nextVideoModel(veo, [veo, a])
    expect(b).toBe('fal-ai/kling-video/v2.5-turbo/pro/ref-to-video')
    const c = nextVideoModel(veo, [veo, a, b])
    expect(c).toBe('xai/grok-imagine-video/reference-to-video')
    expect(nextVideoModel(veo, [veo, a, b, c])).toBeNull() // chain exhausted
  })
  it('i2v stays i2v (preserves the seamless-handoff variant)', () => {
    const veoI = 'fal-ai/veo3.1/fast/image-to-video'
    expect(nextVideoModel(veoI, [veoI])).toBe('bytedance/seedance-2.0/fast/image-to-video')
  })
})

describe('nextImageModel — most permissive first, skips tried', () => {
  it('gpt-image refusal → grok → nano-banana', () => {
    const gpt = 'openai/gpt-image-2/edit'
    const a = nextImageModel(gpt, [gpt])
    expect(a).toBe('xai/grok-imagine-image/edit')
    expect(nextImageModel(gpt, [gpt, a])).toBe('fal-ai/nano-banana-2/edit')
  })
})
