import { falUpload } from './api'

// Extract N evenly-spaced keyframes from a video → [{time, dataUrl, base64}]
export async function extractKeyframes(videoUrl, n = 7) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    const isBlob = videoUrl.startsWith('blob:') || videoUrl.startsWith('data:')
    const src = isBlob ? videoUrl : `https://corsproxy.io/?${encodeURIComponent(videoUrl)}`

    const frames = []
    let timestamps = []
    let idx = 0
    let resolved = false
    const cleanup = () => { try { video.src = ''; video.remove() } catch {} }
    const fail = (e) => { if (!resolved) { resolved = true; cleanup(); reject(e) } }
    const finish = () => { if (!resolved) { resolved = true; cleanup(); resolve(frames) } }

    video.addEventListener('loadedmetadata', () => {
      const dur = video.duration || 10
      timestamps = Array.from({ length: n }, (_, i) => Math.max(0.1, Math.min(dur - 0.1, (dur * (i + 0.5)) / n)))
      video.currentTime = timestamps[0]
    })
    video.addEventListener('seeked', () => {
      if (resolved) return
      try {
        const c = document.createElement('canvas')
        const maxDim = 720
        let w = video.videoWidth || 720
        let h = video.videoHeight || 1280
        if (Math.max(w, h) > maxDim) {
          const scale = maxDim / Math.max(w, h)
          w = Math.round(w * scale); h = Math.round(h * scale)
        }
        c.width = w; c.height = h
        c.getContext('2d').drawImage(video, 0, 0, w, h)
        const dataUrl = c.toDataURL('image/jpeg', 0.82)
        frames.push({ time: timestamps[idx], dataUrl, base64: dataUrl.replace(/^data:image\/jpeg;base64,/, '') })
        idx++
        if (idx >= timestamps.length) finish()
        else video.currentTime = timestamps[idx]
      } catch (e) { fail(e) }
    })
    video.addEventListener('error', () => fail(new Error('Video load error (CORS atau format gak didukung)')))
    setTimeout(() => fail(new Error('Timeout (45s)')), 45000)
    video.src = src
  })
}

// Grab the final frame of a video, upload to fal, return its URL
export async function extractLastFrameFromVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const proxied = `https://corsproxy.io/?${encodeURIComponent(videoUrl)}`
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.preload = 'metadata'
    let resolved = false
    video.src = proxied
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.max(0, video.duration - 0.1)
    })
    video.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas')
        c.width = video.videoWidth
        c.height = video.videoHeight
        c.getContext('2d').drawImage(video, 0, 0)
        c.toBlob(async (blob) => {
          if (blob && !resolved) {
            resolved = true
            try { resolve(await falUpload(blob, 'lastframe.jpg')) }
            catch { resolve(URL.createObjectURL(blob)) }
          }
        }, 'image/jpeg', 0.92)
      } catch (e) { if (!resolved) { resolved = true; reject(e) } }
    }, { once: true })
    video.addEventListener('error', () => { if (!resolved) { resolved = true; reject(new Error('Video load error')) } }, { once: true })
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('Timeout')) } }, 15000)
  })
}
