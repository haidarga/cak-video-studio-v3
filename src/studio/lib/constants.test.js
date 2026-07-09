import { describe, it, expect } from 'vitest'
import { videoRatePerSec } from './constants.js'

describe('videoRatePerSec', () => {
  it('returns correctly for Happy Horse 1.0 (defaults to 1.0 logic when no version specified)', () => {
    expect(videoRatePerSec('alibaba/happy-horse/image-to-video', '720p')).toBe(0.14)
    expect(videoRatePerSec('alibaba/happy-horse/image-to-video', '1080p')).toBe(0.28)
  })

  it('returns correctly for Happy Horse 1.1', () => {
    expect(videoRatePerSec('alibaba/happy-horse/v1.1/image-to-video', '720p')).toBe(0.14)
    expect(videoRatePerSec('alibaba/happy-horse/v1.1/image-to-video', '1080p')).toBe(0.18)
  })

  it('defaults to 0.12 for unknown models', () => {
    expect(videoRatePerSec('unknown/model')).toBe(0.12)
  })
})
