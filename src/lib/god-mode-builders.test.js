import { describe, it, expect } from 'vitest'
import { buildVideoInputForModel, HAPPYHORSE_STABILITY } from './god-mode-builders.js'

const P = { motion_prompt: 'a person walking', image_url: 'https://x/a.jpg', image_urls: ['https://x/1.jpg', 'https://x/2.jpg'], duration: 5, aspect_ratio: '9:16' }

describe('buildVideoInputForModel — per-model field-name routing (the 422 traps)', () => {
  it('kling i2v uses start_image_url; r2v uses elements[].frontal_image_url', () => {
    const i2v = buildVideoInputForModel('fal-ai/kling-video/v3/image-to-video', P)
    expect(i2v.start_image_url).toBe('https://x/a.jpg')
    const r2v = buildVideoInputForModel('fal-ai/kling-video/v2.5-turbo/pro/ref-to-video', { ...P, image_url: undefined })
    expect(r2v.elements).toEqual([{ frontal_image_url: 'https://x/1.jpg' }, { frontal_image_url: 'https://x/2.jpg' }])
  })

  it('grok r2v uses reference_image_urls (NOT image_urls)', () => {
    const r2v = buildVideoInputForModel('xai/grok-imagine-video/reference-to-video', { ...P, image_url: undefined })
    expect(r2v.reference_image_urls).toEqual(['https://x/1.jpg', 'https://x/2.jpg'])
    expect(r2v.image_urls).toBeUndefined()
  })

  it('seedance r2v uses image_urls array; i2v uses image_url', () => {
    const r2v = buildVideoInputForModel('bytedance/seedance-2.0/fast/reference-to-video', { ...P, image_url: undefined })
    expect(r2v.image_urls).toEqual(['https://x/1.jpg', 'https://x/2.jpg'])
    const i2v = buildVideoInputForModel('bytedance/seedance-2.0/fast/image-to-video', P)
    expect(i2v.image_url).toBe('https://x/a.jpg')
  })

  it('seedance falls back to aspect_ratio "auto" for unsupported AR', () => {
    const out = buildVideoInputForModel('bytedance/seedance-2.0/fast/text-to-video', { ...P, aspect_ratio: '5:7' })
    expect(out.aspect_ratio).toBe('auto')
  })

  it('happy-horse appends the stability clause + forces safety checker off', () => {
    const out = buildVideoInputForModel('alibaba/happy-horse/image-to-video', P)
    expect(out.prompt.endsWith(HAPPYHORSE_STABILITY)).toBe(true)
    expect(out.enable_safety_checker).toBe(false)
  })

  it('kling t2v caps duration at 10 and enables audio', () => {
    const out = buildVideoInputForModel('fal-ai/kling-video/v3/standard/text-to-video', { ...P, duration: 15 })
    expect(out.duration).toBe('10')
    expect(out.generate_audio).toBe(true)
  })

  it('veo3 i2v: image_url, string duration bucket, safety_tolerance "6", audio on', () => {
    const out = buildVideoInputForModel('fal-ai/veo3.1/fast/image-to-video', P)
    expect(out.image_url).toBe('https://x/a.jpg')
    expect(out.duration).toBe('6s')          // 5 → 6s bucket
    expect(out.safety_tolerance).toBe('6')
    expect(out.generate_audio).toBe(true)
  })
  it('veo3 r2v: image_urls (max 3), locked 8s, safety_tolerance "6"', () => {
    const out = buildVideoInputForModel('fal-ai/veo3.1/fast/reference-to-video', { ...P, image_url: undefined, image_urls: ['a', 'b', 'c', 'd'] })
    expect(out.image_urls).toEqual(['a', 'b', 'c'])
    expect(out.duration).toBe('8s')
    expect(out.safety_tolerance).toBe('6')
  })
})

describe('buildVideoInputForModel — LTX-2.3 quality recipe', () => {
  const LTX = 'fal-ai/ltx-2.3-quality/text-to-video'

  it('snaps num_frames to 8n+1 at 24fps', () => {
    expect(buildVideoInputForModel(LTX, { ...P, duration: 5 }).num_frames).toBe(121)  // 5s
    expect(buildVideoInputForModel(LTX, { ...P, duration: 8 }).num_frames).toBe(193)  // 8s
    expect(buildVideoInputForModel(LTX, { ...P, duration: 3 }).num_frames).toBe(73)   // floor clamp
    expect(buildVideoInputForModel(LTX, { ...P, duration: 99 }).num_frames).toBe(361) // 15s ceil clamp
  })

  it('forces the anti-artifact / audio recipe', () => {
    const out = buildVideoInputForModel(LTX, P)
    expect(out.generate_audio).toBe(true)
    expect(out.enable_safety_checker).toBe(false)
    expect(out.enable_prompt_expansion).toBe(true)
    expect(out.num_inference_steps).toBe(30)
    expect(out.guidance_scale).toBe(1)
    expect(out.video_quality).toBe('maximum')
    expect(out.negative_prompt).toMatch(/morphing/)
  })

  it('maps aspect ratio to the fal ImageSize enum', () => {
    expect(buildVideoInputForModel(LTX, { ...P, aspect_ratio: '9:16' }).resolution).toBe('portrait_16_9')
    expect(buildVideoInputForModel(LTX, { ...P, aspect_ratio: '16:9' }).resolution).toBe('landscape_16_9')
    expect(buildVideoInputForModel(LTX, { ...P, aspect_ratio: '1:1' }).resolution).toBe('square_hd')
  })

  it('includes seed only when a finite number is passed', () => {
    expect(buildVideoInputForModel(LTX, { ...P, seed: 42 }).seed).toBe(42)
    expect('seed' in buildVideoInputForModel(LTX, P)).toBe(false)
  })
})
