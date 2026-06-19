import { describe, it, expect } from 'vitest'
import { buildVoiceDirection } from './voice-direction.js'

describe('buildVoiceDirection', () => {
  it('emits nothing without dialog or with audio off', () => {
    expect(buildVoiceDirection({ hasDialog: false })).toBe('')
    expect(buildVoiceDirection({ hasDialog: true, audioOn: false })).toBe('')
  })

  it('adds accent-only (words stay in lang, only the accent is the dialect)', () => {
    const out = buildVoiceDirection({ lang: 'Indonesian', dialect: 'Medanese (Batak)', hasDialog: true })
    expect(out).toMatch(/authentic Medanese \(Batak\) regional ACCENT/i)
    expect(out).toMatch(/keep the WORDS in Indonesian/i) // does NOT switch language
  })

  it('speaks in the regional language when lang itself is regional (no dialect)', () => {
    expect(buildVoiceDirection({ lang: 'Javanese', hasDialog: true })).toMatch(/fluent native Javanese/i)
    expect(buildVoiceDirection({ lang: 'Madurese', hasDialog: true })).toMatch(/fluent native Madurese/i)
    expect(buildVoiceDirection({ lang: 'Acehnese', hasDialog: true })).toMatch(/fluent native Acehnese/i)
  })

  it('ignores a neutral/empty dialect', () => {
    const out = buildVoiceDirection({ lang: 'Indonesian', dialect: 'Netral', hasDialog: true })
    expect(out).toMatch(/speaks Indonesian,/i)
    expect(out).not.toMatch(/accent and dialect/i)
  })

  it('ALWAYS enforces relaxed unhurried pace (the recurring "jangan cepet" need)', () => {
    expect(buildVoiceDirection({ lang: 'Indonesian', hasDialog: true })).toMatch(/UNHURRIED pace[\s\S]*do NOT rush/i)
  })
})
