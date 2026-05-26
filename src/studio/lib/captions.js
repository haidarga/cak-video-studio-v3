import { falRun } from './api'

// Auto-subtitle: transcribe a video's audio via fal Whisper → caption segments
export async function transcribeVideo(videoUrl, onLog) {
  const result = await falRun('fal-ai/whisper', {
    audio_url: videoUrl,
    task: 'transcribe',
    chunk_level: 'segment',
  }, onLog)
  const chunks = result.chunks || result.segments || []
  const caps = chunks
    .map((c) => {
      const ts = c.timestamp || c.timestamps || [c.start, c.end]
      return { start: Number(ts?.[0]) || 0, end: Number(ts?.[1]) || 0, text: String(c.text || '').trim() }
    })
    .filter((c) => c.text && c.end > c.start)
  if (!caps.length && result.text) {
    // fallback: single block if no timestamps
    caps.push({ start: 0, end: 9999, text: String(result.text).trim() })
  }
  return caps
}

const srtTime = (s) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.round((s % 1) * 1000)
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`
}

export function captionsToSRT(captions) {
  return captions
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n')
}
