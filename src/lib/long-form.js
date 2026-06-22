// Long-form auto-chain — turn a naskah longer than the model's per-clip cap
// into ONE video by splitting it into segments, generating each in order, and
// stitching them.
//
// The hard parts that live HERE (pure, testable):
//   1. planToJobs — normalize the parser's segment plan into an ordered job
//      list, capping each segment to the model's max clip length and deciding
//      per-segment whether to do a frame HANDOFF (continuous) or a clean CUT.
//      This is the "ngikutin naskah" rule: the naskah's own structure drives
//      cut-vs-continuous, we never force one or the other.
//   2. buildConcatProject — assemble the gen'd clip URLs into the editor-render
//      project shape (sequential base-track clips) so renderProject() can
//      stitch them into a single file.
//
// The orchestration (calling the parser, genning each clip, extracting last
// frames, rendering) lives in the Generate client; it leans on these helpers.

// A naskah needs the long-form flow only when its planned length exceeds what
// the chosen model can produce in a single clip.
export function needsLongForm(totalSec, maxDuration) {
  return (Number(totalSec) || 0) > (Number(maxDuration) || 0)
}

// Normalize the parser's segment plan into ordered jobs.
//   - duration is clamped to [1, maxDuration] (the model can't exceed its cap).
//   - transition: the FIRST segment is 'start'; every later segment is either
//     'continuous' (flows from the previous shot → frame handoff) or 'cut'
//     (new scene/angle → generate fresh). Anything not explicitly 'continuous'
//     defaults to 'cut' — a wrong handoff morphs, a wrong cut is just a clean
//     edit, so 'cut' is the safe default.
export function planToJobs(segments = [], { maxDuration = 8 } = {}) {
  const arr = Array.isArray(segments) ? segments.filter(Boolean) : []
  return arr.map((s, i) => {
    const transition = i === 0
      ? 'start'
      : (String(s.transition || '').toLowerCase() === 'continuous' ? 'continuous' : 'cut')
    const requested = parseInt(s.seconds ?? s.duration)
    const duration = Math.max(1, Math.min(maxDuration, Number.isFinite(requested) ? requested : maxDuration))
    return {
      index: i,
      motion: String(s.video_motion || s.motion || '').trim(),
      dialog: String(s.dialog || '').trim(),
      duration,
      transition,
      // Only continuous segments get the previous clip's last frame as an
      // anchor; the first segment and any cut start fresh from refs.
      useHandoff: transition === 'continuous',
    }
  })
}

export function planTotalSeconds(jobs = []) {
  return (jobs || []).reduce((sum, j) => sum + (Number(j?.duration) || 0), 0)
}

// Canvas dimensions for the stitch project, per aspect ratio.
export function arDims(ar) {
  if (ar === '16:9') return { width: 1920, height: 1080 }
  if (ar === '1:1') return { width: 1080, height: 1080 }
  return { width: 1080, height: 1920 } // 9:16 default (vertical UGC)
}

// Build the editor-render project that concatenates the gen'd clips in order.
// `clips` = [{ url, duration }] in playback order. Produces sequential base-
// track clips (track_idx 0, back-to-back in_track) matching the shape
// renderProject()/editor-render.js expects (src_url + src_in/src_out/speed).
export function buildConcatProject(clips = [], { ar = '9:16', fps = 30 } = {}) {
  const { width, height } = arDims(ar)
  let cursor = 0
  const built = (clips || []).filter((c) => c && c.url).map((c, i) => {
    const dur = Math.max(0.1, Number(c.duration) || 0)
    const clip = {
      id: `lf-${i}`,
      type: 'video',
      src_url: c.url,
      track_idx: 0,
      in_track: cursor,
      src_in: 0,
      src_out: dur,
      speed: 1,
    }
    cursor += dur
    return clip
  })
  return { clips: built, width, height, fps, durationSec: cursor, captions: [], capStyle: {}, audio: null }
}
