import { describe, it, expect } from 'vitest'
import { buildVoiceDirection } from './voice-direction.js'

describe('buildVoiceDirection', () => {
  it('emits nothing without dialog or with audio off', () => {
    expect(buildVoiceDirection({ hasDialog: false })).toBe('')
    expect(buildVoiceDirection({ hasDialog: true, audioOn: false })).toBe('')
  })

  it('adds an explicit regional accent when a dialect is set', () => {
    const out = buildVoiceDirection({ lang: 'Indonesian', dialect: 'Medanese (Batak)', hasDialog: true })
    expect(out).toMatch(/Indonesian with a natural, authentic Medanese \(Batak\) accent/i)
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
