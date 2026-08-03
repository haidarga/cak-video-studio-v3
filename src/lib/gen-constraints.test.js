import { describe, it, expect } from 'vitest'
import {
  GEN_CONSTRAINTS, serializeConstraints, parseConstraints, defaultConstraints,
} from './gen-constraints.js'

describe('gen-constraints — Inbox → Generate handoff', () => {
  it('round-trips a config through the URL unchanged', () => {
    const cfg = { continuousShot: true, skipDialog: false, skipOnscreen: true, skipProduct: false, autoVoiceSwap: true, seedLock: false }
    expect(parseConstraints(serializeConstraints(cfg))).toEqual(cfg)
  })

  it('only serializes the ENABLED keys', () => {
    expect(serializeConstraints({ skipDialog: true, autoVoiceSwap: true })).toBe('skipDialog,autoVoiceSwap')
  })

  it('distinguishes "explicitly all off" from "not specified"', () => {
    // '' means the user turned everything off — that must switch autoVoiceSwap
    // OFF rather than falling back to its ON default.
    expect(parseConstraints('')?.autoVoiceSwap).toBe(false)
    // null means the caller said nothing → keep whatever /generate defaults to.
    expect(parseConstraints(null)).toBeNull()
    expect(parseConstraints(undefined)).toBeNull()
  })

  it('returns every key, so a parsed result fully determines the run', () => {
    const parsed = parseConstraints('skipDialog')
    expect(Object.keys(parsed).sort()).toEqual(GEN_CONSTRAINTS.map((c) => c.key).sort())
    expect(parsed.skipDialog).toBe(true)
    expect(parsed.autoVoiceSwap).toBe(false)
  })

  it('ignores unknown or empty entries instead of leaking them into config', () => {
    const parsed = parseConstraints('skipDialog,,bogusKey, seedLock ')
    expect(parsed.skipDialog).toBe(true)
    expect(parsed.seedLock).toBe(true)
    expect(parsed.bogusKey).toBeUndefined()
  })

  it('defaults keep auto voice swap ON, matching GenerateClient', () => {
    expect(defaultConstraints().autoVoiceSwap).toBe(true)
    expect(defaultConstraints().skipDialog).toBe(false)
  })

  it('every constraint has a label and a hint for the picker UI', () => {
    for (const c of GEN_CONSTRAINTS) {
      expect(c.key).toBeTruthy()
      expect(c.label).toBeTruthy()
      expect(c.hint).toBeTruthy()
    }
  })
})
