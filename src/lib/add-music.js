// Burn an audio track into a video via ffmpeg.wasm. Replaces the video's
// audio with the supplied music file (or adds music if video is silent).
//
// Why: TikTok's autoAddMusic flag is unreliable for video posts via API.
// Workaround = bake the music into the video ourselves before upload.
// Music becomes part of the video stream, TikTok plays it as-is.
//
// Trade-off vs TikTok auto-music:
//   ❌ No "TikTok sound" status (no trending-sound algorithm boost)
//   ✅ Music ALWAYS plays — 100% reliable
//   ✅ User controls track (consistent, can be brand music / persona theme)
//
// Stream copy on video (no re-encode), audio re-encoded to AAC at 192k 48kHz
// for TikTok/IG compatibility. -shortest trims the music if it's longer than
// the video.

import { getFFmpeg, fetchToUint8 } from './editor-render.js'

export async function addMusicToVideo(videoUrl, audioFile, onProgress) {
  onProgress?.('Loading ffmpeg...')
  const ff = await getFFmpeg((msg) => {
    if (msg.includes('frame=') || msg.includes('time=')) onProgress?.('Mixing audio...')
  })
  onProgress?.('Loading video + audio...')
  const videoBytes = await fetchToUint8(videoUrl)
  await ff.writeFile('addmusic-vid.mp4', videoBytes)

  // Audio comes as a File (from browser file input) — read as ArrayBuffer.
  const audioBuf = await audioFile.arrayBuffer()
  await ff.writeFile('addmusic-aud', new Uint8Array(audioBuf))

  onProgress?.('Burning music into video...')
  // -map 0:v = take video from input 0 (the mp4)
  // -map 1:a = take audio from input 1 (the music file)
  // -c:v copy = no video re-encode, INSTANT
  // -c:a aac -b:a 192k -ar 48000 = TikTok/IG-friendly audio encode
  // -shortest = output ends when shorter input ends (video duration)
  // -af loudnorm = normalize audio loudness so it doesn't blast or whisper
  await ff.exec([
    '-i', 'addmusic-vid.mp4',
    '-i', 'addmusic-aud',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-shortest',
    '-movflags', '+faststart',
    '-y', 'addmusic-out.mp4',
  ])

  onProgress?.('Reading output...')
  const data = await ff.readFile('addmusic-out.mp4')
  try { await ff.deleteFile('addmusic-vid.mp4') } catch {}
  try { await ff.deleteFile('addmusic-aud') } catch {}
  try { await ff.deleteFile('addmusic-out.mp4') } catch {}
  return new Blob([data.buffer], { type: 'video/mp4' })
}
