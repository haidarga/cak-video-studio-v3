import { describe, it, expect } from 'vitest'
import { needsLongForm, planToJobs, planTotalSeconds, arDims, buildConcatProject } from './long-form.js'

describe('needsLongForm', () => {
  it('true only when total exceeds the model cap', () => {
    expect(needsLongForm(26, 8)).toBe(true)
    expect(needsLongForm(8, 8)).toBe(false)
    expect(needsLongForm(5, 8)).toBe(false)
  })
})

describe('planToJobs — cut vs continuous follows the naskah', () => {
  const segments = [
    { n: 1, video_motion: 'Emma opens, talking to camera', dialog: 'halo mak', seconds: 8, transition: 'continuous' },
    { n: 2, video_motion: 'she keeps talking, same shot', dialog: 'parenting itu', seconds: 8, transition: 'continuous' },
    { n: 3, video_motion: 'CUT to b-roll of the kids', dialog: '', seconds: 6, transition: 'cut' },
    { n: 4, video_motion: 'back to Emma closing', dialog: 'semangat ya', seconds: 8, transition: 'continuous' },
  ]

  it('first segment is always "start" (no handoff)', () => {
    const jobs = planToJobs(segments, { maxDuration: 8 })
    expect(jobs[0].transition).toBe('start')
    expect(jobs[0].useHandoff).toBe(false)
  })
  it('continuous segments get a frame handoff; cuts do not', () => {
    const jobs = planToJobs(segments, { maxDuration: 8 })
    expect(jobs[1].transition).toBe('continuous')
    expect(jobs[1].useHandoff).toBe(true)
    expect(jobs[2].transition).toBe('cut')      // CUT to b-roll → fresh gen
    expect(jobs[2].useHandoff).toBe(false)
    expect(jobs[3].useHandoff).toBe(true)
  })
  it('caps each segment duration to the model max', () => {
    const jobs = planToJobs([{ video_motion: 'x', seconds: 15 }], { maxDuration: 8 })
    expect(jobs[0].duration).toBe(8)
  })
  it('defaults an unknown/missing transition to a safe cut (not a bad handoff)', () => {
    const jobs = planToJobs([{ video_motion: 'a' }, { video_motion: 'b' }], { maxDuration: 8 })
    expect(jobs[1].transition).toBe('cut')
  })
  it('carries motion + dialog through', () => {
    const jobs = planToJobs(segments, { maxDuration: 8 })
    expect(jobs[0].motion).toMatch(/Emma opens/)
    expect(jobs[0].dialog).toBe('halo mak')
  })
})

describe('planTotalSeconds', () => {
  it('sums capped durations', () => {
    const jobs = planToJobs([{ seconds: 8 }, { seconds: 8 }, { seconds: 6 }], { maxDuration: 8 })
    expect(planTotalSeconds(jobs)).toBe(22)
  })
})

describe('arDims', () => {
  it('maps aspect ratio to canvas dimensions', () => {
    expect(arDims('9:16')).toEqual({ width: 1080, height: 1920 })
    expect(arDims('16:9')).toEqual({ width: 1920, height: 1080 })
    expect(arDims('1:1')).toEqual({ width: 1080, height: 1080 })
  })
})

describe('buildConcatProject — sequential stitch project', () => {
  const clips = [
    { url: 'https://x/1.mp4', duration: 8 },
    { url: 'https://x/2.mp4', duration: 6 },
    { url: 'https://x/3.mp4', duration: 8 },
  ]
  it('lays clips back-to-back on the base track in order', () => {
    const p = buildConcatProject(clips, { ar: '9:16' })
    expect(p.clips.map((c) => c.in_track)).toEqual([0, 8, 14])
    expect(p.clips.map((c) => c.src_url)).toEqual(['https://x/1.mp4', 'https://x/2.mp4', 'https://x/3.mp4'])
    expect(p.clips.every((c) => c.track_idx === 0 && c.src_in === 0)).toBe(true)
    expect(p.durationSec).toBe(22)
  })
  it('uses the AR canvas size', () => {
    expect(buildConcatProject(clips, { ar: '9:16' })).toMatchObject({ width: 1080, height: 1920, fps: 30 })
  })
  it('drops empty/invalid clips', () => {
    const p = buildConcatProject([{ url: 'https://x/1.mp4', duration: 8 }, { duration: 5 }, null], { ar: '9:16' })
    expect(p.clips).toHaveLength(1)
  })
})
