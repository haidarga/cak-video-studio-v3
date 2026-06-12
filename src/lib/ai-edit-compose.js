// AI Edit (prompt-driven) — client-side half of the QC "🪄 AI Edit" flow.
//
//   QC: select videos → user types edit prompt → probeDurations() →
//   POST /api/editor/ai-compose (Gemini returns a structured plan) →
//   compilePlanToProject() → insert editor_projects row →
//   navigate /editor?project=<id> → editor auto-loads, optionally
//   auto-runs karaoke subtitles (plan.auto_subtitle), user previews →
//   export → result lands back in QC.
//
// The compiler emits the editor's v4-native clip shape (track_idx +
// in_track). normalizeProject() backfills filters/transition/position
// defaults, so only the meaningful fields are written here.

function uid() { return Math.random().toString(36).slice(2, 10) }

// Friendly transition names → ffmpeg xfade types the renderer understands
// (see editor-render xfadeMap). "lightleak" has no true xfade equivalent —
// fadewhite (white flash) is the standard stand-in and reads the same.
const TRANSITION_ALIASES = {
  blur: 'hblur', lightleak: 'fadewhite', flash: 'fadewhite',
  fade: 'crossfade', whip: 'slideleft', spin: 'radial',
}
export function normalizeTransition(t) {
  const k = String(t || 'cut').toLowerCase()
  return TRANSITION_ALIASES[k] || k
}

// Text style templates — combos of what the MP4 renderer can actually draw
// (color / box / weight / size; fancy fonts+glow are editor-preview only).
export const TEXT_STYLES = {
  tiktok: { color: '#ffffff', bg: 'rgba(0,0,0,0.85)', weight: 900, size: 54 },
  clean:  { color: '#ffffff', bg: 'transparent',      weight: 700, size: 48 },
  yellow: { color: '#fde047', bg: 'rgba(0,0,0,0.85)', weight: 900, size: 56 },
  neon:   { color: '#4ade80', bg: 'rgba(0,0,0,0.65)', weight: 800, size: 52 },
  pink:   { color: '#f472b6', bg: 'rgba(0,0,0,0.75)', weight: 900, size: 54 },
  bigpop: { color: '#ffffff', bg: 'rgba(220,38,38,0.9)', weight: 900, size: 64 },
}

// Probe real durations in the browser — exact timestamps let the LLM
// place trims/texts on real times instead of guessing.
export function probeDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.src = url
    const done = (d) => { v.src = ''; resolve(d) }
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 10)
    v.onerror = () => done(10)
    setTimeout(() => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 10), 8000)
  })
}

export async function probeDurations(videos) {
  return Promise.all(videos.map(async (v) => ({ ...v, duration: await probeDuration(v.url) })))
}

// plan (from /api/editor/ai-compose) + videos [{url,label,duration}] →
// editor project config JSON.
export function compilePlanToProject(plan, videos, { ar = '9:16', maxTrimPct = null } = {}) {
  let acc = 0
  const video_clips = (plan.clips || []).map((c, i) => {
    const v = videos[Math.max(0, Math.min(videos.length - 1, parseInt(c.video_index) || 0))]
    const dur = Math.max(0.5, v.duration || 10)
    let sIn = Math.max(0, Math.min(parseFloat(c.trim_start) || 0, dur - 0.3))
    const sOutRaw = c.trim_end == null ? dur : parseFloat(c.trim_end)
    let sOut = Math.max(sIn + 0.3, Math.min(Number.isFinite(sOutRaw) ? sOutRaw : dur, dur))
    // Over-trim guard (opt-in): the LLM sometimes hacks 40%+ off a clip and
    // the result reads as broken jump cuts. F Creator caps trims at 25% per
    // end; QC AI Edit stays uncapped (compilations legitimately trim hard).
    if (maxTrimPct != null) {
      sIn = Math.min(sIn, dur * maxTrimPct)
      sOut = Math.max(sOut, Math.max(sIn + 0.3, dur * (1 - maxTrimPct)))
    }
    const speed = Math.max(0.5, Math.min(2, parseFloat(c.speed) || 1))
    const tType = i === 0 ? 'cut' : normalizeTransition(c.transition)
    const tDur = tType === 'cut' ? 0 : Math.max(0.2, Math.min(0.8, parseFloat(c.transition_duration) || 0.4))
    if (i > 0 && tType !== 'cut') acc -= tDur // transitions overlap the previous clip
    const zoom = c.zoom && parseFloat(c.zoom) > 1 ? Math.min(1.4, parseFloat(c.zoom)) : null
    const clip = {
      id: uid(),
      src_url: v.url,
      src_label: v.label || `clip ${i + 1}`,
      src_duration: dur,
      src_in: sIn,
      src_out: sOut,
      speed,
      volume: 1,
      track_idx: 0,
      in_track: Math.max(0, acc),
      transition_in: { type: tType, duration: tDur },
      ...(zoom ? { zoom, pan_x_pct: 50, pan_y_pct: 45 } : {}),
    }
    acc += (sOut - sIn) / speed
    return clip
  })

  const totalDur = Math.max(1, acc)
  const text_clips = (plan.texts || []).slice(0, 12).map((t) => {
    const start = Math.max(0, Math.min(parseFloat(t.start) || 0, totalDur - 0.5))
    const endRaw = parseFloat(t.end)
    const end = Math.max(start + 0.5, Math.min(Number.isFinite(endRaw) ? endRaw : start + 3, totalDur))
    const tpl = TEXT_STYLES[t.style] || TEXT_STYLES.tiktok
    return {
      id: uid(), kind: 'text',
      text: String(t.text || '').slice(0, 140),
      start, end, track_idx: 0,
      x_pct: 50,
      y_pct: t.position === 'top' ? 18 : t.position === 'center' ? 50 : 78,
      size: Math.max(28, Math.min(80, parseInt(t.size) || tpl.size)),
      scale: 1, max_width_pct: 90,
      color: tpl.color, weight: tpl.weight,
      bg: tpl.bg,
      align: 'center', animation: 'fade',
    }
  })

  return {
    name: String(plan.project_name || 'AI Edit').slice(0, 60),
    ar,
    persona_id: null,
    video_clips,
    text_clips,
    image_clips: [],
    audio_clips: [],
    // Editor reads this on load: auto-runs karaoke transcription, then
    // clears the flag so manual re-loads don't re-transcribe.
    _ai: {
      notes: String(plan.notes || '').slice(0, 300),
      auto_subtitle: !!plan.auto_subtitle,
      karaoke: plan.karaoke !== false,
    },
  }
}
