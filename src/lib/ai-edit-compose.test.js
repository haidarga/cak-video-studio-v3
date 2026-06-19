import { describe, it, expect } from 'vitest'
import { normalizeTransition, TEXT_STYLES, compilePlanToProject } from './ai-edit-compose.js'

describe('normalizeTransition', () => {
  it('maps friendly aliases to ffmpeg xfade names', () => {
    expect(normalizeTransition('blur')).toBe('hblur')
    expect(normalizeTransition('lightleak')).toBe('fadewhite')
    expect(normalizeTransition('flash')).toBe('fadewhite')
    expect(normalizeTransition('fade')).toBe('crossfade')
    expect(normalizeTransition('whip')).toBe('slideleft')
    expect(normalizeTransition('spin')).toBe('radial')
  })
  it('passes through unknown/already-canonical names lowercased', () => {
    expect(normalizeTransition('zoomin')).toBe('zoomin')
    expect(normalizeTransition('CircleOpen')).toBe('circleopen')
    expect(normalizeTransition(undefined)).toBe('cut')
  })
})

describe('TEXT_STYLES', () => {
  it('has the documented preset keys', () => {
    expect(Object.keys(TEXT_STYLES)).toEqual(
      expect.arrayContaining(['tiktok', 'clean', 'yellow', 'neon', 'pink', 'bigpop']),
    )
  })
})

describe('compilePlanToProject', () => {
  const videos = [
    { url: 'https://x/a.mp4', label: 'A', duration: 10 },
    { url: 'https://x/b.mp4', label: 'B', duration: 8 },
  ]

  it('first clip is always a cut; later clips keep their transition', () => {
    const plan = {
      clips: [
        { video_index: 0, trim_start: 0, trim_end: 5, transition: 'blur', transition_duration: 0.5 },
        { video_index: 1, trim_start: 0, trim_end: 4, transition: 'fade', transition_duration: 0.4 },
      ],
    }
    const proj = compilePlanToProject(plan, videos, { ar: '9:16' })
    expect(proj.video_clips[0].transition_in.type).toBe('cut')
    expect(proj.video_clips[0].transition_in.duration).toBe(0)
    expect(proj.video_clips[1].transition_in.type).toBe('crossfade') // 'fade' alias
  })

  it('treats trim_end null/"null"/0 as the full clip (no 0.3s flash frame)', () => {
    for (const bad of [null, 'null', 0]) {
      const proj = compilePlanToProject({ clips: [{ video_index: 0, trim_start: 0, trim_end: bad }] }, videos, {})
      expect(proj.video_clips[0].src_out).toBe(10) // full source duration
    }
  })

  it('overlaps transitions: clip 2 starts before clip 1 fully ends', () => {
    const plan = {
      clips: [
        { video_index: 0, trim_start: 0, trim_end: 5, transition: 'cut' },
        { video_index: 1, trim_start: 0, trim_end: 4, transition: 'crossfade', transition_duration: 0.6 },
      ],
    }
    const proj = compilePlanToProject(plan, videos, {})
    // clip 1 plays 5s; clip 2 should start at 5 - 0.6 = 4.4 (transition overlap)
    expect(proj.video_clips[1].in_track).toBeCloseTo(4.4, 5)
  })

  it('carries subtitle_style + auto_subtitle into _ai (prompt-driven look)', () => {
    const proj = compilePlanToProject(
      { clips: [{ video_index: 0 }], auto_subtitle: true, subtitle_style: 'neon' },
      videos, {},
    )
    expect(proj._ai.subtitle_style).toBe('neon')
    expect(proj._ai.auto_subtitle).toBe(true)
  })

  it('defaults subtitle_style to tiktok when unspecified', () => {
    const proj = compilePlanToProject({ clips: [{ video_index: 0 }] }, videos, {})
    expect(proj._ai.subtitle_style).toBe('tiktok')
  })
})
