import { describe, it, expect } from 'vitest'
import { CAMERA_PRESETS, getCameraPreset, DEFAULT_CAMERA } from './camera-presets.js'

describe('camera presets — realism tokens', () => {
  it('iPhone 15 clean now carries motion-blur + 30fps (was the missing-realism preset)', () => {
    const t = CAMERA_PRESETS.iphone_15_clean.tokens.join(' | ').toLowerCase()
    expect(t).toMatch(/motion blur/)
    expect(t).toMatch(/30fps/)
  })
  it('Samsung A13 carries 30fps self-recorded cadence', () => {
    expect(CAMERA_PRESETS.samsung_a13_candid.tokens.join(' ').toLowerCase()).toMatch(/30fps/)
  })
  it('every preset has a category that drives the quality/sanitizer path', () => {
    for (const p of Object.values(CAMERA_PRESETS)) {
      expect(['phone', 'cinema', 'animation']).toContain(p.category)
    }
  })
})

describe('getCameraPreset resolution', () => {
  it('resolves built-in by id', () => {
    expect(getCameraPreset('samsung_a13_candid').id).toBe('samsung_a13_candid')
  })
  it('maps legacy style aliases', () => {
    expect(getCameraPreset('ugc').id).toBe('samsung_a13_candid')
    expect(getCameraPreset('tvc').id).toBe('studio_tvc')
  })
  it('prefers a workspace custom preset over built-in', () => {
    const custom = [{ id: 'iphone_15_clean', label: 'mine', tokens: ['x'], category: 'phone' }]
    expect(getCameraPreset('iphone_15_clean', custom).label).toBe('mine')
  })
  it('falls back to the default for unknown ids', () => {
    expect(getCameraPreset('does-not-exist').id).toBe(DEFAULT_CAMERA)
  })
})
