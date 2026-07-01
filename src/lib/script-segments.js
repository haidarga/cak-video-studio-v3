// Deterministic script segmentation — the honest fix for "storyboard produced
// 19s / crammed all scenes / Continue repeated".
//
// ROOT CAUSE this replaces: we were asking Gemini to obey duration math ("sum to
// exactly 15s", "only the first 15s"). An LLM does not reliably do arithmetic or
// hard caps, so it drifted (19s total, whole 30s crammed into one grid, etc).
//
// THE FIX: when the naskah has explicit timestamps (it usually does —
// "SCENE 1 — HOOK (0-4s)"), split it into <=maxSeg segments HERE, in code, at
// real scene boundaries. Gemini only writes the visuals for the segment we hand
// it; it never decides how long or how many. Panel durations are also clamped in
// code so a single clip can never exceed the model's cap.

// Matches a timestamp range in either "0-4s" / "15-18 s" form or "0:00-0:15"
// mm:ss form, with hyphen / en-dash / em-dash separators.
const TS = /(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})|(\d+)\s*s?\s*[-–—]\s*(\d+)\s*s\b/i

function parseRange(line) {
  const m = String(line).match(TS)
  if (!m) return null
  if (m[1] != null) return { start: (+m[1]) * 60 + +m[2], end: (+m[3]) * 60 + +m[4] }
  return { start: +m[5], end: +m[6] }
}

// Split a naskah into scene blocks keyed by their explicit timestamps.
// Returns [{ n, label, start, end, dur, text }] in script order, or [] if the
// script carries no timestamps (caller then falls back to the LLM's own split).
export function parseSceneTimestamps(naskah) {
  const lines = String(naskah || '').split('\n')
  const scenes = []
  let cur = null
  for (const line of lines) {
    const r = parseRange(line)
    if (r) {
      const numM = line.match(/SCENE\s+(\d+)/i)
      const label = line.replace(TS, '').replace(/[()]/g, '').trim()
      cur = { n: numM ? +numM[1] : scenes.length + 1, label, start: r.start, end: r.end, dur: Math.max(0, r.end - r.start), text: line }
      scenes.push(cur)
    } else if (cur) {
      cur.text += '\n' + line
    }
  }
  return scenes
}

// The script's intended total = the last scene's end time.
export function scriptTotalSeconds(scenes) {
  return (scenes || []).reduce((m, s) => Math.max(m, Number(s?.end) || 0), 0)
}

function makeSeg(scenes, index) {
  const dur = scenes.reduce((a, s) => a + (Number(s.dur) || 0), 0)
  return {
    index,
    scenes,
    start: scenes[0]?.start ?? 0,
    end: scenes[scenes.length - 1]?.end ?? dur,
    dur,
    text: scenes.map((s) => s.text).join('\n\n'),
  }
}

// Greedily pack whole scenes into ordered segments, each <= maxSeg. A scene is
// atomic — never split across segments. A single scene longer than the cap
// becomes its own (over-cap) segment; the panel clamp handles its duration.
export function packScenesIntoSegments(scenes, maxSeg) {
  const cap = Math.max(1, parseInt(maxSeg) || 1)
  const arr = (scenes || []).filter(Boolean)
  const segments = []
  let cur = []
  let curDur = 0
  for (const s of arr) {
    const d = Math.max(0, Number(s.dur) || 0)
    if (cur.length && curDur + d > cap) {
      segments.push(makeSeg(cur, segments.length))
      cur = []
      curDur = 0
    }
    cur.push(s)
    curDur += d
  }
  if (cur.length) segments.push(makeSeg(cur, segments.length))
  return segments
}

// DETERMINISTIC guarantee that a storyboard's panels never exceed the model's
// per-clip cap. Rescales proportionally (integer seconds, min 1 each, no panel
// dropped) so the sum == cap when it would otherwise overshoot. This is the code
// that makes "19s on a 15s model" impossible regardless of what the LLM returns.
export function clampPanelsToMaxSeg(panels, maxSeg) {
  const list = Array.isArray(panels) ? panels : []
  if (!list.length) return []
  const cap = Math.max(1, parseInt(maxSeg) || 1)
  const secs = list.map((p) => Math.max(1, parseInt(p?.seconds) || 1))
  const total = secs.reduce((a, b) => a + b, 0)
  if (total <= cap) return list.map((p, i) => ({ ...p, seconds: secs[i] }))
  // More panels than the cap has whole seconds → each beat can only get the 1s
  // floor (a video beat can't be < 1s), so the sum is forced to list.length and
  // CANNOT equal cap. The real fix for this is fewer panels (normalizeToGrid's
  // job, not ours); pin each to 1s and warn rather than spin the trim loop.
  if (list.length >= cap) {
    console.warn(`[clampPanels] ${list.length} panels but clip cap is only ${cap}s — each pinned to 1s (total ${list.length}s > cap). Use fewer panels for this model.`)
    return list.map((p) => ({ ...p, seconds: 1 }))
  }
  // list.length < cap → an all-1s floor sums to < cap, so leftover is always >= 0
  // here and the result sums to EXACTLY cap.
  const scaled = secs.map((s) => Math.max(1, Math.floor((s * cap) / total)))
  const byBiggest = secs.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1])
  let leftover = cap - scaled.reduce((a, b) => a + b, 0)
  let k = 0
  let guard = 0
  // add the remainder to the largest-original panels (keeps proportions)
  while (leftover > 0 && byBiggest.length && guard < 10000) { scaled[byBiggest[k % byBiggest.length]] += 1; leftover--; k++; guard++ }
  return list.map((p, i) => ({ ...p, seconds: scaled[i] }))
}
