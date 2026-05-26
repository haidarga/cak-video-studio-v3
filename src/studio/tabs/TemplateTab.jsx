import { useState, useRef } from 'react'
import { useStudio } from '../store'
import { extractKeyframes } from '../lib/video'
import { analyzeFramesWithGemini } from '../lib/prompt'
import { extractJSON } from '../lib/api'
import TemplateSummary from '../components/TemplateSummary'

export default function TemplateTab() {
  const S = useStudio()
  const fileRef = useRef(null)
  const [urlInput, setUrlInput] = useState('')
  const [videoUrl, setVideoUrl] = useState(null)
  const [frames, setFrames] = useState([])
  const [status, setStatus] = useState('')
  const [statusOk, setStatusOk] = useState(null)
  const [busy, setBusy] = useState(false)
  const [analysisText, setAnalysisText] = useState('')
  const [saveName, setSaveName] = useState('')

  const setS = (msg, ok) => { setStatus(msg); setStatusOk(ok) }

  async function doFrames(url) {
    setVideoUrl(url); setFrames([]); setAnalysisText(''); setS('📸 Extracting keyframes...', null)
    try {
      const fr = await extractKeyframes(url, 7)
      setFrames(fr)
      setS(`✅ ${fr.length} keyframes extracted — ready to analyze`, true)
    } catch (e) {
      setS(`❌ Frame extract failed: ${e.message}. Coba download video-nya & upload file langsung.`, false)
    }
  }
  const onFile = (f) => { if (f) doFrames(URL.createObjectURL(f)) }
  const loadUrl = () => { if (urlInput.trim()) doFrames(urlInput.trim()) }

  async function analyze() {
    if (!frames.length) { S.toast('Extract frames dulu', 'error'); return }
    if (!S.geminiKey) { S.toast('Set Gemini key dulu', 'error'); return }
    setBusy(true); setS('🤖 Analyzing with Gemini Vision...', null)
    try {
      const raw = await analyzeFramesWithGemini(frames, S.geminiKey)
      const analysis = extractJSON(raw)
      setAnalysisText(JSON.stringify(analysis, null, 2))
      setSaveName(String(analysis.aesthetic || '').split(/[,.]/)[0].slice(0, 40).trim() || 'Template baru')
      setS('✅ Style ke-analisa — kasih nama & Save to Library', true)
      S.toast('Template analyzed ✓')
    } catch (e) {
      setS('❌ Analysis failed: ' + e.message, false)
      S.toast('Failed: ' + e.message, 'error')
    }
    setBusy(false)
  }

  function save() {
    let analysis
    try { analysis = JSON.parse(analysisText) } catch { S.toast('JSON gak valid', 'error'); return }
    S.saveTemplate(saveName.trim() || 'Template ' + (S.templates.length + 1), analysis)
    setSaveName('')
  }

  const active = S.getActiveTemplate()

  return (
    <div className="pane active">
      <div className="grid2">
        {/* LEFT: create */}
        <div className="card">
          <div className="section-title">📺 Buat Template Baru</div>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14, lineHeight: 1.55 }}>
            Upload video referensi → AI pelajarin layout, estetik, hook pattern, caption style. Simpan ke library, pakai ulang kapan aja.
            <br /><strong style={{ color: 'var(--amber)' }}>Note:</strong> URL TikTok/IG biasanya gak bisa di-fetch — download dulu, upload file-nya.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input type="url" placeholder="Paste direct video URL..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
            <button className="btn btn-ghost btn-sm" onClick={loadUrl}>Load URL</button>
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>📁 Upload</button>
            <input ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          {videoUrl && <video src={videoUrl} controls muted playsInline style={{ width: '100%', maxHeight: 240, borderRadius: 8, background: '#000', border: '1px solid var(--border)', marginBottom: 10 }} />}
          {!!frames.length && (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10 }}>
              {frames.map((f, i) => (
                <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                  <img src={f.dataUrl} alt="" style={{ height: 64, borderRadius: 4, border: '1px solid var(--border)', display: 'block' }} />
                  <span style={{ position: 'absolute', bottom: 2, right: 2, background: 'rgba(0,0,0,.7)', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 3 }}>{f.time.toFixed(1)}s</span>
                </div>
              ))}
            </div>
          )}
          {status && <div style={{ fontSize: 12, marginBottom: 10, padding: '9px 11px', background: 'var(--surface2)', borderRadius: 8, color: statusOk === true ? '#86efac' : statusOk === false ? '#fca5a5' : 'var(--muted)' }}>{status}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={analyze} disabled={busy || !frames.length}>🤖 Analyze Style</button>
          </div>
          {analysisText && (
            <div style={{ marginTop: 14 }}>
              <label>Style Template (editable JSON)</label>
              <textarea rows={13} value={analysisText} onChange={(e) => setAnalysisText(e.target.value)}
                style={{ fontFamily: "'SF Mono',Consolas,monospace", fontSize: 11, lineHeight: 1.5 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" placeholder="Nama template..." value={saveName} onChange={(e) => setSaveName(e.target.value)} style={{ flex: 1 }} />
                <button className="btn btn-green btn-sm" onClick={save}>💾 Save to Library</button>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: library */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-title">🎯 Active Template</div>
            {active ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#86efac' }}>🎯 {active.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{(active.analysis?.aesthetic || '').slice(0, 120)}</div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={S.clearActiveTemplate}>Matiin</button>
                </div>
                <div style={{ padding: 11, background: 'var(--surface2)', borderRadius: 9, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px' }}>
                    Yang bakal ditiru pas lu Parse di Pipeline
                  </div>
                  <TemplateSummary analysis={active.analysis} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.55 }}>
                  💡 Template ngasih <strong>style &amp; rhythm</strong>. Naskah + karakter (refs) tetep dari LO — di Pipeline tinggal tulis naskah, Gemini yang nyatuin.
                </div>
                <button className="btn btn-green" onClick={() => S.setActiveTab('pipeline')} style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
                  ✍️ Lanjut ke Pipeline — tulis naskah lo
                </button>
              </div>
            ) : <div style={{ color: 'var(--muted)', fontSize: 12 }}>Belum ada template aktif. Pilih dari library — naskah lo bakal niru style-nya pas di-Parse di tab Pipeline.</div>}
          </div>
          <div className="card">
            <div className="section-title">📚 Template Library <span className="badge badge-blue">{S.templates.length}</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {S.templates.length ? S.templates.map((t) => {
                const on = t.id === S.activeTemplateId
                return (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, background: 'var(--surface)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name} {on && <span className="badge badge-green" style={{ marginLeft: 4 }}>active</span>}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.analysis?.aesthetic || '—'}</div>
                    </div>
                    {!on && <button className="btn btn-sm" onClick={() => S.useTemplateById(t.id)}>Use</button>}
                    <button className="btn btn-ghost btn-sm" style={{ padding: '6px 9px' }} onClick={() => { const n = prompt('Nama baru:', t.name); if (n?.trim()) S.renameTemplate(t.id, n.trim()) }}>✏️</button>
                    <button className="btn btn-ghost btn-sm" style={{ padding: '6px 9px', color: '#fca5a5' }} onClick={() => { if (confirm(`Hapus "${t.name}"?`)) S.deleteTemplate(t.id) }}>✕</button>
                  </div>
                )
              }) : <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>Library kosong. Buat template baru di panel kiri.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
