import { describe, it, expect } from 'vitest'
import { vfCanRenderProject } from './videoflow-render.js'

// vfCanRenderProject is the gate that decides VideoFlow (WebCodecs) vs the
// ffmpeg fallback. It must allow the common case (incl. karaoke after phase 2)
// and only defer the genuinely-unsupported features.
describe('vfCanRenderProject', () => {
  it('allows a plain project', () => {
    const r = vfCanRenderProject({ video_clips: [{ src_url: 'x', speed: 1 }], text_clips: [] })
    expect(r.ok).toBe(true)
    expect(r.reasons).toEqual([])
  })

  it('allows karaoke/subtitle projects (handled via CaptionsLayer in phase 2)', () => {
    const r = vfCanRenderProject({
      video_clips: [{ src_url: 'x' }],
      text_clips: [{ animation: 'karaoke', words: [{ word: 'hi', start: 0, end: 1 }] }],
    })
    expect(r.ok).toBe(true)
  })

  it('defers speed ramps', () => {
    const r = vfCanRenderProject({ video_clips: [{ src_url: 'x', speed_in: 1, speed_out: 2 }] })
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('speed-ramp')
  })

  it('defers BGM ducking only when cloned voice AND a music track both exist', () => {
    const withBoth = vfCanRenderProject({
      video_clips: [{ src_url: 'x', use_cloned_voice: true }],
      audio_clips: [{ src_url: 'bgm.mp3' }],
    })
    expect(withBoth.reasons).toContain('bgm-duck')

    const voiceNoMusic = vfCanRenderProject({
      video_clips: [{ src_url: 'x', use_cloned_voice: true }],
      audio_clips: [],
    })
    expect(voiceNoMusic.ok).toBe(true) // nothing to duck → fine
  })

  it('dedupes repeated reasons across multiple clips', () => {
    const r = vfCanRenderProject({
      video_clips: [{ speed_in: 1 }, { speed_out: 2 }],
    })
    expect(r.reasons).toEqual(['speed-ramp'])
  })
})
