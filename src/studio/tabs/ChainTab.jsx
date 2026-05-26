import { useState, useRef } from 'react'
import { useStudio } from '../store'
import { falRun, falUpload, buildVidInput, downloadFile, withRetry } from '../lib/api'
import { extractLastFrameFromVideo } from '../lib/video'
import { VIDEO_MODELS } from '../lib/constants'

let clipSeq = 0

export default function ChainTab() {
  const S = useStudio()
  const [vidModel, setVidModel] = useState(S.defaultVidModel)
  const [ar, setAr] = useState('9:16')
  const [clips, setClips] = useState([])
  const clipsRef = useRef(clips)
  clipsRef.current = clips

  const refresh = () => setClips((c) => [...c])
  const patch = (id, p) => { const c = clipsRef.current.find((x) => x.id === id); if (c) Object.assign(c, p); refresh() }

  const addClip = () => setClips((c) => [...c, {
    id: 'cc_' + ++clipSeq, num: c.length + 1, isFirst: c.length === 0,
    startFile: null, startUrl: '', prompt: '', dur: 8,
    status: 'idle', videoUrl: null, lastFrameUrl: null, log: [],
  }])

  async function runClip(clip) {
    patch(clip.id, { status: 'running', log: ['running...'] })
    const pushLog = (m) => { clip.log = [...clip.log, m]; refresh() }
    try {
      let startImageUrl
      if (clip.isFirst) {
        if (clip.startFile) startImageUrl = await falUpload(clip.startFile)
        else if (clip.startUrl.trim()) startImageUrl = clip.startUrl.trim()
        else throw new Error('Upload start image buat clip 1')
      } else {
        const prev = clipsRef.current[clip.num - 2]
        if (!prev?.lastFrameUrl && !prev?.videoUrl) throw new Error('Generate clip ' + (clip.num - 1) + ' dulu')
        startImageUrl = prev.lastFrameUrl || prev.startUrl
        pushLog('⛓ Pakai last frame clip ' + (clip.num - 1))
      }
      const continuity = clip.num > 1 ? ' Continue seamlessly from previous clip. Maintain exact character, environment, lighting.' : ''
      const isRef2v = vidModel.includes('reference-to-video')
      const input = buildVidInput(vidModel, { prompt: (clip.prompt || 'Natural motion, cinematic') + continuity, ...(isRef2v ? { reference_urls: [startImageUrl] } : { image_url: startImageUrl }), duration: clip.dur, aspect_ratio: ar })
      pushLog('🎬 Generating...')
      const result = await withRetry(() => falRun(vidModel, input, pushLog), 2, 3000)
      const videoUrl = result.video?.url || result.video
      clip.videoUrl = videoUrl
      pushLog('📸 Extracting last frame...')
      try { clip.lastFrameUrl = await extractLastFrameFromVideo(videoUrl); pushLog('✅ Last frame ready → next clip') }
      catch { clip.lastFrameUrl = startImageUrl; pushLog('⚠️ Frame extract failed, pakai start image') }
      patch(clip.id, { status: 'done' })
      S.addResult({ url: videoUrl, type: 'video', label: `Chain Clip ${clip.num}`, ar })
      S.toast(`Clip ${clip.num} done ✓`)
    } catch (e) {
      patch(clip.id, { status: 'error', log: [...clip.log, '❌ ' + e.message] })
      S.toast('Failed: ' + e.message, 'error')
    }
  }

  return (
    <div className="pane active">
      <div className="grid2">
        {/* LEFT */}
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="section-title">Chain Generator</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label>Video Model</label>
                <select value={vidModel} onChange={(e) => setVidModel(e.target.value)}>
                  {VIDEO_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
              </div>
              <div>
                <label>Aspect Ratio</label>
                <div className="pill-group">
                  {['9:16', '16:9', '1:1'].map((a) => <div key={a} className={'pill' + (ar === a ? ' active' : '')} onClick={() => setAr(a)}>{a}</div>)}
                </div>
              </div>
            </div>
          </div>

          {clips.map((clip) => (
            <div key={clip.id}>
              {!clip.isFirst && <div className="chain-line">Last frame → Next clip start</div>}
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                  <div className="shot-num">{clip.num}</div>
                  <div style={{ flex: 1, fontWeight: 600 }}>Clip {clip.num}</div>
                  <span className={'status-dot ' + (clip.status === 'done' ? 'done' : clip.status === 'running' ? 'running' : clip.status === 'error' ? 'error' : 'pending')} />
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{clip.status}</span>
                </div>
                {clip.isFirst ? (
                  <div style={{ marginBottom: 12 }}>
                    <label>Start Image</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input type="text" placeholder="Image URL atau upload..." value={clip.startUrl}
                        onChange={(e) => patch(clip.id, { startUrl: e.target.value })} style={{ flex: 1 }} />
                      <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                        Upload
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) patch(clip.id, { startFile: f, startUrl: URL.createObjectURL(f) }) }} />
                      </label>
                    </div>
                    {clip.startUrl && <img src={clip.startUrl} alt="" style={{ height: 80, borderRadius: 6, border: '1px solid var(--border)', marginTop: 8 }} />}
                  </div>
                ) : (
                  <div style={{ marginBottom: 12, padding: 10, background: 'var(--surface2)', borderRadius: 6, fontSize: 12, color: 'var(--muted)' }}>
                    ⛓ Pakai last frame dari clip {clip.num - 1} otomatis
                  </div>
                )}
                <div style={{ marginBottom: 12 }}>
                  <label>Video Motion Prompt</label>
                  <textarea rows={2} value={clip.prompt} onChange={(e) => patch(clip.id, { prompt: e.target.value })} placeholder="Describe what happens..." />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label>Duration</label>
                  <input type="number" min={3} max={15} value={clip.dur} onChange={(e) => patch(clip.id, { dur: +e.target.value })} style={{ textAlign: 'center' }} />
                </div>
                <button className="btn" onClick={() => runClip(clip)} disabled={clip.status === 'running'} style={{ width: '100%', justifyContent: 'center' }}>
                  {clip.status === 'running' ? '⏳ Generating...' : `🎬 Generate Clip ${clip.num}`}
                </button>
                {clip.videoUrl && (
                  <div style={{ marginTop: 12 }}>
                    <video src={clip.videoUrl} controls style={{ width: '100%', borderRadius: 8, background: '#000' }} />
                    <button className="btn btn-green btn-sm" onClick={() => downloadFile(clip.videoUrl, `clip_${clip.num}.mp4`)} style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}>⬇️ Download</button>
                  </div>
                )}
                {!!clip.log.length && <div className="log-box" style={{ marginTop: 8 }}>{clip.log.map((l, i) => <div key={i} className="log-line">{l}</div>)}</div>}
              </div>
            </div>
          ))}

          <button className="btn" onClick={addClip} style={{ width: '100%', justifyContent: 'center', padding: 13 }}>➕ Add Next Clip</button>
        </div>

        {/* RIGHT: guide */}
        <div className="card hero-card" style={{ alignSelf: 'flex-start' }}>
          <div className="section-title">Gimana Continuity Jalan</div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, fontSize: 12, color: 'var(--muted)', lineHeight: 2 }}>
            <div>🎬 <strong style={{ color: 'var(--text)' }}>Clip 1</strong> — start image lo</div>
            <div style={{ color: 'var(--accent)', paddingLeft: 6 }}>↓ ambil frame terakhir</div>
            <div>🎬 <strong style={{ color: 'var(--text)' }}>Clip 2</strong> — mulai dari frame itu</div>
            <div style={{ color: 'var(--accent)', paddingLeft: 6 }}>↓ dst, nyambung terus</div>
          </div>
          <div style={{ padding: '11px 13px', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.25)', borderRadius: 10, fontSize: 11.5, color: '#fcd34d', lineHeight: 1.55 }}>
            💡 Cut di momen yang relatif tenang biar transisinya makin halus.
          </div>
        </div>
      </div>
    </div>
  )
}
