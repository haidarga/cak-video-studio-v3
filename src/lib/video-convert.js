// Client-side WebM → MP4 conversion via canvas + MediaRecorder.
//
// Why this exists: Fast Export now produces MP4 natively on Chrome 122+,
// but older results in /qc are still WebM and Postiz rejects them with
// "Unsupported file type". Rather than ask the user to re-export every
// project from the editor (or use an external tool), this fn plays the
// WebM through a hidden <video>, draws each frame into a canvas, and
// records that canvas via MediaRecorder with video/mp4 mime. Same
// real-time speed as Fast Export (5s clip ≈ 5s convert).
//
// Requires the browser to support video/mp4 in MediaRecorder.
// Falls back with a clear error on browsers that don't.

export async function convertVideoToMp4(url, onProgress) {
  // Pick best MP4 mime — bail if browser can't record MP4. High profile
  // first for best quality after TikTok / IG re-encode.
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', // H264 High @ L4.0
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2', // H264 Main @ L3.1
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H264 Baseline (fallback)
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ]
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) {
    throw new Error('Browser lo gak support recording MP4 (butuh Chrome 122+). Pake browser modern atau re-export dari editor.')
  }

  onProgress?.('Loading video...')

  const video = document.createElement('video')
  video.src = url
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  await new Promise((res, rej) => {
    video.onloadedmetadata = res
    video.onerror = () => rej(new Error('Gagal load source video. URL invalid?'))
  })
  // Some browsers need a separate canplay before play() works smoothly.
  if (video.readyState < 3) {
    await new Promise((res) => { video.oncanplay = res })
  }

  // Upscale to 1080p for the dominant axis — matches TikTok / IG native
  // presentation. Source 720p video gets bicubic-upscaled by the canvas
  // drawImage, which is way smoother than TikTok's upscale would be.
  // Aspect preserved from source.
  const srcW = video.videoWidth || 720
  const srcH = video.videoHeight || 1280
  const targetMin = 1080
  let outW, outH
  if (srcW >= srcH) {
    outW = Math.max(targetMin * (srcW / srcH), targetMin)
    outH = targetMin
  } else {
    outW = targetMin
    outH = Math.max(targetMin * (srcH / srcW), targetMin)
  }
  outW = Math.round(outW); outH = Math.round(outH)
  // Already-1080p sources pass through 1:1.
  if (srcW >= outW && srcH >= outH) { outW = srcW; outH = srcH }

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Build a MediaStream from canvas (video) + audio (via AudioContext).
  // 60 fps capture ceiling for smoother motion through TikTok's re-encode.
  const canvasStream = canvas.captureStream(60)

  let audioCtx = null
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const src = audioCtx.createMediaElementSource(video)
    const dest = audioCtx.createMediaStreamDestination()
    src.connect(dest)
    // Also route to default destination so any playback monitoring works,
    // though we'll keep the video muted to avoid double audio.
    dest.stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t))
  } catch (e) {
    // Some videos can't be re-routed (CORS without proper headers, etc).
    // Convert without audio rather than failing entirely.
    console.warn('audio route failed, converting video-only:', e?.message)
  }

  // 12 Mbps + 256 kbps — matches Fast Export quality tier so converted
  // clips look as clean as freshly-rendered ones after TikTok re-encode.
  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 256_000,
  })
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
  recorder.start()

  onProgress?.('Recording...')
  // Play in muted mode to avoid speakers booming during conversion. The
  // audio still flows through the AudioContext route into the recording.
  video.muted = true
  await video.play()

  // Draw loop.
  let raf
  function draw() {
    if (video.ended || video.paused) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    raf = requestAnimationFrame(draw)
  }
  draw()

  // Wait for playback end. Add a hard timeout based on video duration + buffer.
  await new Promise((res) => {
    const ms = Math.max(2000, (video.duration || 30) * 1000 + 2000)
    const timer = setTimeout(res, ms)
    video.onended = () => { clearTimeout(timer); res() }
  })

  cancelAnimationFrame(raf)
  recorder.stop()
  await new Promise((res) => { recorder.onstop = res })
  try { audioCtx?.close() } catch {}

  const blob = new Blob(chunks, { type: mime })
  return { blob, mime }
}
