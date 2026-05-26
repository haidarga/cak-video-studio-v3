import { useState, useRef, useMemo } from 'react'
import { useStudio } from '../store'
import { falRun, falUpload, buildVidInput, downloadFile, withRetry } from '../lib/api'
import { VIDEO_MODELS, MOTION_PRESETS, videoRatePerSec } from '../lib/constants'

const AR_OPTS = ['9:16', '16:9', '1:1', '4:5', '3:4']
const RES_OPTS = ['720p', '1080p']
const LANGS = ['Indonesian', 'English', 'Javanese', 'Sundanese', 'Malay', 'Spanish', 'Arabic', 'Mandarin', 'Hindi', 'Portuguese']
let seq = 0

export default function QuickTab() {
  const S = useStudio()
  const fileInput = useRef(null)

  const [clips, setClips] = useState([]) // {id,file,preview,prompt,status,videoUrl,msg}
  const [selectedId, setSelectedId] = useState(null) // clip lagi diedit
  const [urlInput, setUrlInput] = useState('')
  const [motionCat, setMotionCat] = useState('Camera')
  const [vidModel, setVidModel] = useState(S.defaultVidModel)
  const [ar, setAr] = useState(AR_OPTS.includes(S.defaultAR) ? S.defaultAR : '9:16')
  const [dur, setDur] = useState(5)
  const [res, setRes] = useState('720p')
  const [drag, setDrag] = useState(false)
  const [generating, setGenerating] = useState(false)

  const patchClip = (id, patch) => setClips((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const addImage = (file) => {
    if (!file) return
    const id = 'c' + ++seq
    setClips((p) => [...p, { id, file, preview: URL.createObjectURL(file), prompt: '', duration: dur, status: 'idle', videoUrl: null, msg: '' }])
    setSelectedId(id)
  }
  const addUrl = () => {
    const u = urlInput.trim()
    if (!u) return
    const id = 'c' + ++seq
    setClips((p) => [...p, { id, file: null, preview: u, prompt: '', duration: dur, status: 'idle', videoUrl: null, msg: '' }])
    setSelectedId(id)
    setUrlInput('')
  }
  const removeClip = (id) => {
    setClips((p) => p.filter((c) => c.id !== id))
    setSelectedId((sel) => (sel === id ? (clips.filter((c) => c.id !== id)[0]?.id || null) : sel))
  }

  const selIndex = clips.findIndex((c) => c.id === selectedId)
  const selectedClip = selIndex >= 0 ? clips[selIndex] : null

  const addPreset = (cat, i) => {
    const pr = MOTION_PRESETS[cat]?.[i]
    if (!pr) return
    if (!selectedClip) { S.toast('Pilih clip dulu', 'error'); return }
    setClips((p) => p.map((c) => (c.id === selectedId
      ? { ...c, prompt: c.prompt.trim() ? c.prompt.trim() + ', ' + pr.prompt : pr.prompt }
      : c)))
    S.toast('+ ' + pr.name + ' → Clip ' + (selIndex + 1))
  }
  const applyToAll = () => {
    if (!selectedClip) return
    const txt = selectedClip.prompt
    setClips((p) => p.map((c) => ({ ...c, prompt: txt })))
    S.toast('Prompt dipakai ke semua clip ✓')
  }

  const cost = useMemo(() => {
    const rate = videoRatePerSec(vidModel, res)
    const totalSec = clips.reduce((a, c) => a + (c.duration ?? dur), 0) || dur
    const n = Math.max(1, clips.length)
    return { rate, total: (rate * totalSec).toFixed(2), n, totalSec: totalSec.toFixed(1) }
  }, [vidModel, res, dur, clips])

  async function generateOne(clip) {
    patchClip(clip.id, { status: 'running', msg: 'uploading...' })
    try {
      const imageUrl = clip.file ? await falUpload(clip.file) : clip.preview
      const base = clip.prompt.trim() || 'Bring the scene to life with natural motion.'
      const lang = S.config.lang || 'Indonesian'
      const prompt = lang === 'English'
        ? base
        : `${base}. IMPORTANT: any spoken dialogue is spoken in fluent, native ${lang} — the character does NOT speak English.`
      patchClip(clip.id, { msg: 'generating...' })
      const isRef2v = vidModel.includes('reference-to-video')
      const clipDur = clip.duration ?? dur
      const input = buildVidInput(vidModel, { prompt, ...(isRef2v ? { reference_urls: [imageUrl] } : { image_url: imageUrl }), duration: clipDur, aspect_ratio: ar, resolution: res })
      const result = await withRetry(() => falRun(vidModel, input), 2, 3000)
      const videoUrl = result.video?.url || result.video
      if (!videoUrl) throw new Error('no video returned')
      patchClip(clip.id, { status: 'done', videoUrl, msg: 'done ✓' })
      S.addResult({ url: videoUrl, type: 'video', label: 'Quick clip', ar })
    } catch (e) {
      patchClip(clip.id, { status: 'error', msg: e.message })
      S.toast('Clip gagal: ' + e.message, 'error')
    }
  }

  async function generateAll() {
    if (!clips.length) { S.toast('Upload gambar dulu', 'error'); return }
    const pending = clips.filter((c) => c.status !== 'done')
    if (!pending.length) { S.toast('Semua clip udah jadi', 'error'); return }
    setGenerating(true)
    S.toast(`Generate ${pending.length} clip barengan...`)
    await Promise.all(pending.map((c) => generateOne(c)))
    setGenerating(false)
    S.toast('Semua clip selesai ✓')
  }

  const doneClips = clips.filter((c) => c.status === 'done' && c.videoUrl)

  return (
    <div className="pane active">
      <div className="grid2">
        {/* LEFT — config */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-title">Input Images <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— bisa banyak (multi-clip)</span></div>
            <div
              className={'upload-zone' + (drag ? ' drag' : '')}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false);[...e.dataTransfer.files].forEach(addImage) }}
            >
              <div className="icon">🖼️</div>
              <div style={{ fontWeight: 600, marginTop: 8 }}>Drop gambar (bisa banyak) atau klik upload</div>
              <p>Tiap gambar = 1 clip</p>
            </div>
            <input ref={fileInput} type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={(e) => { [...e.target.files].forEach(addImage); e.target.value = '' }} />
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <input type="url" placeholder="Or paste image URL..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={addUrl}>+ Add</button>
            </div>
          </div>

          <div className="card">
            <div className="section-title">Video Motion Prompt <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— per clip, sendiri-sendiri</span></div>

            {!clips.length ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>
                Upload gambar dulu di atas — tiap clip nanti punya prompt sendiri.
              </div>
            ) : (
              <>
                {/* clip selector strip */}
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.5px', textTransform: 'uppercase', marginBottom: 6 }}>
                  Pilih clip yang mau diedit
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {clips.map((c, i) => (
                    <div key={c.id} onClick={() => setSelectedId(c.id)} title={'Clip ' + (i + 1)}
                      style={{
                        position: 'relative', cursor: 'pointer', borderRadius: 7, flexShrink: 0,
                        outline: c.id === selectedId ? '2px solid var(--accent)' : '2px solid transparent',
                        opacity: c.id === selectedId ? 1 : 0.5, transition: 'opacity .12s',
                      }}>
                      <img src={c.preview} alt="" style={{ width: 44, height: 58, objectFit: 'cover', borderRadius: 7, display: 'block' }} />
                      <span style={{ position: 'absolute', top: 2, left: 2, fontSize: 9, fontWeight: 800, background: 'rgba(0,0,0,.75)', color: '#fff', borderRadius: 4, padding: '1px 5px' }}>{i + 1}</span>
                      {c.prompt.trim() && <span style={{ position: 'absolute', bottom: 1, right: 2, fontSize: 10 }} title="udah ada prompt">✏️</span>}
                    </div>
                  ))}
                </div>

                {selectedClip && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                      Lagi ngedit <strong style={{ color: 'var(--accent)' }}>Clip {selIndex + 1}</strong> — ketik manual atau klik preset, masuknya ke clip ini.
                    </div>
                    <textarea rows={4} value={selectedClip.prompt}
                      onChange={(e) => patchClip(selectedId, { prompt: e.target.value })}
                      placeholder={'Describe the motion buat Clip ' + (selIndex + 1) + '... klik preset di bawah biar cepet'} />

                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.5px', textTransform: 'uppercase' }}>🎬 Preset</div>
                      <div style={{ flex: 1, height: 1, background: 'var(--border)', minWidth: 10 }} />
                      {clips.length > 1 && (
                        <button className="btn btn-ghost btn-sm" onClick={applyToAll} style={{ padding: '3px 9px' }} title="Copy prompt Clip ini ke semua clip">⎘ Pakai ke semua</button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => patchClip(selectedId, { prompt: '' })} style={{ padding: '3px 9px' }}>Clear</button>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted2)', marginTop: 6, lineHeight: 1.5 }}>
                      💡 Preset gak ngereplace — dia <strong>numpuk</strong> ke prompt clip yang lagi dipilih. Tiap clip beda prompt? gampang, tinggal klik clip laen di atas.
                    </div>
                    <div className="pill-group" style={{ marginTop: 8 }}>
                      {Object.keys(MOTION_PRESETS).map((cat) => (
                        <div key={cat} className={'pill' + (motionCat === cat ? ' active' : '')} onClick={() => setMotionCat(cat)}>
                          {cat === 'Camera' ? '🎥' : cat === 'Subject' ? '🧍' : '🎨'} {cat}
                        </div>
                      ))}
                    </div>
                    <div className="preset-grid">
                      {MOTION_PRESETS[motionCat].map((p, i) => (
                        <div key={p.name} className="preset-card" title={p.prompt} onClick={() => addPreset(motionCat, i)}>
                          <span className="pico">{p.icon}</span>
                          <span className="pname">{p.name}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="card">
            <div className="section-title">Settings</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label>Video Model</label>
                <select value={vidModel} onChange={(e) => setVidModel(e.target.value)}>
                  {VIDEO_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
              </div>
              <div>
                <label>🗣️ Bahasa Dialog <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— bahasa suara karakter</span></label>
                <select value={S.config.lang || 'Indonesian'} onChange={(e) => S.setConfig({ lang: e.target.value })}>
                  {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label>Aspect Ratio</label>
                <div className="pill-group">
                  {AR_OPTS.map((a) => <div key={a} className={'pill' + (ar === a ? ' active' : '')} onClick={() => setAr(a)}>{a}</div>)}
                </div>
              </div>
              <div>
                <label>Default Duration: {dur}s <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— buat clip baru, bisa di-override per clip</span></label>
                <input type="range" min={3} max={15} value={dur} onChange={(e) => setDur(+e.target.value)} />
              </div>
              <div>
                <label>Resolution</label>
                <div className="pill-group">
                  {RES_OPTS.map((r) => <div key={r} className={'pill' + (res === r ? ' active' : '')} onClick={() => setRes(r)}>{r}</div>)}
                </div>
              </div>
            </div>
          </div>

          <button className="btn" onClick={generateAll} disabled={generating}
            style={{ width: '100%', padding: 14, fontSize: 15 }}>
            {generating ? '⏳ Generating...' : `🎬 Generate ${clips.length || ''} Clip${clips.length !== 1 ? 's' : ''}`}
          </button>
        </div>

        {/* RIGHT — clips */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-title">Clips <span className="badge badge-blue">{clips.length}</span>
              {clips.length > 0 && <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>— klik clip buat edit promptnya</span>}
            </div>
            {!clips.length ? (
              <div className="empty-state" style={{ minHeight: 240 }}>
                <div className="es-icon">🎞️</div>
                <h3>Belum ada clip</h3>
                <p>Upload satu atau banyak gambar di kiri. Tiap gambar jadi 1 clip — masing-masing punya prompt sendiri.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {clips.map((c, i) => (
                  <div key={c.id} onClick={() => setSelectedId(c.id)}
                    style={{
                      display: 'flex', gap: 10, padding: 10, background: 'var(--surface2)', borderRadius: 10, cursor: 'pointer',
                      border: '1px solid ' + (c.id === selectedId ? 'var(--accent)' : 'var(--border)'),
                      boxShadow: c.id === selectedId ? '0 0 0 3px rgba(255,60,60,.12)' : 'none',
                    }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      {c.videoUrl
                        ? <video src={c.videoUrl} muted loop playsInline onMouseOver={(e) => e.target.play()} onMouseOut={(e) => e.target.pause()} style={{ width: 76, height: 100, objectFit: 'cover', borderRadius: 6 }} />
                        : <img src={c.preview} alt="" style={{ width: 76, height: 100, objectFit: 'cover', borderRadius: 6 }} />}
                      <span style={{ position: 'absolute', top: 3, left: 3, fontSize: 10, fontWeight: 800, background: 'rgba(0,0,0,.78)', color: '#fff', borderRadius: 5, padding: '1px 6px' }}>{i + 1}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className={'status-dot ' + (c.status === 'done' ? 'done' : c.status === 'running' ? 'running' : c.status === 'error' ? 'error' : 'pending')} />
                        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>{c.msg || c.status}</span>
                        <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }} onClick={(e) => { e.stopPropagation(); removeClip(c.id) }}>✕</button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                        <span style={{ color: 'var(--muted)' }}>⏱</span>
                        <input type="number" min={3} max={15} value={c.duration ?? dur}
                          onChange={(e) => patchClip(c.id, { duration: Math.max(3, Math.min(15, +e.target.value || 5)) })}
                          onClick={(e) => e.stopPropagation()}
                          title="Durasi clip ini"
                          style={{ width: 54, fontSize: 11, padding: '3px 5px', textAlign: 'center' }} />
                        <span style={{ color: 'var(--muted)' }}>detik</span>
                      </div>
                      <div style={{ fontSize: 11, lineHeight: 1.45, color: c.prompt.trim() ? 'var(--text)' : 'var(--muted2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {c.prompt.trim() || 'Belum ada prompt — klik clip ini, terus ketik / pilih preset di kiri.'}
                      </div>
                      {c.videoUrl && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost btn-sm" style={{ flex: 1, padding: '4px 8px' }} onClick={(e) => { e.stopPropagation(); downloadFile(c.videoUrl, 'clip.mp4') }}>⬇️</button>
                          <button className="btn btn-ghost btn-sm" style={{ flex: 1, padding: '4px 8px' }} onClick={(e) => { e.stopPropagation(); S.sendToPostPro(c.videoUrl) }}>🎞️ Post-Pro</button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {doneClips.length >= 2 && (
            <button className="btn btn-green" onClick={() => S.sendToCombine(doneClips.map((c) => c.videoUrl))}
              style={{ width: '100%', justifyContent: 'center', padding: 13 }}>
              🎬 Combine {doneClips.length} clip jadi 1 video
            </button>
          )}

          <div className="card" style={{ background: '#0d0d0d' }}>
            <div className="section-title">Cost Estimate</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--text)' }}>~${cost.total}</strong> — {cost.n} clip · total {cost.totalSec}s × ${cost.rate}/s
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
