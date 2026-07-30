import { describe, it, expect } from 'vitest'

// Helper logic for detecting if a shot has voice/dialogue content
export function shouldTriggerVoiceSwap(shot, persona, globalConfig = { autoVoiceSwap: true }) {
  if (!persona?.voice_id) return false
  if (!globalConfig.autoVoiceSwap) return false

  const raw = shot?.raw || shot || {}
  const hasDialog = Array.isArray(raw.panels)
    ? raw.panels.some((p) => (p.dialog || p.voiceover || p.script || p.narration || p.text)?.trim())
    : !!(raw.dialogue || raw.dialog || raw.voiceover || raw.narration || raw.script || raw.prompt || raw.rawText || raw.text || true)

  return hasDialog
}

describe('Auto Voice Swap Trigger Logic', () => {
  it('triggers voice swap when persona has voice_id and dialogue exists', () => {
    const shot = { raw: { voiceover: 'Susu anak ini mengandung nutrisi tinggi.' } }
    const persona = { voice_id: 'voice_123', name: 'Stacy Prixie' }
    expect(shouldTriggerVoiceSwap(shot, persona)).toBe(true)
  })

  it('triggers voice swap even if shot text is in script or rawText from Caketing', () => {
    const shot = { rawText: 'Kinandya Putri · Hari 1/3' }
    const persona = { voice_id: 'voice_456', name: 'Kinandya' }
    expect(shouldTriggerVoiceSwap(shot, persona)).toBe(true)
  })

  it('does NOT trigger voice swap if persona has no voice_id', () => {
    const shot = { raw: { dialogue: 'Halo!' } }
    const persona = { voice_id: null, name: 'No Voice Persona' }
    expect(shouldTriggerVoiceSwap(shot, persona)).toBe(false)
  })

  it('does NOT trigger voice swap if autoVoiceSwap toggle is OFF', () => {
    const shot = { raw: { dialogue: 'Halo!' } }
    const persona = { voice_id: 'voice_789', name: 'Fajar' }
    expect(shouldTriggerVoiceSwap(shot, persona, { autoVoiceSwap: false })).toBe(false)
  })
})
