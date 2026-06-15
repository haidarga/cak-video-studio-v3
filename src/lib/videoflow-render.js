// VideoFlow render path — SPIKE / parallel to editor-render.js (ffmpeg.wasm).
//
// WHY: ffmpeg.wasm render is single-thread, tab-bound, and the root of the
// "patah-patah / lag" pain. VideoFlow's browser renderer uses WebCodecs
// (GPU-accelerated) and the SAME compiled JSON renders on a server later
// (@videoflow/renderer-server, headless Chromium) — one format, browser +
// server. This module converts our existing `project` model (see
// ai-edit-compose.js / editor-render.js) into a VideoFlow build and renders it.
//
// SCOPE (phase 1 — the 80%):
//   ✅ base-track video clips: trim (sourceStart/sourceDuration), speed,
//      volume, per-clip enter transition, ken-burns zoom, color filters
//   ✅ PiP overlay clips (track_idx>0): position + scale + opacity
//   ✅ text overlays: TEXT_STYLES (color/bg/weight/size), position, fade-in
//   ✅ image overlays
//   ✅ BGM audio + per-clip cloned-voice audio (native muted when swapped)
//
// DEFERRED (phase 2 — falls back to ffmpeg via shouldUseVideoFlow guard):
//   ⏳ karaoke word-level fill (rendered as plain timed text here)
//   ⏳ BGM auto-duck under cloned voice (needs volume keyframes)
//   ⏳ speed ramps (speed_in/speed_out)
//   ⏳ exact pan focus point on ken-burns (zoom is centered here)
//   ⏳ full transition-variety fidelity (mapped conservatively, unknown→fade)
//
// Nothing here touches editor-render.js — it's a standalone alternate path so
// the existing pipeline stays the safe fallback.

// ── Canvas dims per aspect ratio (matches editor-render.js) ──
function dimsForAr(ar) {
  if (ar === '16:9') return { width: 1920, height: 1080 }
  if (ar === '1:1') return { width: 1080, height: 1080 }
  return { width: 1080, height: 1920 } // 9:16 default
}

// Map our transition names → VideoFlow built-in preset names. Conservative:
// only names we've verified ship with the browser renderer; everything else
// degrades to 'fade' so the renderer never throws on an unregistered preset.
// Transition-variety fidelity is a phase-2 refinement.
function vfTransition(type) {
  switch (type) {
    case 'cut': return null
    case 'hblur': case 'blur': return 'blurResolve'
    case 'dissolve': return 'noiseDissolve'
    case 'zoomin': case 'radial': return 'zoom'
    // crossfade/fade/fadeblack/fadewhite/wipe*/slide*/circle*/pixelize → fade
    default: return 'fade'
  }
}

// Our text `size` is in px on the render canvas. VideoFlow font sizes are in
// `em` where 1em = 1% of project width. So px → em = size / (width/100).
function pxToEm(px, width) {
  return Math.max(0.5, (px || 48) / (width / 100))
}

// Glow recipe for subtitles/text. ffmpeg path couldn't draw glow (preview-only);
// VideoFlow can via textShadow + stroke. blur/width are in em relative to the
// layer's own font-size, so they scale with the text. Black stroke keeps text
// legible over busy footage; the colored shadow is the actual "glow".
const GLOW = {
  shadowColor: '#4ade80', // neon green glow (matches the 'neon' TEXT_STYLE)
  shadowBlur: 0.45,       // em — fat, soft halo
  strokeColor: '#000000',
  strokeWidth: 0.07,      // em — thin dark outline for separation
}
function applyGlow(props, color) {
  props.textShadow = true
  // Glow in the text's own colour when it's non-white (cohesive), else neon green.
  props.textShadowColor = (color && color.toLowerCase() !== '#ffffff') ? color : GLOW.shadowColor
  props.textShadowBlur = GLOW.shadowBlur
  props.textShadowOffset = [0, 0] // even halo, not a drop shadow
  props.textStroke = true
  props.textStrokeColor = GLOW.strokeColor
  props.textStrokeWidth = GLOW.strokeWidth
  return props
}

// A text clip is a SUBTITLE (auto-subtitle / karaoke) when it carries word
// timings or the karaoke animation. These get folded into a single
// CaptionsLayer (one caption visible at a time → no overlap). Everything else
// (hooks, CTAs, manual overlays) stays an individual text layer.
function isSubtitleClip(tx) {
  return tx.animation === 'karaoke' || (Array.isArray(tx.words) && tx.words.length > 0)
}

// Build a VideoFlow instance from our project model. Pure data → builder; the
// caller compiles + renders. Dynamic import keeps @videoflow/core out of the
// server bundle (this only ever runs in the browser for now).
export async function buildVideoFlow(project) {
  const { default: VideoFlow } = await import('@videoflow/core')
  const { width, height } = dimsForAr(project.ar || '9:16')
  const $ = new VideoFlow({
    name: project.name || 'CAK Edit',
    width, height, fps: 30,
    backgroundColor: '#000000',
    // We position every layer with an explicit startTime, so the flow pointer
    // never needs to auto-advance — autoDetect still resolves media durations.
    autoDetectDurations: true,
  })

  const videoClips = Array.isArray(project.video_clips) ? project.video_clips : []
  // Base track first (in timeline order), then overlays — z-order via `index`.
  const sorted = [...videoClips].sort((a, b) => (a.track_idx - b.track_idx) || (a.in_track - b.in_track))

  let totalDur = 0
  for (const c of sorted) {
    const srcIn = Math.max(0, Number(c.src_in) || 0)
    const srcOut = Number(c.src_out) || (srcIn + 1)
    const segDur = Math.max(0.1, srcOut - srcIn) // source seconds
    const startTime = Math.max(0, Number(c.in_track) || 0)
    const speed = Number(c.speed) || 1
    const isPiP = (c.track_idx || 0) > 0
    totalDur = Math.max(totalDur, startTime + segDur / speed)

    const props = { fit: 'cover' }
    // Audio: mute native when a cloned voice replaces it; else honor volume.
    props.volume = c.use_cloned_voice ? 0 : (c.volume == null ? 1 : c.volume)

    if (isPiP && c.position) {
      props.position = [(c.position.x_pct ?? 50) / 100, (c.position.y_pct ?? 50) / 100]
      props.scale = (c.position.w_pct ?? 40) / 100
      props.opacity = c.position.opacity == null ? 1 : c.position.opacity
    } else if (c.zoom && c.zoom > 1) {
      props.scale = c.zoom // centered ken-burns (exact pan focus = phase 2)
    }

    if (c.filters) {
      const f = c.filters
      if (f.brightness) props.filterBrightness = 1 + Number(f.brightness) // additive → CSS multiplier
      if (f.contrast != null && f.contrast !== 1) props.filterContrast = Number(f.contrast)
      if (f.saturation != null && f.saturation !== 1) props.filterSaturate = Number(f.saturation)
      if (f.blur) props.filterBlur = Number(f.blur)
    }

    const settings = {
      source: c.src_url,
      startTime,
      sourceStart: srcIn,
      sourceDuration: segDur,
      speed,
    }
    const t = c.transition_in
    if (t && t.type && t.type !== 'cut' && t.duration > 0) {
      const name = vfTransition(t.type)
      if (name) settings.transitionIn = { transition: name, duration: t.duration }
    }

    $.addVideo(props, settings, { waitFor: 0, index: c.track_idx || 0 })

    // Per-clip cloned voice → its own audio layer aligned to the clip window.
    if (c.use_cloned_voice && c.cloned_audio_url) {
      $.addAudio(
        { volume: 1 },
        { source: c.cloned_audio_url, startTime, sourceDuration: segDur / speed },
        { waitFor: 0 },
      )
    }
  }

  // ── Image overlays ──
  for (const im of (project.image_clips || [])) {
    const start = Number(im.start) || 0
    const end = Number(im.end) || (start + 2)
    $.addImage(
      {
        fit: 'contain',
        position: [(im.x_pct ?? 50) / 100, (im.y_pct ?? 50) / 100],
        scale: (im.w_pct ?? 30) / 100,
        opacity: im.opacity == null ? 1 : im.opacity,
      },
      { source: im.src_url, startTime: start, sourceDuration: Math.max(0.1, end - start) },
      { waitFor: 0, index: 40 },
    )
  }

  // ── Subtitles → ONE CaptionsLayer (fixes the 24-overlapping-clips bug) ──
  // CaptionsLayer shows the active caption at each frame, so only one phrase is
  // ever on screen. We sort by time and CLAMP each end to the next start so two
  // captions can never overlap even if the source timings did. Glowing style.
  const allText = project.text_clips || []
  const subs = allText.filter(isSubtitleClip)
    .map((tx) => ({ caption: (tx.text || '').trim(), startTime: Number(tx.start) || 0, endTime: Number(tx.end) || ((Number(tx.start) || 0) + 1), color: tx.color, size: tx.size }))
    .filter((c) => c.caption)
    .sort((a, b) => a.startTime - b.startTime)
  // No-overlap clamp: each caption ends at most when the next begins.
  for (let i = 0; i < subs.length - 1; i++) {
    if (subs[i].endTime > subs[i + 1].startTime) subs[i].endTime = subs[i + 1].startTime
  }
  if (subs.length) {
    const subColor = subs[0].color || '#ffffff'
    const capProps = {
      fontSize: pxToEm(subs[0].size || 54, width),
      color: subColor,
      fontWeight: 900,
      textAlign: 'center',
      position: [0.5, 0.82], // lower-third, centered
    }
    applyGlow(capProps, subColor)
    $.addCaptions(
      capProps,
      {
        startTime: 0,
        sourceDuration: Math.max(0.5, totalDur),
        captions: subs.map(({ caption, startTime, endTime }) => ({ caption, startTime, endTime: Math.max(startTime + 0.2, endTime) })),
        maxLines: 2,
      },
      { waitFor: 0, index: 50 },
    )
  }

  // ── Non-subtitle text overlays (hooks, CTAs, manual) → individual layers ──
  for (const tx of allText.filter((t) => !isSubtitleClip(t))) {
    const start = Number(tx.start) || 0
    const end = Number(tx.end) || (start + 1)
    const color = tx.color || '#ffffff'
    const props = {
      text: tx.text || '',
      fontSize: pxToEm(tx.size, width),
      color,
      fontWeight: tx.weight || 700,
      textAlign: tx.align || 'center',
      position: [(tx.x_pct ?? 50) / 100, (tx.y_pct ?? 88) / 100],
    }
    if (tx.bg && tx.bg !== 'transparent') {
      props.backgroundColor = tx.bg
      props.padding = 0.3 // em, relative to the text's own font-size
    } else {
      // No box → give it glow so it stays readable + matches the subtitle look.
      applyGlow(props, color)
    }
    const settings = { startTime: start, sourceDuration: Math.max(0.3, end - start) }
    if (tx.animation === 'fade' || tx.animation === 'pop') {
      settings.transitionIn = { transition: 'fade', duration: 0.25 }
    }
    $.addText(props, settings, { waitFor: 0, index: 51 })
  }

  // ── BGM (first audio_clip only, matching editor-render) ── ducking deferred
  const bgm = (project.audio_clips || [])[0]
  if (bgm && bgm.src_url) {
    const srcStart = Number(bgm.src_start) || 0
    const dur = bgm.src_end != null
      ? Math.max(0.1, Number(bgm.src_end) - srcStart)
      : Math.max(0.5, totalDur) // cover the whole timeline
    $.addAudio(
      { volume: bgm.volume == null ? 0.3 : bgm.volume },
      { source: bgm.src_url, startTime: Number(bgm.start) || 0, sourceStart: srcStart, sourceDuration: dur },
      { waitFor: 0 },
    )
  }

  return $
}

// Render a project via VideoFlow's WebCodecs browser renderer.
// Returns { blob, ext, mime } — same shape as renderProject() in
// editor-render.js, so it's a drop-in alternate.
export async function renderProjectVF(project, onProgress, _opts = {}) {
  onProgress?.('Building VideoFlow project...')
  const $ = await buildVideoFlow(project)
  onProgress?.('Rendering (WebCodecs)...')
  // renderVideo auto-detects browser → @videoflow/renderer-browser → Blob.
  const blob = await $.renderVideo({
    worker: true,
    onProgress: (p) => onProgress?.(`Rendering ${Math.round((p || 0) * 100)}% (WebCodecs)`),
  })
  return { blob, ext: 'mp4', mime: 'video/mp4' }
}

// Whether a project is fully expressible in the phase-1 VideoFlow path.
// If it uses a deferred feature, callers should fall back to renderProject()
// (ffmpeg) so we never silently drop karaoke fill / ducking / speed ramps.
export function vfCanRenderProject(project) {
  const reasons = []
  for (const c of (project.video_clips || [])) {
    if (c.speed_in != null || c.speed_out != null) reasons.push('speed-ramp')
    if (c.use_cloned_voice && (project.audio_clips || [])[0]) reasons.push('bgm-duck')
  }
  // NOTE: karaoke/subtitles are now handled via CaptionsLayer (phase 2) — no
  // longer a blocker. Only true per-word HIGHLIGHT fill remains unsupported,
  // and we render those as clean one-at-a-time glowing captions instead.
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}
