// Editor render pipeline (v4 — multi-track stacking support).
//
// Schema: project.video_clips[] each has:
//   - track_idx: 0 = base (sequential timeline), >0 = overlay (picture-in-picture)
//   - in_track: explicit start time in seconds (replaces sequential computation)
//   - position: { x_pct, y_pct, w_pct, opacity } — only used when track_idx > 0
//
// Render flow:
// 1. Build base track sequence (track_idx=0 clips) via concat + xfade
// 2. For each overlay clip (track_idx>0), apply overlay filter on accumulator
// 3. Image overlays + text overlays on top of all video
// 4. Audio mix from all clips + optional music underlay
//
// Two backends: ffmpeg.wasm (MP4, full features) or canvas+MediaRecorder (WebM fallback).

import { getFontCss } from './editor-fonts.js'
import { proxify } from './editor-proxy.js'

let ffmpegInstance = null
let ffmpegLoading = null

// Word-wrap a string into <= maxWidth lines, honoring explicit \n as hard breaks.
// ctx.font must be set before calling so measureText returns the right widths.
function wrapTextLines(ctx, text, maxWidth) {
  const out = []
  for (const para of String(text || '').split('\n')) {
    if (!para) { out.push(''); continue }
    const words = para.split(/\s+/)
    let line = ''
    for (const w of words) {
      const test = line ? line + ' ' + w : w
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line)
        line = w
      } else {
        line = test
      }
    }
    if (line) out.push(line)
  }
  return out.length ? out : ['']
}

async function getFFmpeg(onLog) {
  if (ffmpegInstance) return ffmpegInstance
  if (ffmpegLoading) return ffmpegLoading
  ffmpegLoading = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { toBlobURL } = await import('@ffmpeg/util')
    const ff = new FFmpeg()
    if (onLog) ff.on('log', ({ message }) => onLog(message))
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'
    await ff.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    ffmpegInstance = ff
    return ff
  })()
  return ffmpegLoading
}

async function fetchToUint8(url) {
  const target = proxify(url)
  const res = await fetch(target, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetch ${url.slice(-40)} -> ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function escapeDrawText(s) {
  return String(s)
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:')
    .replace(/'/g, "'\\''").replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

// ASS color: &H<AA><BB><GG><RR> (note BGR order, with alpha first)
function hexToAss(hex, alpha = 0) {
  const h = hex.replace('#', '').padStart(6, '0')
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6)
  const a = alpha.toString(16).padStart(2, '0')
  return `&H${a.toUpperCase()}${b}${g}${r}`.toUpperCase()
}

// Format seconds → "h:mm:ss.cc" (ASS timestamp)
function fmtAssTime(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${m.toString().padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
}

// Build ASS subtitle file content for karaoke text clips
function buildAssForKaraoke(karaokeClips, canvasDims) {
  if (karaokeClips.length === 0) return null
  const [W, H] = canvasDims
  const lines = []
  lines.push('[Script Info]')
  lines.push('ScriptType: v4.00+')
  lines.push(`PlayResX: ${W}`)
  lines.push(`PlayResY: ${H}`)
  lines.push('WrapStyle: 2')
  lines.push('ScaledBorderAndShadow: yes')
  lines.push('')
  lines.push('[V4+ Styles]')
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding')
  // Primary (inactive) = white, Secondary (active karaoke fill) = amber #fbbf24
  lines.push(`Style: Default,Arial,48,&H00FFFFFF,${hexToAss('#fbbf24')},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,3,5,10,10,10,1`)
  lines.push('')
  lines.push('[Events]')
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

  karaokeClips.forEach((c) => {
    const start = fmtAssTime(c.start || 0)
    const end = fmtAssTime(c.end || 1)
    const x = Math.round((c.x_pct / 100) * W)
    const y = Math.round((c.y_pct / 100) * H)
    const anchor = c.align === 'left' ? 4 : c.align === 'right' ? 6 : 5
    const fontSize = c.size || 56
    const primary = hexToAss(c.color || '#ffffff')
    const positionTag = `{\\an${anchor}\\pos(${x},${y})\\fs${fontSize}\\c${primary}\\3c&H000000&\\3a&H80&\\bord3\\shad3}`

    // Build per-word \k tags (centiseconds)
    const segStart = c.start || 0
    let body = ''
    c.words.forEach((w, i) => {
      const wDur = Math.max(0.01, w.end - w.start)
      // Account for any gap between segStart and first word
      if (i === 0 && w.start > segStart + 0.05) {
        const gapCs = Math.round((w.start - segStart) * 100)
        body += `{\\k${gapCs}}`
      }
      const cs = Math.max(1, Math.round(wDur * 100))
      body += `{\\kf${cs}}${w.word}${i < c.words.length - 1 ? ' ' : ''}`
    })
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${positionTag}${body}`)
  })

  return lines.join('\n')
}

// ── Helpers exported for client ─────────────────────────────────────
export function clipDuration(c) {
  const len = Math.max(0, (c.src_out ?? 0) - (c.src_in ?? 0))
  return len / Math.max(0.01, c.speed || 1)
}

// Base track only (track_idx === 0). Sorted by in_track.
function baseTrackClips(clips) {
  return (clips || []).filter((c) => (c.track_idx || 0) === 0).sort((a, b) => (a.in_track || 0) - (b.in_track || 0))
}
function overlayClips(clips) {
  return (clips || []).filter((c) => (c.track_idx || 0) > 0)
}

// Each base clip's effective end on the timeline
function baseClipEnd(c) { return (c.in_track || 0) + clipDuration(c) }

export function totalDuration(clips) {
  if (!clips || clips.length === 0) return 0
  // Total = max over all clips of (in_track + clipDuration)
  let max = 0
  clips.forEach((c) => {
    const end = (c.in_track || 0) + clipDuration(c)
    if (end > max) max = end
  })
  return max
}

// Find which BASE clip is active at given timeline time (for preview).
// For overlay tracks, multiple clips can be active simultaneously.
export function activeBaseClipAt(t, clips) {
  const base = baseTrackClips(clips)
  for (let i = 0; i < base.length; i++) {
    const c = base[i]
    const start = c.in_track || 0
    const end = start + clipDuration(c)
    if (t >= start && t < end) {
      const srcTime = (c.src_in || 0) + (t - start) * (c.speed || 1)
      return { clip: c, index: i, srcTime, clipStart: start, clipEnd: end }
    }
  }
  // Fallback: last base clip
  if (base.length > 0) {
    const c = base[base.length - 1]
    return { clip: c, index: base.length - 1, srcTime: c.src_out || c.src_in || 0, clipStart: c.in_track || 0, clipEnd: baseClipEnd(c) }
  }
  return null
}

export function activeOverlaysAt(t, clips) {
  return overlayClips(clips).filter((c) => {
    const start = c.in_track || 0
    const end = start + clipDuration(c)
    return t >= start && t < end
  })
}

// ── ffmpeg filter pieces ────────────────────────────────────────────
function videoClipFilter(c, label) {
  // Support speed ramp: speed_in → speed_out linear over clip duration
  // If both set: PTS multiplier varies linearly from 1/speed_in to 1/speed_out
  let setptsExpr
  if (c.speed_in != null && c.speed_out != null) {
    const sIn = c.speed_in, sOut = c.speed_out
    const clipDur = (c.src_out - c.src_in) / ((sIn + sOut) / 2)
    // Linear interpolation: m(t) = 1/sIn + (1/sOut - 1/sIn) * (t / clipDur)
    // Apply to PTS via setpts integral — approximation
    setptsExpr = `setpts='(PTS-STARTPTS)*((1/${sIn})+(((1/${sOut})-(1/${sIn}))*(T/${clipDur.toFixed(3)})))'`
  } else {
    setptsExpr = `setpts=${(1/(c.speed || 1)).toFixed(4)}*(PTS-STARTPTS)`
  }
  const trimSrc = `trim=start=${c.src_in}:end=${c.src_out},${setptsExpr}`
  const f = c.filters || {}
  const eqParts = []
  if (f.brightness != null && f.brightness !== 0) eqParts.push(`brightness=${f.brightness.toFixed(3)}`)
  if (f.contrast != null && f.contrast !== 1) eqParts.push(`contrast=${f.contrast.toFixed(3)}`)
  if (f.saturation != null && f.saturation !== 1) eqParts.push(`saturation=${f.saturation.toFixed(3)}`)
  const eq = eqParts.length ? `,eq=${eqParts.join(':')}` : ''
  const blur = (f.blur && f.blur > 0) ? `,boxblur=${f.blur}:${f.blur}` : ''

  // Zoom + Pan: crop a smaller window from the source then it'll be scaled
  // back up to canvas size. zoom=1 (no zoom) skips the crop entirely.
  // pan_x_pct / pan_y_pct = 0..100, where the focus point lies on each axis.
  // The crop window size = source / zoom; offset positions the window so the
  // pan point sits at the window's center (clamped to source bounds).
  let zoomCrop = ''
  const zoom = parseFloat(c.zoom)
  if (zoom && zoom > 1) {
    const px = Math.max(0, Math.min(100, c.pan_x_pct ?? 50)) / 100
    const py = Math.max(0, Math.min(100, c.pan_y_pct ?? 50)) / 100
    // FFmpeg expressions reference iw/ih = input dimensions at crop time.
    // Window = iw/zoom × ih/zoom; offset so pan_x/y points at center.
    const z = zoom.toFixed(3)
    zoomCrop = `,crop=iw/${z}:ih/${z}:(iw-iw/${z})*${px.toFixed(3)}:(ih-ih/${z})*${py.toFixed(3)}`
  }

  return `${trimSrc}${zoomCrop}${eq}${blur},setsar=1${label}`
}

function audioClipFilter(c, label) {
  const speed = c.speed || 1
  const vol = c.volume ?? 1
  const tempos = []
  let s = speed
  while (s < 0.5) { tempos.push('atempo=0.5'); s /= 0.5 }
  while (s > 2.0) { tempos.push('atempo=2.0'); s /= 2.0 }
  tempos.push(`atempo=${s.toFixed(4)}`)
  return `atrim=start=${c.src_in}:end=${c.src_out},asetpts=PTS-STARTPTS,${tempos.join(',')},volume=${vol.toFixed(2)}${label}`
}

// Collect clips whose audio should be replaced by a cloned voice track.
// Each entry will get its own audio input (mp3) and replace the clip's native
// audio at render time.
function clipsWithClonedVoice(project) {
  const all = project.video_clips || []
  return all.filter((c) => c && c.cloned_audio_url && c.use_cloned_voice !== false)
}

// Build full filter_complex: base concat → overlays → image/text → audio mix
function buildFilterGraph(project, canvasDims, musicInputIdx, clonedAudioInputStartIdx) {
  const allClips = project.video_clips || []
  const base = baseTrackClips(allClips)
  const overlays = overlayClips(allClips)
  if (base.length === 0) throw new Error('Belum ada video di base track')
  const [W, H] = canvasDims

  const lines = []
  const inputIdx = new Map() // clip.id -> input index dalam args ffmpeg
  // Map: clip.id -> cloned-audio input index (if any)
  const clonedAudioInput = new Map()
  const voiced = clipsWithClonedVoice(project)
  if (clonedAudioInputStartIdx != null) {
    voiced.forEach((c, i) => clonedAudioInput.set(c.id, clonedAudioInputStartIdx + i))
  }
  function usesCloned(c) { return clonedAudioInput.has(c.id) }

  // Assign input indices: base clips first, then overlay clips
  base.forEach((c, i) => inputIdx.set(c.id, i))
  overlays.forEach((c, i) => inputIdx.set(c.id, base.length + i))

  // 1) Process base clips: trim/setpts/filters → scale+pad ke canvas
  base.forEach((c) => {
    const idx = inputIdx.get(c.id)
    lines.push(`[${idx}:v]${videoClipFilter(c, `[bv${idx}raw]`)}`)
    lines.push(`[bv${idx}raw]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[bv${idx}]`)
  })

  // 2) Concat base via xfade/cut
  let currentLabel = `[bv${inputIdx.get(base[0].id)}]`
  let accDur = clipDuration(base[0])
  for (let i = 1; i < base.length; i++) {
    const c = base[i]
    const tr = c.transition_in || { type: 'cut' }
    const nextLabel = `[bv${inputIdx.get(c.id)}]`
    const out = `[bseq${i}]`
    if (tr.type === 'cut') {
      lines.push(`${currentLabel}${nextLabel}concat=n=2:v=1:a=0${out}`)
      accDur += clipDuration(c)
    } else {
      const dur = Math.max(0.1, tr.duration || 0.5)
      const offset = Math.max(0, accDur - dur)
      // Map our transition type to ffmpeg xfade transition name
      const xfadeMap = {
        fade: 'fade', crossfade: 'fade',
        fadeblack: 'fadeblack', fadewhite: 'fadewhite',
        wipeleft: 'wipeleft', wiperight: 'wiperight', wipeup: 'wipeup', wipedown: 'wipedown',
        slideleft: 'slideleft', slideright: 'slideright', slideup: 'slideup', slidedown: 'slidedown',
        circleopen: 'circleopen', circleclose: 'circleclose',
        zoomin: 'zoomin', dissolve: 'dissolve', pixelize: 'pixelize',
        radial: 'radial', hblur: 'hblur',
      }
      const xfadeType = xfadeMap[tr.type] || 'fade'
      lines.push(`${currentLabel}${nextLabel}xfade=transition=${xfadeType}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}${out}`)
      accDur += clipDuration(c) - dur
    }
    currentLabel = out
  }

  // 3) Process & overlay each overlay video clip
  overlays.forEach((c, i) => {
    const idx = inputIdx.get(c.id)
    lines.push(`[${idx}:v]${videoClipFilter(c, `[ov${i}raw]`)}`)
    const pos = c.position || { x_pct: 50, y_pct: 50, w_pct: 40, opacity: 1 }
    const overlayW = Math.round((pos.w_pct || 40) / 100 * W)
    const x = Math.round((pos.x_pct / 100) * W)
    const y = Math.round((pos.y_pct / 100) * H)
    // scale overlay + format rgba + alpha for opacity
    const opacity = (pos.opacity ?? 1).toFixed(2)
    lines.push(`[ov${i}raw]scale=${overlayW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[ov${i}]`)
    const inT = (c.in_track || 0).toFixed(3)
    const outT = ((c.in_track || 0) + clipDuration(c)).toFixed(3)
    const out = `[bo${i}]`
    lines.push(`${currentLabel}[ov${i}]overlay=x=${x}-overlay_w/2:y=${y}-overlay_h/2:enable='between(t,${inT},${outT})'${out}`)
    currentLabel = out
  })

  // 4) Image overlays
  ;(project.image_clips || []).forEach((c, i) => {
    const x = Math.round((c.x_pct / 100) * W)
    const y = Math.round((c.y_pct / 100) * H)
    const overlayW = Math.round((c.w_pct || 30) / 100 * W)
    const imgInputIdx = base.length + overlays.length + i
    const out = `[oi${i}]`
    lines.push(`[${imgInputIdx}:v]scale=${overlayW}:-1,format=rgba,colorchannelmixer=aa=${(c.opacity ?? 1).toFixed(2)}[img${i}]`)
    lines.push(`${currentLabel}[img${i}]overlay=x=${x}-overlay_w/2:y=${y}-overlay_h/2:enable='between(t,${(c.start || 0).toFixed(3)},${(c.end || 1).toFixed(3)})'${out}`)
    currentLabel = out
  })

  // 5) Text overlays — split karaoke (ASS subtitles) vs regular (drawtext)
  const allText = project.text_clips || []
  const karaokeText = allText.filter((c) => c.animation === 'karaoke' && Array.isArray(c.words) && c.words.length > 0)
  const regularText = allText.filter((c) => !(c.animation === 'karaoke' && Array.isArray(c.words)))

  regularText.forEach((c, i) => {
    const x = Math.round((c.x_pct / 100) * W)
    const y = Math.round((c.y_pct / 100) * H)
    const fontSize = Math.round(c.size * (W / 720))
    const txt = escapeDrawText(c.text)
    const color = (c.color || '#ffffff').replace('#', '')
    const align = c.align || 'center'
    const xExpr = align === 'left' ? `${x}` : align === 'right' ? `${x}-text_w` : `${x}-text_w/2`
    const boxColor = c.bg && c.bg !== 'transparent' ? ':box=1:boxcolor=black@0.6:boxborderw=12' : ''
    const start = (c.start || 0).toFixed(3)
    const end = (c.end || 1).toFixed(3)
    let alphaExpr = ''
    if (c.animation === 'fade' || c.animation === 'pop') {
      const animDur = 0.25
      alphaExpr = `:alpha='if(between(t,${start},${end}), min(1, min((t-${start})/${animDur}, (${end}-t)/${animDur})), 0)'`
    }
    const out = `[ot${i}]`
    lines.push(`${currentLabel}drawtext=text='${txt}':fontcolor=0x${color}:fontsize=${fontSize}:x=${xExpr}:y=${y}-text_h/2${boxColor}${alphaExpr}:enable='between(t,${start},${end})'${out}`)
    currentLabel = out
  })

  // Apply ASS karaoke subtitle if any karaoke clips exist
  if (karaokeText.length > 0) {
    const out = `[okara]`
    lines.push(`${currentLabel}subtitles=filename=subs.ass${out}`)
    currentLabel = out
  }

  lines.push(`${currentLabel}copy[vout]`)

  // 6) Audio: from BASE clips concat + overlay clips mixed by position + cloned voices
  // Clips with use_cloned_voice get their native audio silenced (volume=0). The
  // cloned audio is then mixed in separately as a delayed track at the clip's
  // in_track position. Preserves all original timing — cloned voice IS the
  // original audio converted, so lip-sync stays in sync.
  base.forEach((c) => {
    const idx = inputIdx.get(c.id)
    if (usesCloned(c)) {
      // Silenced native track preserves concat timing
      lines.push(`[${idx}:a]${audioClipFilter({ ...c, volume: 0 }, `[ba${idx}]`)}`)
    } else {
      lines.push(`[${idx}:a]${audioClipFilter(c, `[ba${idx}]`)}`)
    }
  })
  const baseAudioLabels = base.map((c) => `[ba${inputIdx.get(c.id)}]`).join('')
  lines.push(`${baseAudioLabels}concat=n=${base.length}:v=0:a=1[aseq]`)

  // Each overlay audio: delayed to in_track + mixed with base.
  // Same silencing logic for overlays with cloned voice.
  let audioAcc = '[aseq]'
  overlays.forEach((c, i) => {
    const idx = inputIdx.get(c.id)
    const fc = usesCloned(c) ? { ...c, volume: 0 } : c
    lines.push(`[${idx}:a]${audioClipFilter(fc, `[ova${i}raw]`)}`)
    const startMs = Math.round((c.in_track || 0) * 1000)
    lines.push(`[ova${i}raw]adelay=${startMs}|${startMs}[ova${i}]`)
    const out = `[amix${i}]`
    lines.push(`${audioAcc}[ova${i}]amix=inputs=2:duration=first:dropout_transition=0${out}`)
    audioAcc = out
  })

  // 6b) Cloned voice tracks — one per clip with use_cloned_voice. Each is
  // delayed to the clip's in_track. They replace the silenced native audio.
  voiced.forEach((c, i) => {
    const idx = clonedAudioInput.get(c.id)
    const startMs = Math.round((c.in_track || 0) * 1000)
    const dur = clipDuration(c)
    // Trim cloned audio to clip duration so a longer source doesn't bleed past
    // the clip's slot (rare but possible if the convert returned padded output).
    lines.push(`[${idx}:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${startMs}|${startMs}[cv${i}]`)
    const out = `[acv${i}]`
    lines.push(`${audioAcc}[cv${i}]amix=inputs=2:duration=first:dropout_transition=0${out}`)
    audioAcc = out
  })

  // 7) Optional music underlay — BGM with auto-duck when any cloned voice plays.
  // Build a multiplicative duck expression: vol * Π duck_factor_during_voice_range.
  if (musicInputIdx !== null && (project.audio_clips || []).length > 0) {
    const a = project.audio_clips[0]
    const startMs = Math.round((a.start || 0) * 1000)
    const baseVol = (a.volume ?? 0.3)
    const duckLevel = a.bgm_duck ?? 0.25  // 25% of base when ducked
    // Build duck expression: 1*(if(between(t,s1,e1),duck/1,1))*(...)*...
    // Multiply each ducking factor; default 1 (no duck) outside ranges.
    let duckExpr = '1'
    if (voiced.length > 0) {
      const factors = voiced.map((c) => {
        const s = (c.in_track || 0).toFixed(3)
        const e = ((c.in_track || 0) + clipDuration(c)).toFixed(3)
        return `if(between(t,${s},${e}),${duckLevel.toFixed(3)},1)`
      })
      duckExpr = factors.join('*')
    }
    // Compose: volume = baseVol * duckExpr
    lines.push(`[${musicInputIdx}:a]adelay=${startMs}|${startMs},volume=${baseVol.toFixed(2)}*(${duckExpr}):eval=frame[am]`)
    lines.push(`${audioAcc}[am]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
  } else {
    lines.push(`${audioAcc}anull[aout]`)
  }

  return { graph: lines.join(';'), inputCount: base.length + overlays.length + (project.image_clips || []).length }
}

// ── Export: ffmpeg.wasm primary ─────────────────────────────────────
export async function renderWithFFmpeg(project, onProgress) {
  if (typeof window === 'undefined') throw new Error('ffmpeg.wasm hanya jalan di browser')
  if (typeof SharedArrayBuffer === 'undefined') throw new Error('SharedArrayBuffer gak available — COOP/COEP headers belum apply')
  if (!window.crossOriginIsolated) throw new Error('crossOriginIsolated=false — hard reload (Ctrl+Shift+R)')

  const allClips = project.video_clips || []
  const base = baseTrackClips(allClips)
  const overlays = overlayClips(allClips)
  if (base.length === 0) throw new Error('Belum ada video di base track')

  onProgress?.('Loading ffmpeg.wasm...')
  const ff = await getFFmpeg((msg) => {
    if (msg.includes('frame=')) {
      const m = msg.match(/frame=\s*(\d+)/)
      if (m) onProgress?.(`Encoding frame ${m[1]}...`)
    }
  })

  // Load all base + overlay videos
  let inputIdx = 0
  for (const c of base) {
    onProgress?.(`Download base clip ${inputIdx + 1}/${base.length}...`)
    const bytes = await fetchToUint8(c.src_url)
    await ff.writeFile(`v${inputIdx}.mp4`, bytes)
    inputIdx++
  }
  for (const c of overlays) {
    onProgress?.(`Download overlay clip...`)
    const bytes = await fetchToUint8(c.src_url)
    await ff.writeFile(`v${inputIdx}.mp4`, bytes)
    inputIdx++
  }

  const imageClips = project.image_clips || []
  for (let i = 0; i < imageClips.length; i++) {
    onProgress?.(`Download image overlay ${i + 1}/${imageClips.length}...`)
    const bytes = await fetchToUint8(imageClips[i].src_url)
    await ff.writeFile(`img${i}.png`, bytes)
  }

  let musicInputIdx = null
  const audioClips = project.audio_clips || []
  if (audioClips.length > 0 && audioClips[0].src_url) {
    onProgress?.('Download music underlay...')
    const bytes = await fetchToUint8(audioClips[0].src_url)
    await ff.writeFile('music.mp3', bytes)
    musicInputIdx = base.length + overlays.length + imageClips.length
  }

  // Cloned voice tracks — one per clip with use_cloned_voice
  const voiced = clipsWithClonedVoice(project)
  let clonedAudioInputStartIdx = null
  if (voiced.length > 0) {
    const base0 = base.length + overlays.length + imageClips.length + (musicInputIdx !== null ? 1 : 0)
    clonedAudioInputStartIdx = base0
    for (let i = 0; i < voiced.length; i++) {
      onProgress?.(`Download cloned voice ${i + 1}/${voiced.length}...`)
      const bytes = await fetchToUint8(voiced[i].cloned_audio_url)
      await ff.writeFile(`cv${i}.mp3`, bytes)
    }
  }

  const ar = project.ar || '9:16'
  const [W, H] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]

  // Write ASS subtitle file if karaoke clips exist
  const karaokeClips = (project.text_clips || []).filter((c) => c.animation === 'karaoke' && Array.isArray(c.words) && c.words.length > 0)
  if (karaokeClips.length > 0) {
    const assContent = buildAssForKaraoke(karaokeClips, [W, H])
    if (assContent) {
      onProgress?.(`Writing karaoke subtitles (${karaokeClips.length} clips)...`)
      const encoder = new TextEncoder()
      await ff.writeFile('subs.ass', encoder.encode(assContent))
    }
  }

  const { graph } = buildFilterGraph(project, [W, H], musicInputIdx, clonedAudioInputStartIdx)

  const args = []
  for (let i = 0; i < base.length + overlays.length; i++) {
    args.push('-i', `v${i}.mp4`)
  }
  imageClips.forEach((_, i) => args.push('-i', `img${i}.png`))
  if (musicInputIdx !== null) args.push('-i', 'music.mp3')
  voiced.forEach((_, i) => args.push('-i', `cv${i}.mp3`))
  args.push(
    '-filter_complex', graph,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-y', 'output.mp4'
  )

  onProgress?.(`Encoding ${base.length} base + ${overlays.length} overlay clips...`)
  await ff.exec(args)

  onProgress?.('Reading output...')
  const data = await ff.readFile('output.mp4')
  return new Blob([data.buffer], { type: 'video/mp4' })
}

// ── Canvas fallback ─────────────────────────────────────────────────
export async function renderWithCanvas(project, onProgress) {
  const allClips = project.video_clips || []
  const base = baseTrackClips(allClips)
  const overlays = overlayClips(allClips)
  if (base.length === 0) throw new Error('Belum ada video di base track')

  const ar = project.ar || '9:16'
  const [W, H] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  // Wait for Google Fonts to actually finish loading before any text gets
  // measured. Without this, ctx.measureText() runs against whatever font
  // happens to be available at that instant — usually system-ui because
  // Poppins/Bebas/etc are still streaming in the background. system-ui's
  // glyphs are 10-15% narrower than the intended font, so wrap calc
  // under-estimates line widths and the text fails to break where it
  // should. CSS preview doesn't hit this because the browser relays out
  // automatically once each font lands. Canvas only measures once.
  //
  // CRITICAL: must load the EXACT (family, weight) combos the clips use.
  // document.fonts.load('700 48px Poppins') does NOT pre-load weight 600
  // — Google Fonts ships each weight as a separate font face. We collect
  // every (family, weight) pair used in the project and load them all.
  try {
    if (document.fonts && document.fonts.load) {
      onProgress?.('Loading fonts...')
      const pairs = new Set() // "family|weight" strings, deduped
      ;(project.text_clips || []).forEach((c) => {
        const css = c.font ? getFontCss(c.font) : 'system-ui'
        const primary = css.split(',')[0].trim().replace(/^"|"$/g, '')
        if (!primary || primary === 'system-ui' || primary === 'sans-serif' || primary === 'Impact') return
        const weight = c.weight || 400
        pairs.add(`${primary}|${weight}`)
      })
      await Promise.all(Array.from(pairs).map((p) => {
        const [fam, weight] = p.split('|')
        return document.fonts.load(`${weight} 48px "${fam}"`).catch(() => {})
      }))
      // document.fonts.ready waits for ALL pending loads to complete, not
      // just ours — handles the case where the editor page is still
      // streaming fonts from the <link> tag.
      if (document.fonts.ready) await document.fonts.ready
      // Sanity check: if any (family, weight) we asked for isn't actually
      // loaded, the wrap calc will be wrong. Small extra wait helps in
      // rare race cases. document.fonts.check() returns true/false without
      // triggering a load.
      const unloaded = Array.from(pairs).filter((p) => {
        const [fam, weight] = p.split('|')
        return !document.fonts.check(`${weight} 48px "${fam}"`)
      })
      if (unloaded.length) {
        onProgress?.(`Waiting for ${unloaded.length} font(s)...`)
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  } catch { /* non-fatal — fall back to whatever's loaded */ }

  // All src URLs run through proxify() so they're same-origin from the
  // browser's POV — COEP=require-corp blocks cross-origin fetches without
  // CORP, and fal.media / Supabase storage don't send CORP.
  const overlayImages = await Promise.all((project.image_clips || []).map(async (c) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = proxify(c.src_url)
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    return img
  }))

  let musicEl = null
  const firstAudio = (project.audio_clips || [])[0]
  if (firstAudio?.src_url) {
    musicEl = new Audio(proxify(firstAudio.src_url))
    musicEl.crossOrigin = 'anonymous'
    musicEl.volume = firstAudio.volume ?? 0.3
    await new Promise((res, rej) => { musicEl.oncanplay = res; musicEl.onerror = () => rej(new Error('Music load failed')) })
  }

  // Pre-load video elements per clip (base + overlay).
  // For clips with use_cloned_voice we also pre-load a cloned-audio element
  // and mute the video — the cloned voice takes its place in the mix.
  async function loadClipMedia(c) {
    const v = document.createElement('video')
    v.src = proxify(c.src_url); v.crossOrigin = 'anonymous'
    const wantsCloned = c.cloned_audio_url && c.use_cloned_voice !== false
    v.muted = !!wantsCloned // mute native when cloned voice is in play
    v.playbackRate = c.speed || 1
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Video load failed')) })
    let cloned = null
    if (wantsCloned) {
      cloned = document.createElement('audio')
      cloned.src = proxify(c.cloned_audio_url); cloned.crossOrigin = 'anonymous'
      cloned.preload = 'auto'
      try { await new Promise((res, rej) => { cloned.oncanplay = res; cloned.onerror = () => rej(new Error('Cloned audio load failed')) }) } catch {}
    }
    return { v, cloned }
  }
  const baseMedia = await Promise.all(base.map(loadClipMedia))
  const overlayMedia = await Promise.all(overlays.map(loadClipMedia))
  const baseVideos = baseMedia.map((m) => m.v)
  const overlayVideos = overlayMedia.map((m) => m.v)

  const stream = canvas.captureStream(30)
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const dest = audioCtx.createMediaStreamDestination()
  // Route each clip: cloned audio takes priority over native, gain set to clip.volume
  function routeClipAudio(media, clip) {
    try {
      if (media.cloned) {
        const src = audioCtx.createMediaElementSource(media.cloned)
        const gain = audioCtx.createGain()
        gain.gain.value = clip.volume ?? 1
        src.connect(gain); gain.connect(dest)
      } else {
        const src = audioCtx.createMediaElementSource(media.v)
        const gain = audioCtx.createGain()
        gain.gain.value = clip.volume ?? 1
        src.connect(gain); gain.connect(dest)
      }
    } catch (e) { console.warn('audio route fail:', e.message) }
  }
  baseMedia.forEach((m, i) => routeClipAudio(m, base[i]))
  overlayMedia.forEach((m, i) => routeClipAudio(m, overlays[i]))
  let bgmGainNode = null
  if (musicEl) {
    try {
      const mSrc = audioCtx.createMediaElementSource(musicEl)
      bgmGainNode = audioCtx.createGain()
      bgmGainNode.gain.value = firstAudio.volume ?? 0.3
      mSrc.connect(bgmGainNode); bgmGainNode.connect(dest); bgmGainNode.connect(audioCtx.destination)
    } catch (e) {}
  }
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
  const voiced = clipsWithClonedVoice(project)
  function anyClonedVoiceActiveAt(t) {
    return voiced.some((c) => {
      const s = c.in_track || 0
      return t >= s && t < s + clipDuration(c)
    })
  }
  const bgmDuck = firstAudio?.bgm_duck ?? 0.25
  const bgmBase = firstAudio?.volume ?? 0.3

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 })
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }

  // Seek each to in_src
  for (let i = 0; i < base.length; i++) {
    baseVideos[i].currentTime = base[i].src_in || 0
    await new Promise((res) => { baseVideos[i].onseeked = res })
  }
  for (let i = 0; i < overlays.length; i++) {
    overlayVideos[i].currentTime = overlays[i].src_in || 0
    await new Promise((res) => { overlayVideos[i].onseeked = res })
  }
  // Cloned audio elements: rewind to 0
  baseMedia.forEach((m) => { if (m.cloned) m.cloned.currentTime = 0 })
  overlayMedia.forEach((m) => { if (m.cloned) m.cloned.currentTime = 0 })
  if (musicEl) musicEl.currentTime = 0

  const total = totalDuration(allClips)
  const startTs = performance.now()
  let stop = false
  let activeBaseIdx = -1

  recorder.start()
  if (musicEl) musicEl.play().catch(() => {})

  function applyFilters(c) {
    const f = c?.filters
    if (!f) return ''
    return `brightness(${1 + (f.brightness || 0)}) contrast(${f.contrast || 1}) saturate(${f.saturation || 1}) blur(${f.blur || 0}px)`
  }

  function draw() {
    if (stop) return
    const elapsed = (performance.now() - startTs) / 1000

    // Find active base clip + sync video element
    const baseInfo = activeBaseClipAt(elapsed, allClips)
    if (baseInfo) {
      const bi = base.findIndex((c) => c.id === baseInfo.clip.id)
      if (bi !== activeBaseIdx) {
        if (activeBaseIdx >= 0) {
          baseVideos[activeBaseIdx].pause()
          // Pause previously active cloned audio (if any)
          const prev = baseMedia[activeBaseIdx]?.cloned
          if (prev) prev.pause()
        }
        activeBaseIdx = bi
        baseVideos[bi].currentTime = baseInfo.srcTime
        baseVideos[bi].play().catch(() => {})
        // Start the cloned audio for this clip in sync with base srcTime
        const cv = baseMedia[bi]?.cloned
        if (cv) { cv.currentTime = baseInfo.srcTime; cv.play().catch(() => {}) }
      }
      const v = baseVideos[bi]
      const vw = v.videoWidth, vh = v.videoHeight
      if (vw > 0 && vh > 0) {
        const srcAR = vw / vh, dstAR = W / H
        let dw, dh, dx, dy
        if (srcAR > dstAR) { dh = H; dw = dh * srcAR; dx = (W - dw) / 2; dy = 0 }
        else { dw = W; dh = dw / srcAR; dx = 0; dy = (H - dh) / 2 }
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
        ctx.filter = applyFilters(baseInfo.clip) || 'none'
        // Zoom + Pan via drawImage source rect — same crop math as ffmpeg's
        // crop filter. sw=vw/zoom, source offset positions pan inside source.
        const zoom = baseInfo.clip.zoom || 1
        if (zoom > 1) {
          const px = Math.max(0, Math.min(100, baseInfo.clip.pan_x_pct ?? 50)) / 100
          const py = Math.max(0, Math.min(100, baseInfo.clip.pan_y_pct ?? 50)) / 100
          const sw = vw / zoom, sh = vh / zoom
          const sx = (vw - sw) * px
          const sy = (vh - sh) * py
          ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh)
        } else {
          ctx.drawImage(v, dx, dy, dw, dh)
        }
        ctx.filter = 'none'
      }
    }

    // Overlay video clips
    overlays.forEach((c, i) => {
      const start = c.in_track || 0
      const end = start + clipDuration(c)
      if (elapsed < start || elapsed >= end) {
        if (!overlayVideos[i].paused) overlayVideos[i].pause()
        const ocv = overlayMedia[i]?.cloned
        if (ocv && !ocv.paused) ocv.pause()
        return
      }
      // Sync overlay video to its source time
      const desired = (c.src_in || 0) + (elapsed - start) * (c.speed || 1)
      if (Math.abs(overlayVideos[i].currentTime - desired) > 0.5) overlayVideos[i].currentTime = desired
      if (overlayVideos[i].paused) overlayVideos[i].play().catch(() => {})
      // Cloned audio for overlay clip
      const ocv = overlayMedia[i]?.cloned
      if (ocv) {
        if (Math.abs(ocv.currentTime - (elapsed - start)) > 0.5) ocv.currentTime = elapsed - start
        if (ocv.paused) ocv.play().catch(() => {})
      }
      const pos = c.position || { x_pct: 50, y_pct: 50, w_pct: 40, opacity: 1 }
      const ov = overlayVideos[i]
      if (ov.videoWidth > 0) {
        const targetW = (pos.w_pct / 100) * W
        const ratio = ov.videoHeight / ov.videoWidth
        const targetH = targetW * ratio
        const cx = (pos.x_pct / 100) * W - targetW / 2
        const cy = (pos.y_pct / 100) * H - targetH / 2
        ctx.globalAlpha = pos.opacity ?? 1
        ctx.filter = applyFilters(c) || 'none'
        ctx.drawImage(ov, cx, cy, targetW, targetH)
        ctx.filter = 'none'
        ctx.globalAlpha = 1
      }
    })

    // Image overlays
    ;(project.image_clips || []).forEach((c, i) => {
      if (elapsed < c.start || elapsed > c.end) return
      const img = overlayImages[i]
      const targetW = (c.w_pct / 100) * W
      const ratio = img.height / img.width
      const targetH = targetW * ratio
      const cx = (c.x_pct / 100) * W
      const cy = (c.y_pct / 100) * H
      ctx.globalAlpha = c.opacity ?? 1
      ctx.drawImage(img, cx - targetW / 2, cy - targetH / 2, targetW, targetH)
      ctx.globalAlpha = 1
    })

    // Text overlays with animation
    ;(project.text_clips || []).forEach((c) => {
      if (elapsed < c.start || elapsed > c.end) return
      const x = (c.x_pct / 100) * W
      const y = (c.y_pct / 100) * H
      let alpha = 1, popScale = 1
      const animDur = 0.25
      if (c.animation === 'fade') {
        const sinceStart = elapsed - c.start
        const tillEnd = c.end - elapsed
        if (sinceStart < animDur) alpha = sinceStart / animDur
        else if (tillEnd < animDur) alpha = tillEnd / animDur
      } else if (c.animation === 'pop') {
        const sinceStart = elapsed - c.start
        if (sinceStart < animDur) {
          const p = sinceStart / animDur
          popScale = 0.5 + p * 0.5 + Math.sin(p * Math.PI) * 0.15
          alpha = p
        }
      }
      // Zoom = pure CSS-transform-like visual scale. We wrap at the BASE
      // font size, then apply zoom via ctx.translate + ctx.scale so the
      // whole laid-out text+bg block zooms uniformly. Wrap is owned by
      // Size and Box Width — independent of Zoom. Matches CSS preview's
      // transform: scale().
      const userScale = c.scale ?? 1
      const fontSize = c.size * (W / 720) * popScale
      ctx.globalAlpha = alpha
      // Font family resolved from FONT_OPTIONS (shared with EditorClient). The
      // Google Font <link> is injected on the editor page so loaded families
      // are available to canvas. If render runs from a page that didn't load
      // them, system-ui takes over via the CSS fallback stack — no crash.
      const fontCss = c.font ? getFontCss(c.font) : 'system-ui, -apple-system, sans-serif'
      ctx.textAlign = c.align === 'left' ? 'left' : c.align === 'right' ? 'right' : 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `${c.weight} ${fontSize}px ${fontCss}`
      // Box width is user-controlled (default 90% of frame). Wider value =
      // more wrap budget = more words per line = less whitespace around.
      const maxLineWidth = W * ((c.max_width_pct ?? 90) / 100)
      const lines = wrapTextLines(ctx, c.text, maxLineWidth)
      const lineHeight = fontSize * 1.25
      const totalH = lines.length * lineHeight
      const padding = fontSize * 0.3
      // Coords RELATIVE to (x, y) — we translate+scale below.
      const firstLineYRel = -totalH / 2 + lineHeight / 2

      ctx.save()
      ctx.translate(x, y)
      ctx.scale(userScale, userScale)

      // Background pill — spans all lines, width = widest line.
      if (c.bg && c.bg !== 'transparent') {
        const maxLineW = Math.max(...lines.map((l) => ctx.measureText(l).width))
        const bgW = maxLineW + padding * 2
        const bgH = totalH + padding * 0.6
        let bgX = 0
        if (c.align === 'center') bgX = -bgW / 2
        else if (c.align === 'right') bgX = -bgW
        ctx.fillStyle = c.bg
        ctx.fillRect(bgX, firstLineYRel - lineHeight / 2 - padding * 0.3, bgW, bgH)
      }

      // Effects render order per LINE: glow underneath → shadow → stroke → fill.
      // Matches the CSS preview (paint-order: stroke fill + text-shadow chain
      // with glow blur before shadow).
      const eff = c.effects
      const sizeScale = fontSize / 56 // effects sliders calibrated against 56px base

      for (let li = 0; li < lines.length; li++) {
        const lineY = firstLineYRel + li * lineHeight
        const lineText = lines[li]
        if (!lineText) continue

        if (eff?.glow?.enabled) {
          ctx.save()
          ctx.shadowColor = eff.glow.color
          ctx.shadowBlur = eff.glow.blur * sizeScale * 2
          ctx.fillStyle = c.color
          // 3 stacked passes = visible halo at canvas resolution.
          for (let i = 0; i < 3; i++) ctx.fillText(lineText, 0, lineY)
          ctx.restore()
        }
        // Drop shadow via canvas shadow* — applied to the fill below.
        if (eff?.shadow?.enabled) {
          ctx.shadowColor = eff.shadow.color
          ctx.shadowOffsetX = eff.shadow.x * sizeScale
          ctx.shadowOffsetY = eff.shadow.y * sizeScale
          ctx.shadowBlur = eff.shadow.blur * sizeScale
        } else if (!eff) {
          // Backward compat for clips without effects field — keep the legacy subtle shadow.
          ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowOffsetY = 1; ctx.shadowBlur = 4; ctx.shadowOffsetX = 0
        } else {
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0
        }
        // Stroke FIRST (drawn under fill), then fill — paint-order: stroke fill.
        if (eff?.stroke?.enabled) {
          ctx.lineWidth = eff.stroke.width * sizeScale * 2 // canvas stroke is centered, 2x for visual parity with CSS
          ctx.strokeStyle = eff.stroke.color
          ctx.lineJoin = 'round'
          ctx.miterLimit = 2
          ctx.strokeText(lineText, 0, lineY)
        }
        ctx.fillStyle = c.color
        ctx.fillText(lineText, 0, lineY)
      }
      ctx.restore()
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0
      ctx.globalAlpha = 1
    })

    const pct = Math.min(100, Math.round((elapsed / total) * 100))
    onProgress?.(`Recording ${pct}% (base ${activeBaseIdx + 1}/${base.length}, +${overlays.length} overlay)`)

    // BGM auto-duck: drop gain when any cloned voice is active.
    if (bgmGainNode) {
      const ducking = anyClonedVoiceActiveAt(elapsed)
      bgmGainNode.gain.value = bgmBase * (ducking ? bgmDuck : 1)
    }

    if (elapsed >= total) {
      stop = true
      ;[...baseVideos, ...overlayVideos].forEach((v) => v.pause())
      ;[...baseMedia, ...overlayMedia].forEach((m) => { if (m.cloned) m.cloned.pause() })
      if (musicEl) musicEl.pause()
      setTimeout(() => recorder.stop(), 100)
      return
    }
    requestAnimationFrame(draw)
  }
  draw()
  await new Promise((res) => { recorder.onstop = res })
  return new Blob(chunks, { type: mime })
}

// mode: 'fast' (canvas+MediaRecorder, WebM, ~real-time) or 'mp4' (ffmpeg.wasm).
// ffmpeg.wasm needs to download ~30MB of core+wasm on first export and then
// transcode — for a 5s clip that's typically 30-60s total. The canvas path
// records the preview in real time, so a 5s clip exports in about 5s with
// no wasm download. WebM uploads fine to TikTok / IG / YouTube.
export async function renderProject(project, onProgress, opts = {}) {
  const mode = opts.mode || 'fast'
  if (mode === 'fast') {
    onProgress?.('Recording (canvas WebM — fast mode)...')
    const blob = await renderWithCanvas(project, onProgress)
    return { blob, ext: 'webm', mime: 'video/webm' }
  }
  // mode === 'mp4' — try ffmpeg first, fall back to canvas if it crashes.
  try {
    onProgress?.('Loading ffmpeg.wasm (first export takes ~15-30s)...')
    const blob = await renderWithFFmpeg(project, onProgress)
    return { blob, ext: 'mp4', mime: 'video/mp4' }
  } catch (e) {
    console.warn('ffmpeg.wasm failed, fallback canvas:', e.message)
    onProgress?.(`ffmpeg failed (${e.message.slice(0, 80)}) → canvas WebM...`)
    const blob = await renderWithCanvas(project, onProgress)
    return { blob, ext: 'webm', mime: 'video/webm' }
  }
}
