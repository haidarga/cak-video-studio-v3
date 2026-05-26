import { useState, useMemo, useRef, useEffect } from 'react'
import { Player } from '@remotion/player'
import { StudioVideo, studioDurationSec } from '../../remotion/StudioVideo'
import { FONT_NAMES } from '../../remotion/fonts'
import Timeline from '../components/Timeline'
import { useStudio } from '../store'
import { callGemini, extractJSON, downloadFile, falUpload, sleep } from '../lib/api'
import { transcribeVideo, captionsToSRT } from '../lib/captions'
import { CAPTION_PRESETS, CAPTION_ANIMS } from '../lib/constants'

const FPS = 30
const TRACK_H = 48 // px per video track row
const AR_DIM = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] }
const DEFAULT_STYLE = { fontSize: 70, position: 'bottom', color: '#ffffff', stroke: '#000000', uppercase: true, bg: false, fontFamily: 'Inter', anim: 'pop', x: null, y: null }
let cseq = 0

// timecode hh:mm:ss or mm:ss
const fmtTC = (s) => {
  s = Math.max(0, s)
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
}

export default function PostProTab() {
  const S = useStudio()
  const playerRef = useRef(null)
  const overlayRef = useRef(null)
  const capDrag = useRef(false)
  const clipTrackRef = useRef(null)
  const clipDrag = useRef(null)

  const [clips, setClips] = useState([])       // {id,url,label,srcDur,start,duration,trimStart,muted}
  const [captions, setCaptions] = useState([]) // {start,end,text}
  const [capStyle, setCapStyle] = useState(DEFAULT_STYLE)
  const [audio, setAudio] = useState(null)     // {url,name,srcDur,trimStart,volume}
  const [ar, setAr] = useState('9:16')
  const [sel, setSel] = useState(null)         // {kind:'clip',id} | {kind:'caption',idx} | {kind:'audio'}
  const [currentFrame, setCurrentFrame] = useState(0)
  const [busy, setBusy] = useState('')
  const [log, setLog] = useState([])
  const [urlInput, setUrlInput] = useState('')

  const [w, h] = AR_DIM[ar]
  const totalSec = useMemo(() => studioDurationSec(clips), [clips])
  const durationInFrames = Math.max(1, Math.round(totalSec * FPS))
  const videoResults = useMemo(() => S.results.filter((r) => r.type === 'video'), [S.results])
  const pushLog = (m) => setLog((l) => [...l, m])

  const preview = useMemo(() => {
    const scale = Math.min(440 / w, 420 / h)
    return { width: Math.round(w * scale), height: Math.round(h * scale) }
  }, [w, h])

  // stable inputProps — keeps the Player from churning on every re-render
  const playerInput = useMemo(() => ({
    clips: clips.map((c) => ({ id: c.id, url: c.url, start: c.start, duration: c.duration, trimStart: c.trimStart, muted: c.muted, track: c.track || 0, srcDur: c.srcDur })),
    captions, capStyle,
    audio: audio ? { url: audio.url, trimStart: audio.trimStart, volume: audio.volume } : null,
  }), [clips, captions, capStyle, audio])

  // ── clip ops ──
  function addClip(url, label) {
    if (!url) return
    const id = 'pc' + ++cseq
    const add = (srcDur) => {
      // append at the timeline tail on track 0 (main lane). Drag up to overlay on higher tracks.
      setClips((p) => {
        const tail = p.filter((c) => (c.track || 0) === 0).reduce((m, c) => Math.max(m, (c.start || 0) + (c.duration || 0)), 0)
        return [...p, { id, url, label: label || `Clip ${p.length + 1}`, srcDur, start: +tail.toFixed(2), duration: srcDur, trimStart: 0, muted: false, track: 0 }]
      })
      setSel({ kind: 'clip', id })
    }
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'; v.preload = 'metadata'
    v.onloadedmetadata = () => add(v.duration && isFinite(v.duration) ? +v.duration.toFixed(2) : 5)
    v.onerror = () => add(5)
    v.src = url
  }
  const patchClip = (id, patch) => setClips((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const removeClip = (id) => { setClips((p) => p.filter((c) => c.id !== id)); setSel(null) }
  // split the topmost clip under the playhead into two
  function splitAtPlayhead() {
    if (!clips.length) { S.toast('Gak ada clip', 'error'); return }
    const t = currentFrame / FPS
    const candidates = clips.filter((c) => c.start < t && c.start + c.duration > t)
    if (!candidates.length) { S.toast('Posisikan playhead di atas clip dulu', 'error'); return }
    // topmost = highest track, then latest in array
    const target = candidates.reduce((best, c) => {
      if (!best) return c
      const bT = best.track || 0, cT = c.track || 0
      if (cT > bT) return c
      if (cT === bT && clips.indexOf(c) > clips.indexOf(best)) return c
      return best
    }, null)
    const localCut = t - target.start
    if (localCut < 0.2 || target.duration - localCut < 0.2) {
      S.toast('Terlalu dekat ujung clip — geser playhead', 'error'); return
    }
    const newId = 'pc' + ++cseq
    setClips((p) => {
      const idx = p.findIndex((c) => c.id === target.id)
      if (idx < 0) return p
      const first = { ...target, duration: +localCut.toFixed(2) }
      const second = { ...target, id: newId, start: +t.toFixed(2), duration: +(target.duration - localCut).toFixed(2), trimStart: +((target.trimStart || 0) + localCut).toFixed(2) }
      const next = [...p]
      next.splice(idx, 1, first, second)
      return next
    })
    setSel({ kind: 'clip', id: newId })
    S.toast('Clip split ✂')
  }

  // consume cross-tab handoffs (single video from any tab, or N clips from Quick)
  useEffect(() => {
    if (S.postProSource) { addClip(S.postProSource, 'Clip 1'); S.setPostProSource(null) }
    if (S.combineSources && S.combineSources.length) {
      S.combineSources.forEach((u, i) => addClip(u, `Clip ${i + 1}`))
      S.setCombineSources(null)
    }
    // eslint-disable-next-line
  }, [])

  useEffect(() => {
    const p = playerRef.current
    if (!p) return
    const onFrame = (e) => setCurrentFrame(e.detail.frame)
    p.addEventListener('frameupdate', onFrame)
    return () => { try { p.removeEventListener('frameupdate', onFrame) } catch {} }
  }, [clips.length])

  const seek = (frame) => { try { playerRef.current?.seekTo(Math.max(0, Math.min(durationInFrames - 1, frame))) } catch {} }

  // ── source uploads ──
  async function uploadClipFile(e) {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    setBusy('upload')
    try { const fu = await falUpload(f, f.name || 'footage.mp4'); addClip(fu, f.name || 'Local clip'); S.toast('Footage ke-upload ✓') }
    catch (err) { S.toast('Upload gagal: ' + err.message, 'error') }
    setBusy('')
  }
  async function importAudio(e) {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    setBusy('audio')
    try {
      const url = await falUpload(f, f.name || 'audio.mp3')
      const a = document.createElement('audio'); a.preload = 'metadata'
      a.onloadedmetadata = () => setAudio({ url, name: f.name || 'Audio', srcDur: +(a.duration && isFinite(a.duration) ? a.duration : 15).toFixed(2), trimStart: 0, volume: 1 })
      a.onerror = () => setAudio({ url, name: f.name || 'Audio', srcDur: 15, trimStart: 0, volume: 1 })
      a.src = url
      S.toast('Audio ke-upload ✓')
    } catch (err) { S.toast('Upload audio gagal: ' + err.message, 'error') }
    setBusy('')
  }
  const removeAudio = () => { setAudio(null); setSel((s) => (s?.kind === 'audio' ? null : s)) }

  // ── clip drag/resize on the timeline ──
  // move-mode handles BOTH horizontal (start) and vertical (track) drag together — CapCut feel
  const onClipMove = (e) => {
    const d = clipDrag.current
    if (!d || !clipTrackRef.current) return
    const wpx = clipTrackRef.current.getBoundingClientRect().width
    const deltaSec = ((e.clientX - d.startX) / wpx) * d.span
    let s = d.origStart, dur = d.origDur, track = d.origTrack
    if (d.mode === 'move') {
      s = Math.max(0, d.origStart + deltaSec)
      // dragging UP increases track number (since UI shows higher tracks on top)
      // small deadzone so horizontal drags don't accidentally jump tracks
      const dy = d.startY - e.clientY
      const deltaTracks = Math.abs(dy) < 14 ? 0 : Math.round(dy / TRACK_H)
      track = Math.max(0, d.origTrack + deltaTracks)
    } else if (d.mode === 'l') {
      s = Math.max(0, Math.min(d.origStart + d.origDur - 0.3, d.origStart + deltaSec))
      dur = d.origDur - (s - d.origStart)
    } else if (d.mode === 'r') {
      dur = Math.max(0.3, d.origDur + deltaSec)
    }
    setClips((p) => p.map((c) => (c.id === d.id ? { ...c, start: +s.toFixed(2), duration: +dur.toFixed(2), track } : c)))
  }
  const onClipUp = () => {
    clipDrag.current = null
    window.removeEventListener('pointermove', onClipMove)
    window.removeEventListener('pointerup', onClipUp)
  }
  const clipDown = (e, c) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const offX = e.clientX - rect.left
    const mode = offX < 10 ? 'l' : offX > rect.width - 10 ? 'r' : 'move'
    // lock the px→sec ratio at drag start so resizing past totalSec doesn't jump
    clipDrag.current = { id: c.id, mode, startX: e.clientX, startY: e.clientY, origStart: c.start, origDur: c.duration, origTrack: c.track || 0, span: Math.max(totalSec, c.start + c.duration + 1) }
    setSel({ kind: 'clip', id: c.id })
    window.addEventListener('pointermove', onClipMove)
    window.addEventListener('pointerup', onClipUp)
  }

  // ── captions ──
  const patchCaption = (idx, patch) => setCaptions((p) => p.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  const deleteCaption = (idx) => { setCaptions((p) => p.filter((_, i) => i !== idx)); setSel(null) }
  const addCaption = () => {
    const t = currentFrame / FPS
    setCaptions((p) => [...p, { start: +t.toFixed(2), end: +Math.min(totalSec, t + 2).toFixed(2), text: 'Caption baru' }]
      .sort((a, b) => a.start - b.start))
  }
  async function autoSubtitle() {
    if (!clips.length) { S.toast('Tambah clip dulu', 'error'); return }
    setBusy('subtitle'); pushLog('🎙️ Transcribe clip pertama via Whisper...')
    try {
      const caps = await transcribeVideo(clips[0].url, pushLog)
      setCaptions(caps); setSel(caps.length ? { kind: 'caption', idx: 0 } : null)
      pushLog(`✅ ${caps.length} caption segment`)
      S.toast('Auto-subtitle ✓')
    } catch (e) { pushLog('❌ ' + e.message); S.toast('Transcribe gagal: ' + e.message, 'error') }
    setBusy('')
  }
  async function autoStyle() {
    if (!captions.length) { S.toast('Auto-subtitle dulu', 'error'); return }
    setBusy('style')
    try {
      const transcript = captions.map((c) => c.text).join(' ').slice(0, 800)
      const prompt = `You are a CapCut-style caption designer. Pick the best caption style for this transcript.
Transcript: "${transcript}"
Return ONLY JSON: {"fontSize":60-95,"position":"bottom|center|top","color":"#hex","stroke":"#hex","uppercase":true/false,"bg":true/false,"anim":"pop|slide|fade|bounce"}`
      const res = extractJSON(await callGemini(prompt, { json: true }))
      setCapStyle((s) => ({ ...s, ...res }))
      S.toast('Auto-style ✓')
    } catch (e) { S.toast('Auto-style gagal: ' + e.message, 'error') }
    setBusy('')
  }

  // ── caption position drag on the preview ──
  const markerPos = () => ({
    x: capStyle.x ?? 50,
    y: capStyle.y ?? (capStyle.position === 'top' ? 11 : capStyle.position === 'center' ? 50 : 84),
  })
  const onCapMove = (e) => {
    if (!capDrag.current || !overlayRef.current) return
    const r = overlayRef.current.getBoundingClientRect()
    const x = Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100))
    const y = Math.max(2, Math.min(98, ((e.clientY - r.top) / r.height) * 100))
    setCapStyle((s) => ({ ...s, x: +x.toFixed(1), y: +y.toFixed(1) }))
  }
  const onCapUp = () => {
    capDrag.current = false
    window.removeEventListener('pointermove', onCapMove)
    window.removeEventListener('pointerup', onCapUp)
  }
  const startCapDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    capDrag.current = true
    window.addEventListener('pointermove', onCapMove)
    window.addEventListener('pointerup', onCapUp)
  }

  // ── render ──
  async function renderFinal() {
    if (!clips.length) { S.toast('Tambah clip dulu', 'error'); return }
    setBusy('render'); setLog(['🎬 Mulai render di server...'])
    try {
      const inputProps = {
        clips: clips.map((c) => ({ url: c.url, start: c.start, duration: c.duration, trimStart: c.trimStart, muted: c.muted, track: c.track || 0, srcDur: c.srcDur })),
        captions, capStyle,
        audio: audio ? { url: audio.url, trimStart: audio.trimStart, volume: audio.volume } : null,
        durationSec: totalSec, width: w, height: h,
      }
      const start = await fetch(apiUrl('/api/render'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ composition: 'StudioVideo', inputProps }),
      })
      if (!start.ok) throw new Error(`Gagal mulai render (${start.status})`)
      const { jobId } = await start.json()
      pushLog('⏳ Render jalan (job ' + jobId.slice(0, 8) + ')...')
      let done = false
      for (let i = 1; i <= 240 && !done; i++) {
        await sleep(3000)
        let j
        try { j = await (await fetch(apiUrl('/api/render/' + jobId))).json() } catch { continue }
        if (j.status === 'done') { done = true; break }
        if (j.status === 'error') throw new Error(j.error || 'Render error')
        if (j.status === 'notfound') throw new Error('Render job hilang (server restart?)')
        if (i % 5 === 0) pushLog(`⏳ masih render... (${i * 3}s)`)
      }
      if (!done) throw new Error('Render timeout (>12 menit)')
      pushLog('⬇️ Ngambil hasil...')
      const fileRes = await fetch(apiUrl('/api/render/' + jobId + '/file'))
      if (!fileRes.ok) throw new Error('Gagal ambil file render')
      const blob = await fileRes.blob()
      pushLog('⬆️ Nyimpen ke library...')
      let url
      try { url = await falUpload(blob, 'studio.mp4') }
      catch { url = URL.createObjectURL(blob) }
      pushLog('✅ Render done')
      S.addResult({ url, type: 'video', label: 'Studio edit', ar })
      downloadFile(url, 'studio_edit.mp4')
      S.toast('Render selesai ✓ — masuk Results')
    } catch (e) { pushLog('❌ ' + e.message); S.toast('Render gagal: ' + e.message, 'error') }
    setBusy('')
  }

  const setStyle = (patch) => setCapStyle((s) => ({ ...s, ...patch }))
  const applyPreset = (p) => setCapStyle((s) => ({ ...s, ...p.style, x: null, y: null }))

  const selClip = sel?.kind === 'clip' ? clips.find((c) => c.id === sel.id) : null
  const selCap = sel?.kind === 'caption' ? captions[sel.idx] : null
  const audioPlay = audio ? Math.max(0.3, audio.srcDur - audio.trimStart) : 0

  // ── multi-track timeline derived ──
  const maxUsedTrack = clips.reduce((m, c) => Math.max(m, c.track || 0), 0)
  const trackCount = Math.max(2, maxUsedTrack + 2)                          // show used + 1 empty above
  const trackList = Array.from({ length: trackCount }, (_, i) => trackCount - 1 - i) // top→bottom (high→low)
  const playheadPct = totalSec > 0 ? Math.min(100, (currentFrame / FPS / totalSec) * 100) : 0
  const tickStep = totalSec <= 6 ? 1 : totalSec <= 15 ? 2 : totalSec <= 30 ? 5 : totalSec <= 60 ? 10 : Math.max(10, Math.round(totalSec / 8))
  const ruler = []
  for (let t = 0; t <= totalSec; t += tickStep) ruler.push(t)

  // ── 1. no clips → add source ──
  if (!clips.length) {
    return (
      <div className="pane active">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-title">🎬 Editor — Tambah Clip Pertama</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input type="url" placeholder="Paste video URL..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
            <button className="btn btn-ghost btn-sm" onClick={() => { addClip(urlInput.trim()); setUrlInput('') }}>+ Add URL</button>
            <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
              {busy === 'upload' ? '⏳ Uploading...' : '📁 Upload device'}
              <input type="file" accept="video/*" style={{ display: 'none' }} onChange={uploadClipFile} disabled={busy === 'upload'} />
            </label>
          </div>
          {!!videoResults.length && (
            <select value="" onChange={(e) => { if (e.target.value) addClip(e.target.value, videoResults.find((x) => x.url === e.target.value)?.label) }}>
              <option value="">— atau ambil dari Results —</option>
              {videoResults.map((r, i) => <option key={i} value={r.url}>{r.label}</option>)}
            </select>
          )}
        </div>
        <div className="card">
          <div className="empty-state">
            <div className="es-icon">🎬</div>
            <h3>Editor Timeline — Bebas Timpah Tindih</h3>
            <p>Tambah clip sebanyaknya, drag ke mana aja di timeline — mau berderet, mau numpuk-numpuk jadi overlay, terserah. Kasih caption + audio terus render.</p>
          </div>
        </div>
      </div>
    )
  }

  // ── 2. editor ──
  return (
    <div className="pane active">
      {/* source bar */}
      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="badge badge-blue">{clips.length} clip · {totalSec.toFixed(1)}s</span>
        <input type="url" placeholder="+ video URL..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => { addClip(urlInput.trim()); setUrlInput('') }}>+ URL</button>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
          {busy === 'upload' ? '⏳...' : '📁 Clip'}
          <input type="file" accept="video/*" style={{ display: 'none' }} onChange={uploadClipFile} disabled={!!busy} />
        </label>
        {!!videoResults.length && (
          <select value="" onChange={(e) => { if (e.target.value) addClip(e.target.value, videoResults.find((x) => x.url === e.target.value)?.label) }} style={{ width: 'auto', minWidth: 130 }}>
            <option value="">+ dari Results</option>
            {videoResults.map((r, i) => <option key={i} value={r.url}>{r.label}</option>)}
          </select>
        )}
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
          {busy === 'audio' ? '⏳...' : '🎵 Audio'}
          <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={importAudio} disabled={!!busy} />
        </label>
        <button className="btn btn-ghost btn-sm" onClick={splitAtPlayhead} title="Split clip di posisi playhead">✂ Split</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
        {/* LEFT — preview + timeline */}
        <div className="card">
          <div className="section-title">Preview &amp; Timeline</div>
          <div style={{ display: 'flex', justifyContent: 'center', background: '#000', borderRadius: 10, padding: 10, border: '1px solid var(--border)' }}>
            <div style={{ position: 'relative', width: preview.width, height: preview.height }}>
              <Player
                ref={playerRef}
                component={StudioVideo}
                durationInFrames={durationInFrames}
                fps={FPS}
                compositionWidth={w}
                compositionHeight={h}
                inputProps={playerInput}
                style={{ width: preview.width, height: preview.height }}
                controls
                acknowledgeRemotionLicense
              />
              {!!captions.length && (
                <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  <div onPointerDown={startCapDrag} title="Drag buat geser posisi caption"
                    style={{ position: 'absolute', left: markerPos().x + '%', top: markerPos().y + '%', transform: 'translate(-50%,-50%)', pointerEvents: 'auto', cursor: 'grab', padding: '3px 8px', background: 'rgba(255,60,60,.9)', border: '1.5px solid #fff', borderRadius: 6, fontSize: 9, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap', userSelect: 'none' }}>
                    📍 caption
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* video tracks — multi-lane CapCut-style: drag horizontal = geser, vertical = pindah track, ujung = resize */}
          <div style={{ fontSize: 10, color: 'var(--muted)', margin: '12px 0 5px', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px' }}>
            🎬 Video — <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted2)' }}>drag tengah = geser · drag atas/bawah = pindah track · tarik ujung = resize · ✂ split di playhead</span>
          </div>
          <div style={{ position: 'relative', background: 'var(--surface2)', border: '1px solid var(--border2)', borderRadius: 8, overflow: 'hidden' }}>
            {/* time ruler — click to seek */}
            <div onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
              seek(Math.round(pct * totalSec * FPS))
            }} style={{ position: 'relative', height: 22, cursor: 'pointer', borderBottom: '1px solid var(--border)', background: 'var(--surface3)' }}>
              {ruler.map((t, i) => (
                <div key={i} style={{ position: 'absolute', left: `${(t / Math.max(totalSec, 0.1)) * 100}%`, top: 0, height: '100%', pointerEvents: 'none' }}>
                  <div style={{ width: 1, height: 5, background: 'var(--muted2)', marginTop: 2 }} />
                  <span style={{ position: 'absolute', top: 7, left: 3, fontSize: 9, color: 'var(--muted)' }}>{fmtTC(t)}</span>
                </div>
              ))}
            </div>

            {/* track lanes — top to bottom, highest track first */}
            <div ref={clipTrackRef} style={{ position: 'relative' }}>
              {trackList.map((track) => (
                <div key={track} style={{ position: 'relative', height: TRACK_H, borderTop: '1px solid var(--border)' }}>
                  <span style={{ position: 'absolute', left: 4, top: 3, fontSize: 8, color: 'var(--muted2)', zIndex: 1, fontWeight: 700, pointerEvents: 'none' }}>T{track + 1}</span>
                  {clips.filter((c) => (c.track || 0) === track).map((c) => {
                    const left = (c.start / Math.max(totalSec, 0.1)) * 100
                    const width = Math.max(1.5, (c.duration / Math.max(totalSec, 0.1)) * 100)
                    const on = sel?.kind === 'clip' && sel.id === c.id
                    return (
                      <div key={c.id} onPointerDown={(e) => clipDown(e, c)} title={`${c.label} · ${c.duration.toFixed(1)}s @ T${track + 1}`}
                        style={{
                          position: 'absolute', left: left + '%', width: width + '%', top: 4, bottom: 4, borderRadius: 6,
                          background: on ? 'var(--grad)' : 'var(--surface3)',
                          border: `1px solid ${on ? 'transparent' : 'var(--border2)'}`,
                          display: 'flex', alignItems: 'center', padding: '0 8px', gap: 4,
                          fontSize: 10.5, color: on ? '#fff' : 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
                          cursor: 'grab', userSelect: 'none',
                          zIndex: on ? 50 : 10,
                          boxShadow: on ? '0 3px 12px rgba(255,60,60,.4)' : 'none',
                        }}>
                        <span>🎞️</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</span>
                        <span style={{ fontSize: 9, opacity: .8, marginLeft: 'auto' }}>{c.duration.toFixed(1)}s</span>
                      </div>
                    )
                  })}
                </div>
              ))}
              {/* playhead spans all tracks */}
              <div style={{ position: 'absolute', left: playheadPct + '%', top: 0, bottom: 0, width: 2, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,.6)', pointerEvents: 'none', zIndex: 60 }}>
                <div style={{ position: 'absolute', top: -3, left: -4, width: 10, height: 10, background: '#fff', borderRadius: '50%' }} />
              </div>
            </div>
          </div>

          {/* caption track */}
          <div style={{ fontSize: 10, color: 'var(--muted)', margin: '12px 0 0', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px' }}>💬 Caption</div>
          <Timeline
            durationSec={totalSec} captions={captions} currentFrame={currentFrame} fps={FPS}
            selectedIdx={sel?.kind === 'caption' ? sel.idx : null}
            onSeek={seek} onSelect={(idx) => setSel({ kind: 'caption', idx })} onCaptionChange={patchCaption}
          />

          {/* audio track */}
          <div style={{ fontSize: 10, color: 'var(--muted)', margin: '12px 0 5px', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px' }}>🎵 Audio</div>
          {audio ? (
            <div onClick={() => setSel({ kind: 'audio' })}
              style={{
                height: 40, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
                width: `${Math.min(100, (audioPlay / totalSec) * 100)}%`, minWidth: 90,
                background: sel?.kind === 'audio' ? 'var(--grad)' : 'var(--surface3)',
                border: `1px solid ${sel?.kind === 'audio' ? 'transparent' : 'var(--border2)'}`,
                color: sel?.kind === 'audio' ? '#fff' : 'var(--muted)', fontSize: 11, fontWeight: 600,
              }}>
              🎵 <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{audio.name}</span>
              <span style={{ fontSize: 9, opacity: .8 }}>{audioPlay.toFixed(1)}s</span>
            </div>
          ) : (
            <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
              ＋ Import musik / voiceover
              <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={importAudio} disabled={!!busy} />
            </label>
          )}

          {!!log.length && <div className="log-box" style={{ marginTop: 12 }}>{log.map((l, i) => <div key={i} className="log-line">{l}</div>)}</div>}
        </div>

        {/* RIGHT — inspector + caption tools + style + render */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* inspector */}
          <div className="card">
            <div className="section-title">Inspector</div>
            {selClip ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>🎞️ {selClip.label} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· source {selClip.srcDur}s</span></div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}><label>Start (s)</label>
                    <input type="number" step="0.1" min={0} value={selClip.start}
                      onChange={(e) => patchClip(selClip.id, { start: Math.max(0, +e.target.value) })} /></div>
                  <div style={{ flex: 1 }}><label>Duration (s)</label>
                    <input type="number" step="0.1" min={0.3} max={selClip.srcDur} value={selClip.duration}
                      onChange={(e) => patchClip(selClip.id, { duration: Math.max(0.3, Math.min(+e.target.value, selClip.srcDur)) })} /></div>
                </div>
                <div><label>Trim Start (s) — skip ke dalam source</label>
                  <input type="number" step="0.1" min={0} max={Math.max(0, selClip.srcDur - 0.3)} value={selClip.trimStart}
                    onChange={(e) => patchClip(selClip.id, { trimStart: Math.max(0, Math.min(+e.target.value, selClip.srcDur - 0.3)) })} /></div>
                <div className="toggle-wrap" style={{ marginTop: 4 }}>
                  <div className={'toggle' + (selClip.muted ? ' on' : '')} onClick={() => patchClip(selClip.id, { muted: !selClip.muted })} />
                  <span style={{ fontSize: 13 }}>Mute clip ini (buat overlay tanpa suara)</span>
                </div>
                <div>
                  <label>Track (lane) — z-order</label>
                  <input type="number" min={0} step={1} value={selClip.track || 0}
                    onChange={(e) => patchClip(selClip.id, { track: Math.max(0, Math.floor(+e.target.value || 0)) })} />
                  <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 4 }}>Track makin gede = makin di atas (overlay). T1 = paling bawah. Drag clip vertikal di timeline juga jalan.</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={splitAtPlayhead} style={{ flex: 1 }} title="Split clip ini di posisi playhead">✂ Split di playhead</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeClip(selClip.id)} style={{ flex: 1, color: '#fca5a5' }}>🗑 Hapus</button>
                </div>
              </div>
            ) : selCap ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>💬 Caption</div>
                <textarea rows={2} value={selCap.text} onChange={(e) => patchCaption(sel.idx, { text: e.target.value })} style={{ fontSize: 13 }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}><label>Start (s)</label>
                    <input type="number" step="0.1" value={selCap.start} onChange={(e) => patchCaption(sel.idx, { start: +e.target.value })} /></div>
                  <div style={{ flex: 1 }}><label>End (s)</label>
                    <input type="number" step="0.1" value={selCap.end} onChange={(e) => patchCaption(sel.idx, { end: +e.target.value })} /></div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => deleteCaption(sel.idx)} style={{ color: '#fca5a5' }}>🗑 Hapus caption</button>
              </div>
            ) : audio && sel?.kind === 'audio' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>🎵 {audio.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {audio.srcDur}s</span></div>
                <div><label>Trim Start (s) — skip intro audio</label>
                  <input type="number" step="0.1" min={0} max={audio.srcDur} value={audio.trimStart}
                    onChange={(e) => setAudio((a) => ({ ...a, trimStart: Math.max(0, Math.min(+e.target.value, a.srcDur - 0.3)) }))} /></div>
                <div><label>Volume: {Math.round(audio.volume * 100)}%</label>
                  <input type="range" min={0} max={1.5} step={0.05} value={audio.volume}
                    onChange={(e) => setAudio((a) => ({ ...a, volume: +e.target.value }))} /></div>
                <button className="btn btn-ghost btn-sm" onClick={removeAudio} style={{ color: '#fca5a5' }}>🗑 Hapus audio</button>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Klik clip / caption / audio di timeline buat edit.</div>
            )}
          </div>

          {/* caption tools */}
          <div className="card">
            <div className="section-title">Caption</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={autoSubtitle} disabled={!!busy}>{busy === 'subtitle' ? '⏳...' : '🎙️ Auto-Subtitle'}</button>
              <button className="btn btn-ghost btn-sm" onClick={autoStyle} disabled={!!busy || !captions.length}>{busy === 'style' ? '⏳...' : '✨ Auto-Style'}</button>
              <button className="btn btn-ghost btn-sm" onClick={addCaption}>＋ Caption</button>
              {!!captions.length && (
                <button className="btn btn-ghost btn-sm" onClick={() => downloadFile('data:text/plain;charset=utf-8,' + encodeURIComponent(captionsToSRT(captions)), 'captions.srt')}>⬇️ SRT</button>
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 6 }}>Auto-Subtitle transcribe clip pertama. Multi-clip? geser timing caption manual.</div>
          </div>

          {/* caption style */}
          <div className="card">
            <div className="section-title">Caption Style</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {CAPTION_PRESETS.map((p) => (
                <button key={p.name} className="btn btn-ghost btn-sm" onClick={() => applyPreset(p)} style={{ fontSize: 11 }}>{p.name}</button>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label>Font</label>
                <select value={capStyle.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })}>
                  {FONT_NAMES.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label>Font Size: {capStyle.fontSize}</label>
                <input type="range" min={40} max={120} value={capStyle.fontSize} onChange={(e) => setStyle({ fontSize: +e.target.value })} />
              </div>
              <div>
                <label>Animation</label>
                <div className="pill-group">
                  {CAPTION_ANIMS.map((a) => (
                    <div key={a.v} className={'pill' + (capStyle.anim === a.v ? ' active' : '')} onClick={() => setStyle({ anim: a.v })}>{a.l}</div>
                  ))}
                </div>
              </div>
              <div>
                <label>Position {capStyle.x != null && <span style={{ color: 'var(--accent)', textTransform: 'none', letterSpacing: 0 }}>· 📍 custom (drag di preview)</span>}</label>
                <div className="pill-group">
                  {['top', 'center', 'bottom'].map((p) => (
                    <div key={p} className={'pill' + (capStyle.position === p && capStyle.x == null ? ' active' : '')} onClick={() => setStyle({ position: p, x: null, y: null })}>{p}</div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}><label>Text Color</label>
                  <input type="color" value={capStyle.color} onChange={(e) => setStyle({ color: e.target.value })} style={{ height: 38, padding: 3 }} /></div>
                <div style={{ flex: 1 }}><label>Stroke</label>
                  <input type="color" value={capStyle.stroke} onChange={(e) => setStyle({ stroke: e.target.value })} style={{ height: 38, padding: 3 }} /></div>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <div className="toggle-wrap">
                  <div className={'toggle' + (capStyle.uppercase ? ' on' : '')} onClick={() => setStyle({ uppercase: !capStyle.uppercase })} />
                  <span style={{ fontSize: 13 }}>UPPERCASE</span>
                </div>
                <div className="toggle-wrap">
                  <div className={'toggle' + (capStyle.bg ? ' on' : '')} onClick={() => setStyle({ bg: !capStyle.bg })} />
                  <span style={{ fontSize: 13 }}>BG box</span>
                </div>
              </div>
              <div>
                <label>Aspect Ratio</label>
                <div className="pill-group">
                  {Object.keys(AR_DIM).map((a) => (
                    <div key={a} className={'pill' + (ar === a ? ' active' : '')} onClick={() => setAr(a)}>{a}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <button className="btn btn-green" onClick={renderFinal} disabled={!!busy}
            style={{ width: '100%', justifyContent: 'center', padding: 14, fontSize: 15 }}>
            {busy === 'render' ? '⏳ Rendering MP4...' : '🎬 Render Final MP4'}
          </button>
        </div>
      </div>
    </div>
  )
}
