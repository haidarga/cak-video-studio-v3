import { describe, it, expect } from 'vitest'
import { degradeLevelForPreset, DEGRADE_SETTINGS } from './reference-degrader.js'

describe('degradeLevelForPreset', () => {
  it('maps lo-fi presets to a degrade level', () => {
    expect(degradeLevelForPreset('samsung_a13_candid')).toBe('heavy')
    expect(degradeLevelForPreset('documentary_handheld')).toBe('medium')
    expect(degradeLevelForPreset('iphone_15_clean')).toBe('light')
  })
  it('returns null for cinema/animation/unknown (no degrade)', () => {
    expect(degradeLevelForPreset('studio_tvc')).toBeNull()
    expect(degradeLevelForPreset('animation_2d')).toBeNull()
    expect(degradeLevelForPreset('whatever')).toBeNull()
    expect(degradeLevelForPreset(undefined)).toBeNull()
  })
})

describe('DEGRADE_SETTINGS', () => {
  it('gets progressively harsher (lower res, lower quality, more grain)', () => {
    expect(DEGRADE_SETTINGS.heavy.maxDim).toBeLessThan(DEGRADE_SETTINGS.medium.maxDim)
    expect(DEGRADE_SETTINGS.medium.maxDim).toBeLessThan(DEGRADE_SETTINGS.light.maxDim)
    expect(DEGRADE_SETTINGS.heavy.jpegQuality).toBeLessThan(DEGRADE_SETTINGS.light.jpegQuality)
    expect(DEGRADE_SETTINGS.heavy.grain).toBeGreaterThan(DEGRADE_SETTINGS.light.grain)
  })
})
