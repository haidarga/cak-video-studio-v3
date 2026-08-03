import { describe, it, expect } from 'vitest'
// Previously this file DEFINED shouldTriggerVoiceSwap itself, so it tested a
// copy that never shipped — and that copy's dialogue check ended in `|| true`,
// meaning it could not fail. Now it imports the real module.
import { shouldTriggerVoiceSwap, voiceSwapDecision, extractShotDialogue } from './voice-swap-trigger.js'

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

describe('dialogue detection — the part that used to be `|| true`', () => {
  const persona = { voice_id: 'v1', name: 'Ben' }

  it('SKIPS a silent B-roll shot instead of burning ~$0.30 on it', () => {
    const bRoll = { raw: { prompt: 'close-up of milk pouring into a glass, slow motion' } }
    expect(shouldTriggerVoiceSwap(bRoll, persona)).toBe(false)
    expect(voiceSwapDecision(bRoll, persona).reason).toMatch(/B-roll/)
  })

  it('does NOT treat the visual prompt as dialogue', () => {
    // `prompt` describes what the camera sees, not what anyone says. Counting it
    // is why every shot looked like it had speech.
    expect(extractShotDialogue({ raw: { prompt: 'a woman walks through a kitchen' } })).toBe('')
  })

  it('reads dialogue out of a storyboard panel array', () => {
    const shot = { raw: { panels: [{ prompt: 'wide shot' }, { dialog: 'Mah, ini enak banget!' }] } }
    expect(extractShotDialogue(shot)).toBe('Mah, ini enak banget!')
    expect(shouldTriggerVoiceSwap(shot, persona)).toBe(true)
  })

  it('skips a panel array where no panel has any spoken line', () => {
    const shot = { raw: { panels: [{ prompt: 'wide shot' }, { prompt: 'close up' }] } }
    expect(shouldTriggerVoiceSwap(shot, persona)).toBe(false)
  })

  it('treats whitespace-only dialogue as no dialogue', () => {
    expect(shouldTriggerVoiceSwap({ raw: { voiceover: '   ' } }, persona)).toBe(false)
  })

  it('explains WHY it skipped so the UI can tell the user', () => {
    expect(voiceSwapDecision({ raw: { dialog: 'hi' } }, { voice_id: null }).reason).toMatch(/voice clone/)
    expect(voiceSwapDecision({ raw: { dialog: 'hi' } }, persona, { autoVoiceSwap: false }).reason).toMatch(/dimatiin/)
    expect(voiceSwapDecision({ raw: { dialog: 'hi' } }, persona).reason).toBeNull()
  })
})
