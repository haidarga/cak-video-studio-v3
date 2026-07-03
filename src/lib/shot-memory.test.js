import { describe, it, expect } from 'vitest'
import {
  isUsableState, normalizeState, buildContinuityBlock,
  mergeContinuity, summarizeStateForParse,
} from './shot-memory.js'

const FULL = {
  location: 'bright kitchen',
  characters: ['Bella'],
  wardrobe: { Bella: 'white casual t-shirt' },
  last_action: 'raising a glass toward the camera',
  props: ['glass', 'AceKid can'],
  lighting: 'soft window light',
}

describe('normalizeState — coerce messy LLM output into the canonical shape', () => {
  it('keeps a well-formed state', () => {
    const s = normalizeState(FULL)
    expect(s.location).toBe('bright kitchen')
    expect(s.characters).toEqual(['Bella'])
    expect(s.wardrobe).toEqual({ Bella: 'white casual t-shirt' })
  })
  it('coerces characters given as a string into an array', () => {
    expect(normalizeState({ location: 'x', characters: 'Bella' }).characters).toEqual(['Bella'])
  })
  it('drops empty wardrobe entries', () => {
    const s = normalizeState({ location: 'x', wardrobe: { Bella: 'kaos', Rio: '' } })
    expect(s.wardrobe).toEqual({ Bella: 'kaos' })
  })
  it('returns null for unusable/empty input', () => {
    expect(normalizeState(null)).toBe(null)
    expect(normalizeState({})).toBe(null)
    expect(normalizeState({ characters: ['Bella'] })).toBe(null) // no location/action/wardrobe
  })
})

describe('isUsableState', () => {
  it('true when it has location, last_action, or wardrobe', () => {
    expect(isUsableState({ location: 'kitchen' })).toBe(true)
    expect(isUsableState({ last_action: 'walks in' })).toBe(true)
    expect(isUsableState({ wardrobe: { A: 'suit' } })).toBe(true)
  })
  it('false for empty / char-only / non-object', () => {
    expect(isUsableState(null)).toBe(false)
    expect(isUsableState({})).toBe(false)
    expect(isUsableState({ characters: ['A'] })).toBe(false)
  })
})

describe('buildContinuityBlock — the prompt context carried to the next shot', () => {
  it('includes location, wardrobe, chars, props, last action', () => {
    const b = buildContinuityBlock(FULL)
    expect(b).toMatch(/bright kitchen/)
    expect(b).toMatch(/Bella wears white casual t-shirt/)
    expect(b).toMatch(/raising a glass/)
    expect(b).toMatch(/AceKid can/)
    expect(b).toMatch(/OVERRIDES the script/i) // observed wins over script
  })
  it('is empty string for unusable state (no injection)', () => {
    expect(buildContinuityBlock(null)).toBe('')
    expect(buildContinuityBlock({})).toBe('')
  })
  it('degrades gracefully with only partial state', () => {
    const b = buildContinuityBlock({ last_action: 'closes the suitcase' })
    expect(b).toMatch(/closes the suitcase/)
    expect(b).not.toMatch(/Wardrobe/)
  })
})

describe('mergeContinuity — OBSERVED render state overrides STATIC script fields', () => {
  it('observed location + wardrobe win over parsed', () => {
    const out = mergeContinuity({ environment: 'a park', wardrobe: 'red dress' }, FULL)
    expect(out.environment).toBe('bright kitchen')
    expect(out.wardrobe).toBe('Bella wears white casual t-shirt')
  })
  it('falls back to parsed values when state is unusable', () => {
    const out = mergeContinuity({ environment: 'a park', wardrobe: 'red dress' }, null)
    expect(out).toEqual({ environment: 'a park', wardrobe: 'red dress' })
  })
  it('keeps parsed wardrobe when state has no wardrobe but has location', () => {
    const out = mergeContinuity({ environment: 'a park', wardrobe: 'red dress' }, { location: 'kitchen' })
    expect(out.environment).toBe('kitchen')
    expect(out.wardrobe).toBe('red dress')
  })
})

describe('summarizeStateForParse — compact grounding appended to the next naskah parse', () => {
  it('produces a one-line continuity tag with location/wardrobe/action', () => {
    const s = summarizeStateForParse(FULL)
    expect(s).toMatch(/location: bright kitchen/)
    expect(s).toMatch(/Bella=white casual t-shirt/)
    expect(s).toMatch(/last action: raising a glass/)
  })
  it('empty for unusable state', () => {
    expect(summarizeStateForParse(null)).toBe('')
  })
})
