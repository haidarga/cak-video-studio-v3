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

let ffmpegInstance = null
let ffmpegLoading = null

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
  const res = await fetch(url, { cache: 'no-store' })
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
  const trimSrc = `trim=start=${c.src_in}:end=${c.src_out},setpts=${(1/(c.speed || 1)).toFixed(4)}*(PTS-STARTPTS)`
  const f = c.filters || {}
  const eqParts = []
  if (f.brightness != null && f.brightness !== 0) eqParts.push(`brightness=${f.brightness.toFixed(3)}`)
  if (f.contrast != null && f.contrast !== 1) eqParts.push(`contrast=${f.contrast.toFixed(3)}`)
  if (f.saturation != null && f.saturation !== 1) eqParts.push(`saturation=${f.saturation.toFixed(3)}`)
  const eq = eqParts.length ? `,eq=${eqParts.join(':')}` : ''
  const blur = (f.blur && f.blur > 0) ? `,boxblur=${f.blur}:${f.blur}` : ''
  return `${trimSrc}${eq}${blur},setsar=1${label}`
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

// Build full filter_complex: base concat → overlays → image/text → audio mix
function buildFilterGraph(project, canvasDims, musicInputIdx) {
  const allClips = project.video_clips || []
  const base = baseTrackClips(allClips)
  const overlays = overlayClips(allClips)
  if (base.length === 0) throw new Error('Belum ada video di base track')
  const [W, H] = canvasDims

  const lines = []
  const inputIdx = new Map() // clip.id -> input index dalam args ffmpeg

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

  // 6) Audio: from BASE clips concat + overlay clips mixed in by their position
  base.forEach((c) => {
    const idx = inputIdx.get(c.id)
    lines.push(`[${idx}:a]${audioClipFilter(c, `[ba${idx}]`)}`)
  })
  const baseAudioLabels = base.map((c) => `[ba${inputIdx.get(c.id)}]`).join('')
  lines.push(`${baseAudioLabels}concat=n=${base.length}:v=0:a=1[aseq]`)

  // Each overlay audio: delayed to in_track + mixed with base
  let audioAcc = '[aseq]'
  overlays.forEach((c, i) => {
    const idx = inputIdx.get(c.id)
    lines.push(`[${idx}:a]${audioClipFilter(c, `[ova${i}raw]`)}`)
    const startMs = Math.round((c.in_track || 0) * 1000)
    lines.push(`[ova${i}raw]adelay=${startMs}|${startMs}[ova${i}]`)
    const out = `[amix${i}]`
    lines.push(`${audioAcc}[ova${i}]amix=inputs=2:duration=first:dropout_transition=0${out}`)
    audioAcc = out
  })

  // 7) Optional music underlay
  if (musicInputIdx !== null && (project.audio_clips || []).length > 0) {
    const a = project.audio_clips[0]
    const startMs = Math.round((a.start || 0) * 1000)
    const vol = a.volume ?? 0.3
    lines.push(`[${musicInputIdx}:a]adelay=${startMs}|${startMs},volume=${vol.toFixed(2)}[am]`)
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

  const { graph } = buildFilterGraph(project, [W, H], musicInputIdx)

  const args = []
  for (let i = 0; i < base.length + overlays.length; i++) {
    args.push('-i', `v${i}.mp4`)
  }
  imageClips.forEach((_, i) => args.push('-i', `img${i}.png`))
  if (musicInputIdx !== null) args.push('-i', 'music.mp3')
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

  const overlayImages = await Promise.all((project.image_clips || []).map(async (c) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = c.src_url
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    return img
  }))

  let musicEl = null
  const firstAudio = (project.audio_clips || [])[0]
  if (firstAudio?.src_url) {
    musicEl = new Audio(firstAudio.src_url)
    musicEl.crossOrigin = 'anonymous'
    musicEl.volume = firstAudio.volume ?? 0.3
    await new Promise((res, rej) => { musicEl.oncanplay = res; musicEl.onerror = () => rej(new Error('Music load failed')) })
  }

  // Pre-load video elements per clip (base + overlay)
  const baseVideos = await Promise.all(base.map(async (c) => {
    const v = document.createElement('video')
    v.src = c.src_url; v.crossOrigin = 'anonymous'; v.muted = false
    v.playbackRate = c.speed || 1
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Video load failed')) })
    return v
  }))
  const overlayVideos = await Promise.all(overlays.map(async (c) => {
    const v = document.createElement('video')
    v.src = c.src_url; v.crossOrigin = 'anonymous'; v.muted = false
    v.playbackRate = c.speed || 1
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Overlay video load failed')) })
    return v
  }))

  const stream = canvas.captureStream(30)
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const dest = audioCtx.createMediaStreamDestination()
  ;[...baseVideos, ...overlayVideos].forEach((v, i) => {
    try {
      const src = audioCtx.createMediaElementSource(v)
      const gain = audioCtx.createGain()
      const clip = i < baseVideos.length ? base[i] : overlays[i - baseVideos.length]
      gain.gain.value = clip.volume ?? 1
      src.connect(gain); gain.connect(dest)
    } catch (e) { console.warn('audio src fail', e.message) }
  })
  if (musicEl) {
    try {
      const mSrc = audioCtx.createMediaElementSource(musicEl)
      const mGain = audioCtx.createGain()
      mGain.gain.value = firstAudio.volume ?? 0.3
      mSrc.connect(mGain); mGain.connect(dest); mGain.connect(audioCtx.destination)
    } catch (e) {}
  }
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))

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
        if (activeBaseIdx >= 0) baseVideos[activeBaseIdx].pause()
        activeBaseIdx = bi
        baseVideos[bi].currentTime = baseInfo.srcTime
        baseVideos[bi].play().catch(() => {})
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
        ctx.drawImage(v, dx, dy, dw, dh)
        ctx.filter = 'none'
      }
    }

    // Overlay video clips
    overlays.forEach((c, i) => {
      const start = c.in_track || 0
      const end = start + clipDuration(c)
      if (elapsed < start || elapsed >= end) {
        if (!overlayVideos[i].paused) overlayVideos[i].pause()
        return
      }
      // Sync overlay video to its source time
      const desired = (c.src_in || 0) + (elapsed - start) * (c.speed || 1)
      if (Math.abs(overlayVideos[i].currentTime - desired) > 0.5) overlayVideos[i].currentTime = desired
      if (overlayVideos[i].paused) overlayVideos[i].play().catch(() => {})
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
      let alpha = 1, scale = 1
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
          scale = 0.5 + p * 0.5 + Math.sin(p * Math.PI) * 0.15
          alpha = p
        }
      }
      const fontSize = c.size * (W / 720) * scale
      ctx.globalAlpha = alpha
      ctx.font = `${c.weight} ${fontSize}px system-ui, -apple-system, sans-serif`
      ctx.textAlign = c.align === 'left' ? 'left' : c.align === 'right' ? 'right' : 'center'
      ctx.textBaseline = 'middle'
      const metrics = ctx.measureText(c.text)
      const padding = fontSize * 0.3
      if (c.bg && c.bg !== 'transparent') {
        ctx.fillStyle = c.bg
        const bgW = metrics.width + padding * 2
        const bgH = fontSize * 1.4
        let bgX = x
        if (c.align === 'center') bgX = x - bgW / 2
        else if (c.align === 'right') bgX = x - bgW
        ctx.fillRect(bgX, y - bgH / 2, bgW, bgH)
      }
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1
      ctx.fillStyle = c.color
      ctx.fillText(c.text, x, y)
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
      ctx.globalAlpha = 1
    })

    const pct = Math.min(100, Math.round((elapsed / total) * 100))
    onProgress?.(`Recording ${pct}% (base ${activeBaseIdx + 1}/${base.length}, +${overlays.length} overlay)`)

    if (elapsed >= total) {
      stop = true
      ;[...baseVideos, ...overlayVideos].forEach((v) => v.pause())
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

export async function renderProject(project, onProgress) {
  try {
    onProgress?.('Trying ffmpeg.wasm (MP4 with stacking)...')
    const blob = await renderWithFFmpeg(project, onProgress)
    return { blob, ext: 'mp4', mime: 'video/mp4' }
  } catch (e) {
    console.warn('ffmpeg.wasm failed, fallback canvas:', e.message)
    onProgress?.(`ffmpeg failed (${e.message.slice(0, 80)}) → canvas WebM...`)
    const blob = await renderWithCanvas(project, onProgress)
    return { blob, ext: 'webm', mime: 'video/webm' }
  }
}
