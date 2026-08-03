// Should this shot get the ElevenLabs voice swap?
//
// This module used to exist only INSIDE its own test file, where the dialogue
// check ended in `|| true` — so it always said yes and nothing ever consulted
// it. Production therefore ran the swap on every shot, including silent B-roll,
// burning ~$0.30 a pop on clips with no speech to convert (which then fail at
// the extract/S2S step anyway, and count against the budget gate for the shots
// that DO have dialogue).
//
// Deliberately NOT gated on the video model. Some fal families take an explicit
// `generate_audio: true` and others emit audio natively with no flag, so
// inferring "this model is silent" from buildVidInput would wrongly skip real
// dialogue. The server reports a genuinely silent track as a skip reason
// instead — a cheap wasted call beats a silently un-voiced video.

// Pull whatever counts as spoken content out of a shot.
// NOTE: `prompt` is intentionally excluded — that's the VISUAL description, and
// treating it as dialogue is what made every shot look like it had speech.
export function extractShotDialogue(shot) {
  const raw = shot?.raw || shot || {}
  if (Array.isArray(raw.panels)) {
    return raw.panels
      .map((p) => p?.dialog || p?.voiceover || p?.script || p?.narration || p?.text || '')
      .join(' ')
      .trim()
  }
  return String(
    raw.dialogue || raw.dialog || raw.voiceover || raw.narration ||
    raw.script || raw.rawText || raw.text || ''
  ).trim()
}

// Kept as (shot, persona, globalConfig) for the existing call contract.
export function shouldTriggerVoiceSwap(shot, persona, globalConfig = { autoVoiceSwap: true }) {
  return voiceSwapDecision(shot, persona, globalConfig).ok
}

// Same check, but says WHY — so the UI can explain a skip instead of leaving the
// user to wonder why one shot kept its AI voice.
export function voiceSwapDecision(shot, persona, globalConfig = { autoVoiceSwap: true }) {
  if (!persona?.voice_id) {
    return { ok: false, reason: 'persona belum punya voice clone' }
  }
  if (globalConfig && globalConfig.autoVoiceSwap === false) {
    return { ok: false, reason: 'auto voice swap dimatiin' }
  }
  if (!extractShotDialogue(shot)) {
    return { ok: false, reason: 'shot ini gak ada dialog (B-roll) — swap dilewatin biar gak buang biaya' }
  }
  return { ok: true, reason: null }
}
