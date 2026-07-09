// Spoken-audio direction for video models that generate native audio (Seedance
// 2, Kling T2V, LTX, Happy Horse T2V). The naskah's language/dialect intent
// ("pakai bahasa Jawa", "aksen Medan") + pacing ("jangan cepet, santai") rarely
// reaches the video prompt on its own — so the model picks a generic fast TTS
// voice. This builds one explicit line that carries: language, regional
// accent/dialect, and a relaxed unhurried delivery.
//
// Only emitted when there's actually dialog AND audio is on (silent b-roll gets
// nothing). For the voice-clone (ElevenLabs S2S) path the accent comes from the
// cloned voice instead — caller should pass audioOn:false / hasDialog:false there.

// Regional Indonesian languages already imply their own accent when spoken.
const REGIONAL_LANGS = ['javanese', 'sundanese', 'balinese', 'minang', 'minangkabau', 'batak', 'betawi', 'banjar', 'banjarese', 'bugis', 'buginese', 'makassar', 'makassarese', 'madura', 'madurese', 'aceh', 'acehnese', 'jawa', 'sunda', 'bali']

function isMeaningfulDialect(d) {
  const s = String(d || '').trim()
  return s && !/^(netral|neutral|none|standar|standard|-)$/i.test(s)
}

export function buildVoiceDirection({ lang = 'Indonesian', dialect = null, hasDialog = false, audioOn = true } = {}) {
  if (!hasDialog || audioOn === false) return ''
  const d = isMeaningfulDialect(dialect) ? String(dialect).trim() : null
  let speak
  if (d) {
    // Accent-only: the WORDS stay in `lang` (e.g. Indonesian), only the
    // pronunciation/intonation carries the regional accent. This is "Bahasa
    // Indonesia dengan logat Jawa/Medan", NOT switching the language.
    speak = `speaks ${lang} but with a strong, authentic ${d} regional ACCENT and intonation — keep the WORDS in ${lang}, only the pronunciation and accent are ${d}`
  } else if (lang && REGIONAL_LANGS.includes(String(lang).toLowerCase())) {
    speak = `speaks in fluent native ${lang} with its natural regional accent`
  } else {
    speak = `speaks ${lang}`
  }
  return `Spoken audio: the character ${speak}, in a warm casual conversational tone at a natural UNHURRIED pace — relaxed, with natural pauses; do NOT rush, speed up, or compress the speech.`
}

// Parses storyboard dialogue text for speaker labels.
// e.g., "[VO Bella] Ada yang manis" -> { speaker: "Bella", text: "Ada yang manis" }
// e.g., "Bella: Ada yang manis" -> { speaker: "Bella", text: "Ada yang manis" }
export function extractSpeakerFromDialog(dialog) {
  if (!dialog) return { speaker: null, text: '' }
  const raw = String(dialog).trim()
  
  // Format 1: [VO Speaker Name] Text
  const bracketMatch = raw.match(/^\[(?:VO|Voice)?\s*([^\]]+)\]\s*(.*)$/i)
  if (bracketMatch) {
    return { speaker: bracketMatch[1].trim(), text: bracketMatch[2].trim() }
  }
  
  // Format 2: Speaker Name: Text
  // Careful not to match things like "00:00" or URLs, limit speaker length to 30 chars
  const colonMatch = raw.match(/^([A-Za-z0-9 _-]{2,30}):\s*(.*)$/)
  if (colonMatch) {
    return { speaker: colonMatch[1].trim(), text: colonMatch[2].trim() }
  }
  
  return { speaker: null, text: raw }
}
