// Dialog pacing — the deterministic counterpart to the parser's "keep dialog
// short" rule. AI voiceover speeds up to cram a too-long line into a short clip
// ("ngomong ngebut"), so this estimates whether a line fits its duration at a
// relaxed pace and (optionally) what the word budget is.
//
// ~2.2 words/sec is comfortable unhurried Indonesian/Javanese narration; faster
// than that and the delivery starts to sound rushed.

export const WORDS_PER_SEC = 2.2

export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length
}

export function speechPace(text, durationSec) {
  const words = wordCount(text)
  const dur = Math.max(0.5, Number(durationSec) || 0)
  const wps = words / dur
  const maxWords = Math.round(WORDS_PER_SEC * dur)
  return {
    words,
    durationSec: dur,
    wps: Math.round(wps * 100) / 100,
    maxWords,
    tooFast: words > maxWords,
  }
}
