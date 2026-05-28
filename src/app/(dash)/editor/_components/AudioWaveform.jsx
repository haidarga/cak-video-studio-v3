'use client'
import { useEffect, useRef, useState } from 'react'

// Render audio waveform from URL using Web Audio API decode + canvas viz.
// Caches peak data in component state to avoid re-decoding.
export default function AudioWaveform({ url, width, height, color = '#fbbf24' }) {
  const canvasRef = useRef(null)
  const [peaks, setPeaks] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!url) return
    let aborted = false
    setError(false); setPeaks(null)
    ;(async () => {
      try {
        const res = await fetch(url, { cache: 'force-cache' })
        const buf = await res.arrayBuffer()
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const audio = await ctx.decodeAudioData(buf)
        if (aborted) return
        // Sample to N peaks
        const samples = 200
        const channel = audio.getChannelData(0)
        const blockSize = Math.floor(channel.length / samples)
        const out = new Float32Array(samples)
        for (let i = 0; i < samples; i++) {
          let max = 0
          for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(channel[i * blockSize + j] || 0)
            if (v > max) max = v
          }
          out[i] = max
        }
        setPeaks(out)
      } catch (e) {
        console.warn('Waveform decode failed:', e.message)
        if (!aborted) setError(true)
      }
    })()
    return () => { aborted = true }
  }, [url])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width = canvas.clientWidth * 2
    const h = canvas.height = canvas.clientHeight * 2
    ctx.fillStyle = 'transparent'
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = color
    const barW = w / peaks.length
    for (let i = 0; i < peaks.length; i++) {
      const barH = Math.max(2, peaks[i] * h * 0.85)
      ctx.fillRect(i * barW, (h - barH) / 2, barW * 0.6, barH)
    }
  }, [peaks, color])

  if (error) return <div className="text-[9px] text-[var(--muted2)] p-1">Waveform load failed</div>

  return (
    <canvas ref={canvasRef} className="w-full h-full"
      style={{ width: width || '100%', height: height || '100%', display: 'block' }} />
  )
}
