import { describe, it, expect } from 'vitest'
import { sanitize, compileImagePrompt, compileVideoPrompt } from './prompt-compiler.js'

describe('sanitize — contradiction engine', () => {
  it('drops cinematic language on phone presets', () => {
    expect(sanitize('A cinematic shot', { cameraId: 'samsung_a13_candid' })).toBe('A shot')
    expect(sanitize('ARRI Alexa look', { cameraId: 'iphone_15_clean' })).toBe('look')
  })

  it('drops pro-photo language on candid/casual presets', () => {
    expect(sanitize('sharp focus everywhere', { cameraId: 'samsung_a13_candid' })).toBe('everywhere')
  })

  it('drops wasted award/marketing tokens unconditionally', () => {
    expect(sanitize('Roger Deakins masterpiece', { cameraId: 'studio_tvc' })).toBe('masterpiece')
    expect(sanitize('scroll-stopping content', {})).toBe('content')
  })

  it('drops vertical-framing token when AR is horizontal', () => {
    expect(sanitize('vertical 9:16 phone aesthetic look', { ar: '16:9' })).toBe('look')
  })

  it('drops product-packaging language when skipProduct', () => {
    expect(sanitize('show accurate product packaging clearly', { skipProduct: true })).toBe('show clearly')
  })

  it('keeps the token when the rule is NOT triggered', () => {
    // cinematic rule does not list studio_tvc → keep it
    expect(sanitize('A cinematic shot', { cameraId: 'studio_tvc' })).toBe('A cinematic shot')
  })

  it('returns empty string for falsy input', () => {
    expect(sanitize('', {})).toBe('')
    expect(sanitize(null, {})).toBe('')
  })
})

describe('compileImagePrompt', () => {
  const base = { identity: 'a woman', action: 'smiling at camera', camera: 'iphone_15_clean' }

  it('leads with the camera preset tokens (L1 highest priority)', () => {
    const out = compileImagePrompt(base)
    expect(out.split('\n')[0]).toContain('iPhone 15 Pro')
  })

  it('includes brand fidelity only when a product is present and not skipped', () => {
    expect(compileImagePrompt({ ...base, brand: 'UGREEN charger' })).toMatch(/CRITICAL PRODUCT FIDELITY/)
    expect(compileImagePrompt({ ...base, brand: 'UGREEN charger', skipProduct: true })).not.toMatch(/CRITICAL PRODUCT FIDELITY/)
  })

  it('adds the continuity line only with character refs', () => {
    expect(compileImagePrompt({ ...base, refsCount: 2 })).toMatch(/Keep character identity consistent/)
    expect(compileImagePrompt({ ...base, refsCount: 0 })).not.toMatch(/Keep character identity consistent/)
  })

  it('adds a STYLE REFERENCE anchor when style refs are present', () => {
    expect(compileImagePrompt({ ...base, styleRefsCount: 1 })).toMatch(/STYLE REFERENCE/)
  })

  it('emits the wardrobe edit imperative (L11) when wardrobe given', () => {
    const out = compileImagePrompt({ ...base, wardrobe: 'black hoodie' })
    expect(out).toMatch(/CHANGE the subjects' outfit to: black hoodie/)
    expect(out).toMatch(/Wardrobe: black hoodie/)
  })

  it('always states the AR composition', () => {
    expect(compileImagePrompt({ ...base, ar: '9:16' })).toMatch(/9:16 composition\./)
  })
})

describe('compileVideoPrompt', () => {
  it('passes camera tokens first when a preset is given (Direct Video)', () => {
    const out = compileVideoPrompt({ camera: 'samsung_a13_candid', action: 'walks forward', ar: '9:16' })
    expect(out.split('\n')[0]).toMatch(/Samsung Galaxy A-series/)
  })

  it('forbids on-screen text when noText is set', () => {
    expect(compileVideoPrompt({ action: 'x', noText: true })).toMatch(/no on-screen text/i)
  })

  it('stays minimal when no camera/extras (just motion + AR)', () => {
    const out = compileVideoPrompt({ action: 'pans across the room', ar: '16:9' })
    expect(out).toBe('pans across the room\n16:9 composition.')
  })
})
