import { describe, it, expect } from 'vitest'
import { mapSpeechToTimeline } from './subtitle-timeline.js'

const segs = [
  { text: 'one', start: 0, end: 2, words: [{ word: 'one', start: 0, end: 2 }] },
  { text: 'two', start: 2, end: 4, words: [{ word: 'two', start: 2, end: 4 }] },
]

describe('mapSpeechToTimeline', () => {
  it('untrimmed clip at in_track=0, speed=1 → identity timing', () => {
    const out = mapSpeechToTimeline(segs, { in_track: 0, src_in: 0, speed: 1 })
    expect(out.map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 4]])
  })

  it('offsets by in_track', () => {
    const out = mapSpeechToTimeline(segs, { in_track: 10, src_in: 0, speed: 1 })
    expect(out[0].start).toBe(10)
    expect(out[1].end).toBe(14)
  })

  it('subtracts src_in (trim) so a mid-clip segment lands at in_track', () => {
    // clip trimmed to start at source t=2; segment "two" (src 2→4) should map to
    // timeline 0→2 (not 2→4) — this is the offset bug the fix addresses.
    const out = mapSpeechToTimeline(segs, { in_track: 0, src_in: 2, speed: 1 })
    expect(out).toHaveLength(1)        // "one" (0→2) dropped: outside [2, ∞)
    expect(out[0].text).toBe('two')
    expect(out[0].start).toBe(0)
    expect(out[0].end).toBe(2)
  })

  it('drops speech outside the trim window (no spill past the clip)', () => {
    const out = mapSpeechToTimeline(segs, { in_track: 0, src_in: 0, src_out: 2, speed: 1 })
    expect(out.map((s) => s.text)).toEqual(['one']) // "two" (2→4) is past src_out=2
  })

  it('compresses timing by speed', () => {
    const out = mapSpeechToTimeline(segs, { in_track: 0, src_in: 0, speed: 2 })
    // 2s of source at 2x → 1s on the timeline
    expect(out[0].end).toBe(1)
    expect(out[1].start).toBe(1)
    expect(out[1].end).toBe(2)
  })

  it('maps + clamps per-word karaoke timing only when karaoke=true', () => {
    const withK = mapSpeechToTimeline(segs, { in_track: 5, src_in: 0, speed: 1 }, { karaoke: true })
    expect(withK[0].words[0]).toMatchObject({ word: 'one', start: 5, end: 7 })
    const noK = mapSpeechToTimeline(segs, { in_track: 5, src_in: 0, speed: 1 })
    expect(noK[0].words).toBeNull()
  })

  it('handles empty / missing segments', () => {
    expect(mapSpeechToTimeline(null, {})).toEqual([])
    expect(mapSpeechToTimeline([], {})).toEqual([])
  })
})
