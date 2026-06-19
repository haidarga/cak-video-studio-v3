// Map ASR speech segments (timed against the FULL source clip) onto the editor
// timeline. A clip on the timeline is TRIMMED (src_in/src_out), may be SPED UP,
// and starts at in_track — so raw segment times don't line up. This applies:
//
//   timelineTime = in_track + (sourceTime − src_in) / speed
//
// and DROPS speech outside the trim window (that's the bug that made subtitles
// spill past the visible clip). Pure function — extracted from the editor's
// autoSubtitle so the math is unit-testable.
//
// Returns [{ text, start, end, words }] in timeline seconds. `words` is the
// per-word karaoke timing (also mapped + clamped) when karaoke is on, else null.
export function mapSpeechToTimeline(segments, clip = {}, { karaoke = false } = {}) {
  const inTrack = clip.in_track || 0
  const srcIn = Number(clip.src_in) || 0
  const srcOut = clip.src_out != null ? Number(clip.src_out) : Infinity
  const spd = Number(clip.speed) || 1
  const toTL = (t) => inTrack + (Math.max(srcIn, Math.min(srcOut, t)) - srcIn) / spd

  return (segments || [])
    // keep only segments that actually overlap the trimmed window
    .filter((s) => s.end > srcIn && s.start < srcOut)
    .map((s) => {
      const start = toTL(s.start)
      const end = Math.max(start + 0.2, toTL(s.end)) // floor so a sliver still shows
      const words = karaoke && Array.isArray(s.words)
        ? s.words
            .filter((w) => w.end > srcIn && w.start < srcOut)
            .map((w) => ({ ...w, start: toTL(w.start), end: Math.max(toTL(w.start) + 0.05, toTL(w.end)) }))
        : null
      return { text: s.text, start, end, words }
    })
}
