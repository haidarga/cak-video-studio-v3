// Two export paths:
// 1) ffmpeg.wasm — MP4 with full feature set (multi-clip concat, crossfade
//    transitions, per-clip filters via eq+boxblur, drawtext overlays, image
//    overlays, audio mix). Requires crossOriginIsolated (COOP/COEP headers).
// 2) MediaRecorder + canvas — WebM fallback. Limited to first video clip;
//    transitions and filters approximated via canvas, no per-clip switching.

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
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

function escapeDrawText(s) {
  return String(s)
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:')
    .replace(/'/g, "'\\''").replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

// Duration of a single clip on the timeline (after speed adjustment).
export function clipDuration(c) {
  const len = Math.max(0, (c.src_out ?? 0) - (c.src_in ?? 0))
  return len / Math.max(0.01, c.speed || 1)
}

// Timeline start position for clip at index i, accounting for crossfade overlaps.
export function clipInTrack(clips, i) {
  let t = 0
  for (let j = 0; j < i; j++) {
    t += clipDuration(clips[j])
    const trIn = clips[j + 1]?.transition_in
    if (j + 1 < clips.length && trIn && trIn.type !== 'cut') {
      t -= (trIn.duration || 0.5)
    }
  }
  return Math.max(0, t)
}

// Total timeline duration (sum minus crossfade overlaps).
export function totalDuration(clips) {
  if (!clips || clips.length === 0) return 0
  let t = 0
  clips.forEach((c, i) => {
    t += clipDuration(c)
    if (i > 0 && c.transition_in?.type && c.transition_in.type !== 'cut') {
      t -= (c.transition_in.duration || 0.5)
    }
  })
  return Math.max(0, t)
}

// Given timelineTime, find which video clip is active + its source time.
export function activeClipAt(timelineTime, clips) {
  let acc = 0
  for (let i = 0; i < clips.length; i++) {
    const dur = clipDuration(clips[i])
    const end = acc + dur
    if (timelineTime < end || i === clips.length - 1) {
      const offsetInClip = Math.max(0, timelineTime - acc)
      const srcTime = (clips[i].src_in || 0) + offsetInClip * (clips[i].speed || 1)
      return { index: i, srcTime, clipStart: acc, clipEnd: end }
    }
    acc = end
    const next = clips[i + 1]
    if (next?.transition_in && next.transition_in.type !== 'cut') {
      acc -= (next.transition_in.duration || 0.5)
    }
  }
  return null
}

// Build ffmpeg per-clip filter chain: trim + speed (setpts) + eq filters + blur
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
  // ffmpeg atempo limited to 0.5-100, chain it for higher ratios
  const tempos = []
  let s = speed
  while (s < 0.5) { tempos.push('atempo=0.5'); s /= 0.5 }
  while (s > 2.0) { tempos.push('atempo=2.0'); s /= 2.0 }
  tempos.push(`atempo=${s.toFixed(4)}`)
  return `atrim=start=${c.src_in}:end=${c.src_out},asetpts=PTS-STARTPTS,${tempos.join(',')},volume=${vol.toFixed(2)}${label}`
}

// Build the full filter_complex for multi-clip + transitions + overlays + audio mix.
function buildFilterGraph(project, canvasDims, musicInputIdx) {
  const clips = project.video_clips || []
  if (clips.length === 0) throw new Error('No video clips')
  const [W, H] = canvasDims

  const lines = []

  // 1) Per-clip filter chains: trim + setpts + eq + blur, then scale to canvas
  clips.forEach((c, i) => {
    lines.push(`[${i}:v]${videoClipFilter(c, '[c' + i + 'raw]')}`)
    lines.push(`[c${i}raw]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[c${i}]`)
  })

  // 2) Concat with crossfade. xfade applies between current accumulator and next clip.
  let currentLabel = '[c0]'
  let accDur = clipDuration(clips[0])
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i]
    const tr = c.transition_in || { type: 'cut' }
    const next = `[c${i}]`
    const out = `[seq${i}]`
    if (tr.type === 'cut') {
      lines.push(`${currentLabel}${next}concat=n=2:v=1:a=0${out}`)
      accDur += clipDuration(c)
    } else {
      // xfade transitions need overlap. offset = where xfade starts in current sequence.
      const dur = Math.max(0.1, tr.duration || 0.5)
      const xtype = tr.type === 'fade' ? 'fade' : 'fade'  // also accept dissolve later
      const offset = Math.max(0, accDur - dur)
      lines.push(`${currentLabel}${next}xfade=transition=${xtype}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}${out}`)
      accDur += clipDuration(c) - dur
    }
    currentLabel = out
  }

  // 3) Image overlays
  ;(project.image_clips || []).forEach((c, i) => {
    const x = Math.round((c.x_pct / 100) * W)
    const y = Math.round((c.y_pct / 100) * H)
    const overlayW = Math.round((c.w_pct || 30) / 100 * W)
    const inputIdx = clips.length + i
    const out = `[oi${i}]`
    lines.push(`[${inputIdx}:v]scale=${overlayW}:-1,format=rgba,colorchannelmixer=aa=${(c.opacity ?? 1).toFixed(2)}[img${i}]`)
    lines.push(`${currentLabel}[img${i}]overlay=x=${x}-overlay_w/2:y=${y}-overlay_h/2:enable='between(t,${(c.start || 0).toFixed(3)},${(c.end || 1).toFixed(3)})'${out}`)
    currentLabel = out
  })

  // 4) Text overlays — drawtext dengan alpha expr untuk fade animation
  ;(project.text_clips || []).forEach((c, i) => {
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
    // Animation via fontcolor_expr: ramps alpha at start/end based on animation type
    let alphaExpr = ''
    if (c.animation === 'fade' || c.animation === 'pop') {
      const animDur = 0.25
      alphaExpr = `:alpha='if(between(t,${start},${end}), min(1, min((t-${start})/${animDur}, (${end}-t)/${animDur})), 0)'`
    }
    const out = `[ot${i}]`
    lines.push(`${currentLabel}drawtext=text='${txt}':fontcolor=0x${color}:fontsize=${fontSize}:x=${xExpr}:y=${y}-text_h/2${boxColor}${alphaExpr}:enable='between(t,${start},${end})'${out}`)
    currentLabel = out
  })

  lines.push(`${currentLabel}copy[vout]`)

  // 5) Audio: per-clip trim/speed/volume, then concat all
  clips.forEach((c, i) => {
    lines.push(`[${i}:a]${audioClipFilter(c, '[ac' + i + ']')}`)
  })
  const audioInputs = clips.map((_, i) => `[ac${i}]`).join('')
  lines.push(`${audioInputs}concat=n=${clips.length}:v=0:a=1[aseq]`)

  // 6) Optional music underlay mix
  if (musicInputIdx !== null && (project.audio_clips || []).length > 0) {
    const a = project.audio_clips[0]
    const startMs = Math.round((a.start || 0) * 1000)
    const vol = a.volume ?? 0.3
    lines.push(`[${musicInputIdx}:a]adelay=${startMs}|${startMs},volume=${vol.toFixed(2)}[am]`)
    lines.push(`[aseq][am]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
  } else {
    lines.push(`[aseq]anull[aout]`)
  }

  return lines.join(';')
}

// Primary export: ffmpeg.wasm → MP4 with full multi-clip + transitions + filters
export async function renderWithFFmpeg(project, onProgress) {
  if (typeof window === 'undefined') throw new Error('ffmpeg.wasm hanya jalan di browser')
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('SharedArrayBuffer gak available — COOP/COEP headers belum ke-set. Reload page.')
  }
  if (!window.crossOriginIsolated) {
    throw new Error('crossOriginIsolated=false — headers belum apply. Hard reload (Ctrl+Shift+R).')
  }

  const clips = project.video_clips || []
  if (clips.length === 0) throw new Error('Belum ada video clip')

  onProgress?.(`Loading ffmpeg.wasm (~25MB first time, cached after)...`)
  const ff = await getFFmpeg((msg) => {
    if (msg.includes('frame=')) {
      const m = msg.match(/frame=\s*(\d+)/)
      if (m) onProgress?.(`Encoding frame ${m[1]}...`)
    }
  })

  // Download all video clips
  for (let i = 0; i < clips.length; i++) {
    onProgress?.(`Download video clip ${i + 1}/${clips.length}...`)
    const bytes = await fetchToUint8(clips[i].src_url)
    await ff.writeFile(`v${i}.mp4`, bytes)
  }

  // Image overlays
  const imageClips = project.image_clips || []
  for (let i = 0; i < imageClips.length; i++) {
    onProgress?.(`Download image overlay ${i + 1}/${imageClips.length}...`)
    const bytes = await fetchToUint8(imageClips[i].src_url)
    await ff.writeFile(`img${i}.png`, bytes)
  }

  // Music
  const audioClips = project.audio_clips || []
  let musicInputIdx = null
  if (audioClips.length > 0 && audioClips[0].src_url) {
    onProgress?.('Download music underlay...')
    const bytes = await fetchToUint8(audioClips[0].src_url)
    await ff.writeFile('music.mp3', bytes)
    musicInputIdx = clips.length + imageClips.length
  }

  // Canvas dims
  const ar = project.ar || '9:16'
  const [W, H] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]
  const filter = buildFilterGraph(project, [W, H], musicInputIdx)

  // Build args
  const args = []
  clips.forEach((_, i) => { args.push('-i', `v${i}.mp4`) })
  imageClips.forEach((_, i) => { args.push('-i', `img${i}.png`) })
  if (musicInputIdx !== null) args.push('-i', 'music.mp3')
  args.push(
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', 'output.mp4'
  )

  onProgress?.(`Encoding ${clips.length} clip${clips.length > 1 ? 's' : ''} via ffmpeg...`)
  await ff.exec(args)

  onProgress?.('Reading output...')
  const data = await ff.readFile('output.mp4')
  return new Blob([data.buffer], { type: 'video/mp4' })
}

// Fallback: canvas + MediaRecorder. Multi-clip support is best-effort —
// switches video element src at boundaries. Transitions/filters via CSS-equiv
// canvas ops (best approximation).
export async function renderWithCanvas(project, onProgress) {
  const clips = project.video_clips || []
  if (clips.length === 0) throw new Error('Source video URL kosong')

  const ar = project.ar || '9:16'
  const [W, H] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  // Pre-load image overlays
  const overlayImages = await Promise.all((project.image_clips || []).map(async (c) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = c.src_url
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    return img
  }))

  // Pre-load music
  let musicEl = null
  const firstAudio = (project.audio_clips || [])[0]
  if (firstAudio?.src_url) {
    musicEl = new Audio(firstAudio.src_url)
    musicEl.crossOrigin = 'anonymous'
    musicEl.volume = firstAudio.volume ?? 0.3
    await new Promise((res, rej) => { musicEl.oncanplay = res; musicEl.onerror = () => rej(new Error('Music load failed')) })
  }

  // Create video elements per clip
  const videoEls = await Promise.all(clips.map(async (c) => {
    const v = document.createElement('video')
    v.src = c.src_url
    v.crossOrigin = 'anonymous'
    v.muted = false
    v.playbackRate = c.speed || 1
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Video load failed')) })
    return v
  }))

  const stream = canvas.captureStream(30)
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const dest = audioCtx.createMediaStreamDestination()
  videoEls.forEach((v, i) => {
    const src = audioCtx.createMediaElementSource(v)
    const gain = audioCtx.createGain()
    gain.gain.value = clips[i].volume ?? 1
    src.connect(gain); gain.connect(dest)
  })
  if (musicEl) {
    try {
      const mSrc = audioCtx.createMediaElementSource(musicEl)
      const mGain = audioCtx.createGain()
      mGain.gain.value = firstAudio.volume ?? 0.3
      mSrc.connect(mGain); mGain.connect(dest); mGain.connect(audioCtx.destination)
    } catch (e) { console.warn('music audio fail', e.message) }
  }
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 })
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }

  // Seek each clip to src_in, then play first clip
  for (let i = 0; i < clips.length; i++) {
    videoEls[i].currentTime = clips[i].src_in || 0
    await new Promise((res) => { videoEls[i].onseeked = res })
  }
  if (musicEl) musicEl.currentTime = 0

  const total = totalDuration(clips)
  let activeIdx = 0
  let elapsed = 0
  const startTs = performance.now()
  let stop = false

  recorder.start()
  await videoEls[0].play()
  if (musicEl) musicEl.play().catch(() => {})

  function applyFilters(c) {
    const f = c?.filters
    if (!f) return ''
    return `brightness(${1 + (f.brightness || 0)}) contrast(${f.contrast || 1}) saturate(${f.saturation || 1}) blur(${f.blur || 0}px)`
  }

  function draw() {
    if (stop) return
    elapsed = (performance.now() - startTs) / 1000

    // Find active clip in timeline
    const info = activeClipAt(elapsed, clips)
    if (!info) { stop = true; setTimeout(() => recorder.stop(), 100); return }

    if (info.index !== activeIdx) {
      // Pause previous, play current
      videoEls[activeIdx]?.pause()
      activeIdx = info.index
      videoEls[activeIdx].currentTime = info.srcTime
      videoEls[activeIdx].play().catch(() => {})
    }

    const v = videoEls[activeIdx]
    const clip = clips[activeIdx]
    const vw = v.videoWidth, vh = v.videoHeight
    if (vw > 0 && vh > 0) {
      const srcAR = vw / vh, dstAR = W / H
      let dw, dh, dx, dy
      if (srcAR > dstAR) { dh = H; dw = dh * srcAR; dx = (W - dw) / 2; dy = 0 }
      else { dw = W; dh = dw / srcAR; dx = 0; dy = (H - dh) / 2 }
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
      ctx.filter = applyFilters(clip) || 'none'
      ctx.drawImage(v, dx, dy, dw, dh)
      ctx.filter = 'none'
    }

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

    // Text overlays dengan animation (fade/pop)
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
    onProgress?.(`Recording ${pct}% (clip ${activeIdx + 1}/${clips.length})`)

    if (elapsed >= total) {
      stop = true
      videoEls.forEach((v) => v.pause())
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
    onProgress?.('Trying ffmpeg.wasm (MP4 with transitions/filters)...')
    const blob = await renderWithFFmpeg(project, onProgress)
    return { blob, ext: 'mp4', mime: 'video/mp4' }
  } catch (e) {
    console.warn('ffmpeg.wasm failed, fallback canvas:', e.message)
    onProgress?.(`ffmpeg failed (${e.message.slice(0, 80)}) → canvas fallback (WebM, no xfade)...`)
    const blob = await renderWithCanvas(project, onProgress)
    return { blob, ext: 'webm', mime: 'video/webm' }
  }
}
