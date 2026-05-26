import { useRef } from 'react'

// Studio-style timeline: caption blocks on a time track, draggable to retime,
// click empty track to seek, synced playhead.
export default function Timeline({ durationSec, captions, currentFrame, fps, selectedIdx, onSeek, onSelect, onCaptionChange }) {
  const trackRef = useRef(null)
  const drag = useRef(null)
  const dur = Math.max(0.1, durationSec)
  const totalFrames = Math.max(1, Math.round(dur * fps))
  const playheadPct = Math.min(100, (currentFrame / totalFrames) * 100)

  const trackDown = (e) => {
    // only seek when clicking empty track (not a caption block)
    if (e.target !== trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(Math.round(pct * totalFrames))
  }

  const blockDown = (e, idx) => {
    e.stopPropagation()
    const blockRect = e.currentTarget.getBoundingClientRect()
    const offX = e.clientX - blockRect.left
    const mode = offX < 10 ? 'l' : offX > blockRect.width - 10 ? 'r' : 'move'
    const cap = captions[idx]
    drag.current = { idx, mode, startX: e.clientX, origStart: cap.start, origEnd: cap.end }
    onSelect(idx)
    onSeek(Math.round(cap.start * fps))
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d || !trackRef.current) return
    const w = trackRef.current.getBoundingClientRect().width
    const deltaSec = ((e.clientX - d.startX) / w) * dur
    let s = d.origStart
    let en = d.origEnd
    if (d.mode === 'move') { s = d.origStart + deltaSec; en = d.origEnd + deltaSec }
    else if (d.mode === 'l') s = Math.min(d.origStart + deltaSec, d.origEnd - 0.2)
    else if (d.mode === 'r') en = Math.max(d.origEnd + deltaSec, d.origStart + 0.2)
    s = Math.max(0, s)
    en = Math.min(dur, en)
    onCaptionChange(d.idx, { start: +s.toFixed(2), end: +en.toFixed(2) })
  }
  const onUp = () => {
    drag.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginBottom: 3, padding: '0 2px' }}>
        {ticks.map((t) => <span key={t}>{(t * dur).toFixed(1)}s</span>)}
      </div>
      <div
        ref={trackRef}
        onPointerDown={trackDown}
        style={{ position: 'relative', height: 60, background: 'var(--surface2)', border: '1px solid var(--border2)', borderRadius: 8, cursor: 'crosshair', overflow: 'hidden' }}
      >
        {captions.map((c, i) => {
          const left = (c.start / dur) * 100
          const width = Math.max(1.5, ((c.end - c.start) / dur) * 100)
          const sel = selectedIdx === i
          return (
            <div
              key={i}
              onPointerDown={(e) => blockDown(e, i)}
              title={c.text}
              style={{
                position: 'absolute', left: left + '%', width: width + '%', top: 8, bottom: 8,
                background: sel ? 'var(--grad)' : 'var(--surface3)',
                border: `1px solid ${sel ? 'transparent' : 'var(--border2)'}`,
                borderRadius: 6, cursor: 'grab', overflow: 'hidden',
                display: 'flex', alignItems: 'center', padding: '0 8px',
                fontSize: 10, color: sel ? '#fff' : 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap',
                boxShadow: sel ? '0 2px 10px rgba(255,60,60,.4)' : 'none',
              }}
            >
              {c.text}
            </div>
          )
        })}
        {/* playhead */}
        <div style={{ position: 'absolute', left: playheadPct + '%', top: 0, bottom: 0, width: 2, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,.8)', pointerEvents: 'none' }}>
          <div style={{ position: 'absolute', top: -1, left: -4, width: 10, height: 10, background: '#fff', borderRadius: '50%' }} />
        </div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 5 }}>
        Klik track buat seek · drag blok caption buat geser timing · drag ujung blok buat resize
      </div>
    </div>
  )
}
