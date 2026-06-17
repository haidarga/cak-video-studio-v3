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
  const [useRefs, setUseRefs] = useState(true)
  const [clips, setClips] = useState([])
  const clipsRef = useRef(clips)
  clipsRef.current = clips

  // immutable update — never mutate clip objects in place (mutation breaks React re-render + lets stale state leak into gen)
  const patch = (id, p) => setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)))

  const addClip = () => setClips((c) => [...c, {
    id: 'cc_' + ++clipSeq, num: c.length + 1, isFirst: c.length === 0,
    startFile: null, startUrl: '', prompt: '', dur: 8,
    status: 'idle', videoUrl: null, lastFrameUrl: null, log: [],
  }])

  async function runClip(clip) {
    let logs = ['running...']
    const log = (m) => { logs = [...logs, m]; patch(clip.id, { log: logs }) }
    patch(clip.id, { status: 'running', log: logs })
    try {
      // resolve position by id, NOT by clip.num — display number diverges from array index after any reorder/delete
      const idx = clipsRef.current.findIndex((x) => x.id === clip.id)
      let startImageUrl
      if (idx <= 0) {
        if (clip.startFile) startImageUrl = await falUpload(clip.startFile)
        else if (clip.startUrl.trim()) startImageUrl = clip.startUrl.trim()
        else throw new Error('Upload start image buat clip 1')
      } else {
        const prev = clipsRef.current[idx - 1]
        if (!prev?.lastFrameUrl && !prev?.videoUrl) throw new Error('Generate clip ' + idx + ' dulu')
        startImageUrl = prev.lastFrameUrl || prev.startUrl || prev.videoUrl
        log('⛓ Pakai last frame clip ' + idx)
      }
      // identity lock: carry character/product reference images on EVERY clip so face & product don't drift/morph across the chain
      let refUrls = []
      if (useRefs && S.refImages.length) {
        await S.ensureRefsUploaded()
        refUrls = S.refImages.map((r) => r.falUrl).filter(Boolean)
        if (refUrls.length) log(`🔒 ${refUrls.length} reference dikunci ke clip ini`)
        else log('⚠️ Reference belum ke-upload — identity bisa drift')
      }
      const continuity = idx > 0 ? ' Continue seamlessly from the previous clip. Keep the exact same character identity, face, wardrobe, product appearance, environment and lighting.' : ''
      const prompt = (clip.prompt || 'Natural motion, cinematic') + continuity
      const isRef2v = vidModel.includes('reference-to-video')
      const input = isRef2v
        // ref2v: start frame + character refs all go in as reference elements
        ? buildVidInput(vidModel, { prompt, reference_urls: [startImageUrl, ...refUrls].filter(Boolean), duration: clip.dur, aspect_ratio: ar })
        // i2v: last frame as start image + character refs as identity anchors (Kling → reference_image_urls)
        : buildVidInput(vidModel, { prompt, image_url: startImageUrl, reference_urls: refUrls, duration: clip.dur, aspect_ratio: ar })
      log('🎬 Generating...')
      const result = await withRetry(() => falRun(vidModel, input, log), 2, 3000)
      const videoUrl = result.video?.url || result.video
      if (!videoUrl) throw new Error('no video returned')
      let lastFrameUrl
      log('📸 Extracting last frame...')
      try { lastFrameUrl = await extractLastFrameFromVideo(videoUrl); log('✅ Last frame ready → next clip') }
      catch { lastFrameUrl = startImageUrl; log('⚠️ Frame extract failed, pakai start image') }
      patch(clip.id, { status: 'done', videoUrl, lastFrameUrl })
      S.addResult({ url: videoUrl, type: 'video', label: `Chain Clip ${idx + 1}`, ar })
      S.toast(`Clip ${idx + 1} done ✓`)
    } catch (e) {
      patch(clip.id, { status: 'error', log: [...logs, '❌ ' + e.message] })
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
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={useRefs} onChange={(e) => setUseRefs(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
                  <span>🔒 Kunci identitas pakai reference {S.refImages.length ? `(${S.refImages.length} ref)` : '(belum ada ref)'}</span>
                </label>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  Reference karakter/produk dikirim ke tiap clip biar wajah & produk gak drift/morph antar shot. Upload ref-nya di tab Ref Manager.
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
