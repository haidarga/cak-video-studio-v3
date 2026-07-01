import { describe, it, expect } from 'vitest'
import {
  parseSceneTimestamps,
  scriptTotalSeconds,
  packScenesIntoSegments,
  clampPanelsToMaxSeg,
} from './script-segments.js'

// The EXACT naskah the user reported the 19s bug on (30s, 8 scenes).
const NASKAH = `SCENE 1 — HOOK (0-4s)
Visual
Bella berdiri di tengah.
VO
Bella dicintai oleh dua pria.

SCENE 2 — KEVIN (4-10s)
Shot 1
Makan malam romantis.
VO
Kevin selalu menemaninya.

SCENE 3 — HERRY (10-15s)
Shot 1
Meeting di luar negeri.
VO
Sedangkan Herry...

SCENE 4 — QUESTION (15-18s)
Background hitam.
VO
Menurutmu?

SCENE 5 — BELLA SAKIT (18-22s)
Bella demam.
VO
Hingga suatu hari...

SCENE 6 — HERRY PULANG (22-26s)
Shot 1
Herry melihat pesan.
VO
Tapi Herry...

SCENE 7 — REALISASI (26-28s)
Herry mengompres Bella.
VO
Karena cinta...

SCENE 8 — PRODUCT (28-30s)
Bella mengambil AceKid.
VO
Sama seperti susu.`

describe('parseSceneTimestamps — read explicit timestamps, no LLM', () => {
  it('extracts all 8 scenes with correct start/end/dur', () => {
    const scenes = parseSceneTimestamps(NASKAH)
    expect(scenes.length).toBe(8)
    expect(scenes.map((s) => [s.start, s.end, s.dur])).toEqual([
      [0, 4, 4], [4, 10, 6], [10, 15, 5], [15, 18, 3],
      [18, 22, 4], [22, 26, 4], [26, 28, 2], [28, 30, 2],
    ])
  })
  it('captures each scene label + its own text block', () => {
    const scenes = parseSceneTimestamps(NASKAH)
    expect(scenes[0].label).toMatch(/HOOK/)
    expect(scenes[7].label).toMatch(/PRODUCT/)
    expect(scenes[0].text).toMatch(/Bella berdiri di tengah/)
    expect(scenes[7].text).toMatch(/AceKid/)
  })
  it('handles mm:ss ranges and en/em dashes', () => {
    const s = parseSceneTimestamps('Scene A (0:00–0:15)\nx\nScene B (0:15-0:30)\ny')
    expect(s.map((x) => [x.start, x.end])).toEqual([[0, 15], [15, 30]])
  })
  it('returns [] when the script has no timestamps', () => {
    expect(parseSceneTimestamps('just a plain script with no times')).toEqual([])
    expect(parseSceneTimestamps('')).toEqual([])
  })
})

describe('scriptTotalSeconds', () => {
  it('is the last scene end (30s)', () => {
    expect(scriptTotalSeconds(parseSceneTimestamps(NASKAH))).toBe(30)
  })
  it('is 0 for no scenes', () => {
    expect(scriptTotalSeconds([])).toBe(0)
  })
})

describe('packScenesIntoSegments — deterministic 15+15, scenes stay whole', () => {
  it('splits the 30s naskah into exactly two 15s segments at the scene boundary', () => {
    const segs = packScenesIntoSegments(parseSceneTimestamps(NASKAH), 15)
    expect(segs.length).toBe(2)
    expect(segs[0].dur).toBe(15)               // scenes 1-3 = 4+6+5
    expect(segs[1].dur).toBe(15)               // scenes 4-8 = 3+4+4+2+2
    expect(segs[0].scenes.map((s) => s.n)).toEqual([1, 2, 3])
    expect(segs[1].scenes.map((s) => s.n)).toEqual([4, 5, 6, 7, 8])
  })
  it('never puts a segment over the cap', () => {
    const segs = packScenesIntoSegments(parseSceneTimestamps(NASKAH), 15)
    for (const s of segs) expect(s.dur).toBeLessThanOrEqual(15)
  })
  it('each segment carries the concatenated text of its scenes', () => {
    const segs = packScenesIntoSegments(parseSceneTimestamps(NASKAH), 15)
    expect(segs[0].text).toMatch(/HOOK/)
    expect(segs[0].text).toMatch(/HERRY/)
    expect(segs[0].text).not.toMatch(/PRODUCT/)  // scene 8 is in segment 2
    expect(segs[1].text).toMatch(/PRODUCT/)
  })
  it('a single scene longer than the cap becomes its own segment', () => {
    const scenes = [{ n: 1, label: 'A', start: 0, end: 20, dur: 20, text: 'a' }]
    const segs = packScenesIntoSegments(scenes, 15)
    expect(segs.length).toBe(1)
    expect(segs[0].scenes.map((s) => s.n)).toEqual([1])
  })
  it('one segment when the whole script fits', () => {
    const scenes = parseSceneTimestamps(NASKAH).slice(0, 3) // 15s total
    expect(packScenesIntoSegments(scenes, 15).length).toBe(1)
  })
})

describe('clampPanelsToMaxSeg — the guarantee that kills the 19s bug', () => {
  it('rescales 6 panels summing 19 down to exactly 15', () => {
    const panels = [4, 3, 3, 3, 3, 3].map((s, i) => ({ n: i + 1, seconds: s }))
    const out = clampPanelsToMaxSeg(panels, 15)
    expect(out.reduce((a, p) => a + p.seconds, 0)).toBe(15)
    expect(out.length).toBe(6)                    // no panel dropped
    out.forEach((p) => expect(p.seconds).toBeGreaterThanOrEqual(1))
  })
  it('leaves panels alone when already within the cap', () => {
    const panels = [3, 3, 3, 2].map((s, i) => ({ n: i + 1, seconds: s }))
    const out = clampPanelsToMaxSeg(panels, 15)
    expect(out.map((p) => p.seconds)).toEqual([3, 3, 3, 2])
  })
  it('keeps the longest panel the longest after rescale (proportions preserved)', () => {
    const panels = [8, 4, 4, 4].map((s, i) => ({ n: i + 1, seconds: s }))
    const out = clampPanelsToMaxSeg(panels, 10)
    expect(out.reduce((a, p) => a + p.seconds, 0)).toBe(10)
    expect(out[0].seconds).toBeGreaterThanOrEqual(Math.max(...out.map((p) => p.seconds)))
  })
  it('produces integer seconds only', () => {
    const panels = [4, 3, 3, 3, 3, 3].map((s, i) => ({ n: i + 1, seconds: s }))
    clampPanelsToMaxSeg(panels, 15).forEach((p) => expect(Number.isInteger(p.seconds)).toBe(true))
  })
  it('handles empty / malformed input safely', () => {
    expect(clampPanelsToMaxSeg([], 15)).toEqual([])
    const out = clampPanelsToMaxSeg([{ n: 1 }, { n: 2, seconds: 'x' }], 15)
    out.forEach((p) => expect(p.seconds).toBeGreaterThanOrEqual(1))
  })
})
