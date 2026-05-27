// Two export paths:
// 1) ffmpeg.wasm — produces MP4 (H.264). Requires crossOriginIsolated
//    (COOP/COEP headers set in next.config.mjs for /editor). Faster than
//    realtime for short clips, slower init (~25MB wasm download once).
// 2) MediaRecorder + canvas — produces WebM (VP9). Real-time speed (15s
//    video = ~15s render). No special headers needed. Always available.
//
// We try ffmpeg first; fall back to canvas if anything fails.

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
  // ffmpeg drawtext expects escaping for : \ ' and ,
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\''")
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

// Build ffmpeg filter_complex to apply trim, speed, text + image overlays,
// audio music + volume, output to MP4.
function buildFilterGraph(project, srcDims, canvasDims, audioInputIdx) {
  const { trim_start, trim_end, speed = 1, volume = 1 } = project.source || {}
  const [W, H] = canvasDims
  const filters = []

  // 1. Video pipeline: scale source to canvas dims (letterbox to black canvas)
  filters.push(
    `[0:v]trim=start=${trim_start}:end=${trim_end},setpts=${(1/speed).toFixed(4)}*(PTS-STARTPTS),`
    + `scale=${W}:${H}:force_original_aspect_ratio=decrease,`
    + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[v0]`
  )

  // 2. Image overlays — each input becomes [N:v]
  let currentVideoLabel = '[v0]'
  ;(project.image_clips || []).forEach((c, i) => {
    const inputIdx = 1 + i // input index in ffmpeg args (after source video at 0)
    const x = Math.round((c.x_pct / 100) * W)
    const y = Math.round((c.y_pct / 100) * H)
    const overlayW = Math.round((c.w_pct || 30) / 100 * W)
    const startSrc = (c.start || 0)
    const endSrc = (c.end || trim_end)
    const startOut = Math.max(0, (startSrc - trim_start) / speed)
    const endOut = Math.max(startOut + 0.1, (endSrc - trim_start) / speed)
    const outLabel = `[vi${i}]`
    filters.push(
      `[${inputIdx}:v]scale=${overlayW}:-1[img${i}];`
      + `${currentVideoLabel}[img${i}]overlay=x=${x}-overlay_w/2:y=${y}-overlay_h/2:enable='between(t,${startOut.toFixed(3)},${endOut.toFixed(3)})'${outLabel}`
    )
    currentVideoLabel = outLabel
  })

  // 3. Text overlays — using drawtext (no extra input)
  ;(project.text_clips || []).forEach((c, i) => {
    const x = Math.round((c.x_pct / 100) * W)
    const y = Math.round((c.y_pct / 100) * H)
    const fontSize = Math.round(c.size * (W / 720))
    const startOut = Math.max(0, (c.start - trim_start) / speed)
    const endOut = Math.max(startOut + 0.1, (c.end - trim_start) / speed)
    const txt = escapeDrawText(c.text)
    const color = (c.color || '#ffffff').replace('#', '')
    const align = c.align || 'center'
    const xExpr = align === 'left' ? `${x}`
                : align === 'right' ? `${x}-text_w`
                : `${x}-text_w/2`
    const boxColor = c.bg && c.bg !== 'transparent' ? ':box=1:boxcolor=black@0.6:boxborderw=12' : ''
    const outLabel = `[vt${i}]`
    filters.push(
      `${currentVideoLabel}drawtext=text='${txt}':fontcolor=0x${color}:fontsize=${fontSize}:x=${xExpr}:y=${y}-text_h/2${boxColor}:enable='between(t,${startOut.toFixed(3)},${endOut.toFixed(3)})'${outLabel}`
    )
    currentVideoLabel = outLabel
  })

  // 4. Final video output label
  filters.push(`${currentVideoLabel}copy[vout]`)

  // 5. Audio pipeline: source audio (volume) + music underlay (volume)
  // [0:a] = source audio
  const srcAudio = `[0:a]atrim=start=${trim_start}:end=${trim_end},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(3)},volume=${volume.toFixed(2)}[a0]`
  filters.push(srcAudio)

  const audioClips = project.audio_clips || []
  if (audioClips.length === 0 || audioInputIdx === null) {
    filters.push(`[a0]anull[aout]`)
  } else {
    // Mix source audio with the first audio clip (music underlay).
    const c = audioClips[0]
    const startOut = Math.max(0, (c.start || 0))
    const vol = (c.volume ?? 0.3)
    filters.push(
      `[${audioInputIdx}:a]adelay=${Math.round(startOut * 1000)}|${Math.round(startOut * 1000)},volume=${vol.toFixed(2)}[am]`
    )
    filters.push(`[a0][am]amix=inputs=2:duration=first:dropout_transition=0[aout]`)
  }

  return filters.join(';')
}

// Primary: try ffmpeg.wasm → MP4
export async function renderWithFFmpeg(project, onProgress) {
  if (typeof window === 'undefined') throw new Error('ffmpeg.wasm hanya jalan di browser')
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('SharedArrayBuffer gak available — COOP/COEP headers belum ke-set (cek next.config.mjs)')
  }
  if (!window.crossOriginIsolated) {
    throw new Error('crossOriginIsolated=false — page header belum apply. Reload page setelah deploy.')
  }

  onProgress?.('Loading ffmpeg.wasm (~25MB)... pertama kali load ~10-20 detik')
  const ff = await getFFmpeg((msg) => {
    if (msg.includes('frame=')) {
      const m = msg.match(/frame=\s*(\d+)/)
      if (m) onProgress?.(`Encoding frame ${m[1]}...`)
    }
  })

  onProgress?.('Downloading source video...')
  const sourceUrl = project.source?.url
  if (!sourceUrl) throw new Error('source URL kosong')
  const srcBytes = await fetchToUint8(sourceUrl)
  await ff.writeFile('input.mp4', srcBytes)

  // Download image overlays
  const imageClips = project.image_clips || []
  for (let i = 0; i < imageClips.length; i++) {
    onProgress?.(`Download image overlay ${i + 1}/${imageClips.length}...`)
    const bytes = await fetchToUint8(imageClips[i].src_url)
    await ff.writeFile(`img${i}.png`, bytes)
  }

  // Download music
  const audioClips = project.audio_clips || []
  let audioInputIdx = null
  if (audioClips.length > 0 && audioClips[0].src_url) {
    onProgress?.('Download music underlay...')
    const bytes = await fetchToUint8(audioClips[0].src_url)
    await ff.writeFile('music.mp3', bytes)
    audioInputIdx = 1 + imageClips.length
  }

  // Compute canvas dims from AR
  const ar = project.ar || '9:16'
  const [W, H] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]
  const filter = buildFilterGraph(project, null, [W, H], audioInputIdx)

  const args = ['-i', 'input.mp4']
  imageClips.forEach((_, i) => { args.push('-i', `img${i}.png`) })
  if (audioInputIdx !== null) args.push('-i', 'music.mp3')
  args.push(
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', 'output.mp4'
  )

  onProgress?.('Encoding (ffmpeg)...')
  await ff.exec(args)

  onProgress?.('Reading output...')
  const data = await ff.readFile('output.mp4')
  return new Blob([data.buffer], { type: 'video/mp4' })
}

// Fallback: canvas + MediaRecorder → WebM (no special headers required).
export async function renderWithCanvas(project, onProgress) {
  const { source, text_clips = [], image_clips = [], audio_clips = [], ar } = project
  const { url: sourceUrl, trim_start = 0, trim_end, speed = 1, volume = 1 } = source || {}
  if (!sourceUrl) throw new Error('Source video URL kosong')

  onProgress?.('Loading source video...')
  const video = document.createElement('video')
  video.src = sourceUrl
  video.crossOrigin = 'anonymous'
  video.muted = false
  await new Promise((res, rej) => {
    video.onloadedmetadata = res
    video.onerror = () => rej(new Error('Gagal load source video'))
  })
  const actualTrimEnd = trim_end ?? video.duration

  // Pre-load image overlays
  const overlayImages = await Promise.all(image_clips.map(async (c) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = c.src_url
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    return img
  }))

  // Optional background music — load via Audio element + MediaStream
  let musicEl = null
  const firstAudio = audio_clips[0]
  if (firstAudio?.src_url) {
    musicEl = new Audio(firstAudio.src_url)
    musicEl.crossOrigin = 'anonymous'
    musicEl.volume = firstAudio.volume ?? 0.3
    await new Promise((res, rej) => {
      musicEl.oncanplay = res
      musicEl.onerror = () => rej(new Error('Gagal load music'))
    })
  }

  const [W, H] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  video.playbackRate = speed

  const stream = canvas.captureStream(30)
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const srcNode = audioCtx.createMediaElementSource(video)
    const gain = audioCtx.createGain()
    gain.gain.value = volume
    srcNode.connect(gain)
    const dest = audioCtx.createMediaStreamDestination()
    gain.connect(dest)
    gain.connect(audioCtx.destination)
    if (musicEl) {
      const musicSrc = audioCtx.createMediaElementSource(musicEl)
      const musicGain = audioCtx.createGain()
      musicGain.gain.value = firstAudio.volume ?? 0.3
      musicSrc.connect(musicGain)
      musicGain.connect(dest)
      musicGain.connect(audioCtx.destination)
    }
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
  } catch (e) {
    console.warn('Audio capture skipped:', e.message)
  }

  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }

  video.currentTime = trim_start
  await new Promise((res) => video.onseeked = res)
  if (musicEl) musicEl.currentTime = 0

  recorder.start()
  await video.play()
  if (musicEl) musicEl.play().catch(() => {})

  const dur = (actualTrimEnd - trim_start) / speed
  const startTs = performance.now()
  let stop = false

  function draw() {
    if (stop) return
    const vw = video.videoWidth, vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      const srcAR = vw / vh, dstAR = W / H
      let dw, dh, dx, dy
      if (srcAR > dstAR) { dh = H; dw = dh * srcAR; dx = (W - dw) / 2; dy = 0 }
      else { dw = W; dh = dw / srcAR; dx = 0; dy = (H - dh) / 2 }
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(video, dx, dy, dw, dh)
    }
    const tInTrack = (video.currentTime - trim_start) / speed
    const sourceTime = video.currentTime

    // Image overlays
    image_clips.forEach((c, i) => {
      if (sourceTime < c.start || sourceTime > c.end) return
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

    // Text overlays
    text_clips.forEach((c) => {
      if (sourceTime < c.start || sourceTime > c.end) return
      const x = (c.x_pct / 100) * W
      const y = (c.y_pct / 100) * H
      const fontSize = c.size * (W / 720)
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
      ctx.shadowColor = 'rgba(0,0,0,0.8)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetY = 1
      ctx.fillStyle = c.color
      ctx.fillText(c.text, x, y)
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
    })

    const elapsed = (performance.now() - startTs) / 1000
    const pct = Math.min(100, Math.round((elapsed / dur) * 100))
    onProgress?.(`Recording... ${pct}%`)

    if (video.currentTime >= actualTrimEnd || elapsed > dur + 1) {
      stop = true
      video.pause()
      if (musicEl) musicEl.pause()
      setTimeout(() => recorder.stop(), 100)
      return
    }
    requestAnimationFrame(draw)
  }
  draw()
  await new Promise((res) => { recorder.onstop = res })
  return new Blob(chunks, { type: mimeType })
}

// Combined: try ffmpeg, fall back to canvas. Returns { blob, ext, mime }.
export async function renderProject(project, onProgress) {
  try {
    onProgress?.('Trying ffmpeg.wasm (MP4)...')
    const blob = await renderWithFFmpeg(project, onProgress)
    return { blob, ext: 'mp4', mime: 'video/mp4' }
  } catch (e) {
    console.warn('ffmpeg.wasm failed, falling back to canvas:', e.message)
    onProgress?.(`ffmpeg fail (${e.message.slice(0, 60)}) → fallback canvas (WebM)...`)
    const blob = await renderWithCanvas(project, onProgress)
    return { blob, ext: 'webm', mime: 'video/webm' }
  }
}
