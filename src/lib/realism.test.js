import { describe, it, expect } from 'vitest'
import { phoneSkinClause, skinContext, enrichLighting, inferSceneType, motionRealismFor, inferCategoryFromText, PHONE_SKIN } from './realism.js'

describe('phoneSkinClause / skinContext', () => {
  it('always names concrete skin imperfection', () => {
    expect(phoneSkinClause('')).toContain('visible skin pores'.replace('visible', 'Visible'))
    expect(phoneSkinClause('')).toBe(PHONE_SKIN) // no context add-on for empty env
  })
  it('adds outdoor / morning context', () => {
    expect(skinContext('outdoor park')).toMatch(/sun-kissed/i)
    expect(skinContext('pagi di kamar')).toMatch(/puffiness/i)
    expect(skinContext('plain room')).toBe('')
  })
})

describe('enrichLighting (string OR preset object)', () => {
  it('injects directional light when none named', () => {
    expect(enrichLighting('bedroom', 'phone')).toMatch(/directional shadow|window/i)
    expect(enrichLighting('di taman', 'phone')).toMatch(/directional sunlight/i)
  })
  it('accepts a preset object too (back-compat with prompt-compiler call site)', () => {
    expect(enrichLighting('bedroom', { category: 'phone' })).toMatch(/window|directional/i)
  })
  it('respects an already-named light source', () => {
    expect(enrichLighting('harsh sunlight from the window', 'phone')).toBe('')
  })
  it('never enriches animation OR cinema (cinema presets carry their own lighting tokens)', () => {
    expect(enrichLighting('bedroom', 'animation')).toBe('')
    expect(enrichLighting('bedroom', 'cinema')).toBe('')
  })
})

describe('motionRealismFor', () => {
  it('phone → handheld blur + secondary motion', () => {
    expect(motionRealismFor('she speaks', 'phone')).toMatch(/motion blur/i)
    expect(motionRealismFor('she speaks', 'phone')).toMatch(/secondary motion|breathing/i)
  })
  it('cinema → smooth controlled, no motion blur', () => {
    const m = motionRealismFor('walks', 'cinema')
    expect(m).toMatch(/smooth controlled/i)
    expect(m).not.toMatch(/motion blur/i)
  })
  it('animation → empty', () => {
    expect(motionRealismFor('waving', 'animation')).toBe('')
  })
  it('product reveal embeds rigid-product anti-morph', () => {
    expect(motionRealismFor('she reveals the product', 'phone')).toMatch(/RIGID/)
  })
  it('prefers a parser-tagged sceneType over regex inference', () => {
    // action says nothing beauty-ish, but the parser tagged it → use the tag
    const m = motionRealismFor('she does something', 'phone', 'beauty_application')
    expect(m).toMatch(/hands in motion with natural blur/i)
  })
  it('falls back to regex when the tag is invalid/missing', () => {
    expect(motionRealismFor('she speaks to camera', 'phone', 'bogus_tag')).toMatch(/secondary motion|breathing/i)
  })
})

describe('inferSceneType', () => {
  it('classifies actions', () => {
    expect(inferSceneType('applying foundation')).toBe('beauty_application')
    expect(inferSceneType('she walks in')).toBe('walking_transition')
    expect(inferSceneType('speaks to camera')).toBe('talking_head')
    expect(inferSceneType('nothing')).toBe('default')
  })
})

describe('inferCategoryFromText (God Mode look detection)', () => {
  it('detects animation', () => {
    expect(inferCategoryFromText('a cute 2d cartoon mascot waving')).toBe('animation')
    expect(inferCategoryFromText('pixar style 3d render of a panda')).toBe('animation')
  })
  it('detects cinema', () => {
    expect(inferCategoryFromText('cinematic anamorphic hero shot, ARRI')).toBe('cinema')
    expect(inferCategoryFromText('premium TVC commercial spot')).toBe('cinema')
  })
  it('defaults to phone (UGC) for everything else', () => {
    expect(inferCategoryFromText('a woman holding a power bank in her bedroom')).toBe('phone')
    expect(inferCategoryFromText('')).toBe('phone')
  })
})
