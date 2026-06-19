import { describe, it, expect } from 'vitest'
import { wordCount, speechPace, WORDS_PER_SEC } from './dialog-pacing.js'

describe('wordCount', () => {
  it('counts words, ignoring extra whitespace', () => {
    expect(wordCount('  halo   apa  kabar ')).toBe(3)
    expect(wordCount('')).toBe(0)
    expect(wordCount(null)).toBe(0)
  })
})

describe('speechPace', () => {
  it('flags a long line crammed into a short clip as too fast', () => {
    // 12 words in a 2s clip → way over the ~4-5 budget
    const r = speechPace('satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas duabelas', 2)
    expect(r.tooFast).toBe(true)
    expect(r.maxWords).toBe(Math.round(WORDS_PER_SEC * 2))
  })
  it('passes a short line at a relaxed pace', () => {
    const r = speechPace('halo mak apa kabar', 5) // 4 words / 5s
    expect(r.tooFast).toBe(false)
  })
  it('computes words-per-second', () => {
    expect(speechPace('satu dua tiga empat', 2).wps).toBe(2)
  })
  it('guards against zero/negative duration', () => {
    expect(speechPace('halo', 0).durationSec).toBe(0.5)
  })
})
