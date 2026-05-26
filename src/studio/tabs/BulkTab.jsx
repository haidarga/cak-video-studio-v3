import { useState, useRef } from 'react'
import { useStudio } from '../store'
import { callGemini, extractJSON, withRetry } from '../lib/api'
import { buildParsePrompt, autoMapRefs, buildStoryboardGridPrompt } from '../lib/prompt'
import { headlessGenImage, headlessGenVideo } from '../lib/gen'
import { STYLE_OPTIONS, VIDEO_MODELS, IMAGE_MODELS } from '../lib/constants'
import RefManager from '../components/RefManager'
import StyleRefPicker from '../components/StyleRefPicker'

let jobSeq = 0

export default function BulkTab() {
  const S = useStudio()
  const { config, setConfig } = S
  const [jobs, setJobs] = useState(() => [{ id: 'job_' + ++jobSeq, name: 'Job 1', naskah: '', refIds: [], status: 'pending', stage: '', shots: [], done: 0, total: 0, error: '' }])
  const [concurrency, setConcurrency] = useState(2)
  const [running, setRunning] = useState(false)
  const [global, setGlobal] = useState({ done: 0, total: 0 })
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const stopRef = useRef(false)

  const refresh = () => setJobs((j) => [...j])
  const addJob = () => setJobs((j) => [...j, { id: 'job_' + ++jobSeq, name: 'Job ' + (j.length + 1), naskah: '', refIds: [], status: 'pending', stage: '', shots: [], done: 0, total: 0, error: '' }])
  const removeJob = (id) => { if (running) return; setJobs((j) => j.filter((x) => x.id !== id)) }
  const clearDone = () => { if (running) return; setJobs((j) => j.filter((x) => x.status !== 'done')) }
  const patchJob = (id, patch) => { const j = jobsRef.current.find((x) => x.id === id); if (j) Object.assign(j, patch); refresh() }
  const toggleJobRef = (jobId, refId) => {
    const j = jobsRef.current.find((x) => x.id === jobId)
    if (!j) return
    const ids = j.refIds || []
    patchJob(jobId, { refIds: ids.includes(refId) ? ids.filter((x) => x !== refId) : [...ids, refId] })
  }

  async function runJob(job, cfg) {
    Object.assign(job, { status: 'running', error: '', stage: 'parsing', done: 0, total: 0, shots: [] }); refresh()
    try {
      if (!job.naskah.trim()) throw new Error('Naskah kosong')
      // scope refs to this job — empty refIds means "use all available"
      const refsForJob = job.refIds?.length ? S.refImages.filter((r) => job.refIds.includes(r.id)) : S.refImages
      const prompt = buildParsePrompt(job.naskah.trim(), cfg, {
        refLabels: refsForJob.map((r) => r.label).filter(Boolean),
        activeTemplate: S.getActiveTemplate(), activeBrand: S.getActiveBrand(),
      })
      const parsed = extractJSON(await callGemini(prompt, { json: true, maxTokens: 24576 }))
      const isStoryParse = cfg.genMode === 'storyboard'
      job.shots = (parsed.shots || []).map((s, i) => {
        const panels = Array.isArray(s.panels) ? s.panels : []
        const image_prompt = isStoryParse && panels.length
          ? buildStoryboardGridPrompt(panels, cfg.ar, parsed.concept)
          : String(s.image_prompt || '').trim()
        return {
          ...s, id: job.id + '_s' + i, panels, image_prompt, imageUrl: null, videoUrl: null,
          duration: Math.max(2, Math.min(20, +s.duration || (isStoryParse ? 15 : 5))),
          chars_in_shot: Array.isArray(s.chars_in_shot) ? s.chars_in_shot : [],
          refIds: autoMapRefs(s.chars_in_shot || [], refsForJob),
        }
      })
      if (!job.shots.length) throw new Error('Gemini gak balikin shot')

      if (stopRef.current) { Object.assign(job, { status: 'stopped', stage: 'stopped' }); refresh(); return }
      const isRef2v = cfg.vidModel.includes('reference-to-video')
      const isKlingV3 = cfg.vidModel.includes('kling-video/') && !cfg.vidModel.includes('reference-to-video')
      const klingCanSkipImage = isKlingV3 && refsForJob.length > 0
      if (!isRef2v) {
        Object.assign(job, { stage: 'images', done: 0, total: job.shots.length }); refresh()
        for (const shot of job.shots) {
          if (stopRef.current) { Object.assign(job, { status: 'stopped', stage: 'stopped' }); refresh(); return }
          try { await withRetry(() => headlessGenImage(shot, cfg, refsForJob)) } catch {}
          job.done++; refresh()
        }
        if (stopRef.current) { Object.assign(job, { status: 'stopped', stage: 'stopped' }); refresh(); return }
      }
      // Video stage: ref2v doesn't need image; Kling can fall back to refs if image gen failed
      Object.assign(job, { stage: 'videos', done: 0, total: (isRef2v || klingCanSkipImage) ? job.shots.length : job.shots.filter((s) => s.imageUrl).length }); refresh()
      for (const shot of job.shots) {
        if (stopRef.current) { Object.assign(job, { status: 'stopped', stage: 'stopped' }); refresh(); return }
        if (!isRef2v && !shot.imageUrl && !klingCanSkipImage) continue
        try {
          await withRetry(() => headlessGenVideo(shot, cfg, refsForJob))
          S.addResult({ url: shot.videoUrl, type: 'video', label: `${job.name} · Shot ${shot.shot}`, ar: cfg.ar })
        } catch {}
        job.done++; refresh()
      }
      const ok = job.shots.filter((s) => s.videoUrl).length
      if (!ok) throw new Error('Semua video gagal generate')
      Object.assign(job, { status: 'done', stage: `✅ ${ok}/${job.shots.length} video` }); refresh()
    } catch (e) {
      Object.assign(job, { status: 'error', error: e.message, stage: 'error' }); refresh()
    }
  }

  async function runAll() {
    if (running) return
    if (!S.falKey || !S.geminiKey) { S.toast('Set API keys dulu di ⚙️ Settings', 'error'); return }
    const queue = jobsRef.current.filter((j) => j.naskah.trim() && j.status !== 'done')
    if (!queue.length) { S.toast('Gak ada job buat dijalanin', 'error'); return }
    setRunning(true); stopRef.current = false
    setGlobal({ done: 0, total: queue.length })
    await S.ensureRefsUploaded()
    const cfg = { ...config, concurrency, brandNotes: S.getActiveBrand()?.notes || '' }
    let idx = 0, completed = 0
    const worker = async () => {
      while (idx < queue.length && !stopRef.current) {
        await runJob(queue[idx++], cfg)
        completed++; setGlobal({ done: completed, total: queue.length })
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    setRunning(false)
    S.toast(stopRef.current ? 'Bulk dihentikan' : 'Semua job selesai ✓')
  }

  const at = S.getActiveTemplate()
  const badgeClass = { pending: 'badge-gray', running: 'badge-amber', done: 'badge-green', error: 'badge-red', stopped: 'badge-gray' }

  return (
    <div className="pane active">
      <div className="grid2">
        {/* LEFT: config */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-title">Batch Config <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— berlaku ke semua job</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label>Generation Mode</label>
                <div className="pill-group">
                  {[['shots', '🎬 Per-Shot'], ['storyboard', '🗂️ Storyboard 3×3']].map(([v, l]) => (
                    <div key={v} className={'pill' + (config.genMode === v ? ' active' : '')} onClick={() => setConfig({ genMode: v })}>{l}</div>
                  ))}
                </div>
                {config.genMode === 'storyboard' && (
                  <div style={{ fontSize: 10.5, color: 'var(--muted2)', marginTop: 6, lineHeight: 1.45 }}>
                    🗂️ Tiap job: naskah dipecah jadi grid 3×3 per ~15dtk → grid jadi start frame video → 1 video per grid.
                  </div>
                )}
              </div>
              {config.genMode !== 'storyboard' && (
                <div>
                  <label>Mode</label>
                  <div className="pill-group">
                    {[['cut_to_cut', 'Cut to Cut'], ['single_take', 'Single Take (15s)']].map(([v, l]) => (
                      <div key={v} className={'pill' + (config.mode === v ? ' active' : '')} onClick={() => setConfig({ mode: v })}>{l}</div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label>Style</label>
                <select value={config.style} onChange={(e) => setConfig({ style: e.target.value })}>
                  {STYLE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
              <StyleRefPicker />
              <div>
                <label>Aspect Ratio</label>
                <div className="pill-group">
                  {['9:16', '16:9', '1:1'].map((a) => <div key={a} className={'pill' + (config.ar === a ? ' active' : '')} onClick={() => setConfig({ ar: a })}>{a}</div>)}
                </div>
              </div>
              <div>
                <label>Image Generator</label>
                <select value={config.imgModel} onChange={(e) => setConfig({ imgModel: e.target.value })}>
                  {IMAGE_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
              </div>
              <div>
                <label>Video Generator</label>
                <select value={config.vidModel} onChange={(e) => setConfig({ vidModel: e.target.value })}>
                  {VIDEO_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
              </div>
              <div>
                <label>Parallel Jobs</label>
                <div className="pill-group">
                  {[1, 2, 3].map((n) => <div key={n} className={'pill' + (concurrency === n ? ' active' : '')} onClick={() => setConcurrency(n)}>{n}</div>)}
                </div>
              </div>
            </div>
          </div>
          <RefManager />
          <div className="card" style={{ background: '#0d0d0d', padding: '12px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              🎯 Template: <strong style={{ color: at ? '#86efac' : 'var(--muted)' }}>{at ? 'ON — ' + at.name : 'OFF'}</strong>
            </div>
          </div>
        </div>

        {/* RIGHT: jobs */}
        <div>
          <div className="section-title" style={{ marginBottom: 12 }}>
            Jobs <span className="badge badge-blue">{jobs.length}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={addJob}>➕ Add Job</button>
              <button className="btn btn-ghost btn-sm" onClick={clearDone}>🧹 Clear Done</button>
            </div>
          </div>
          {jobs.map((j) => (
            <div key={j.id} className="card" style={{ marginBottom: 10, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <input type="text" value={j.name} onChange={(e) => patchJob(j.id, { name: e.target.value })}
                  style={{ width: 150, fontSize: 12, fontWeight: 600, padding: '5px 8px' }} />
                <span className={'badge ' + (badgeClass[j.status] || 'badge-gray')}>{j.status === 'running' ? j.stage || 'running' : j.status}</span>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost btn-sm" onClick={() => removeJob(j.id)} style={{ padding: '4px 9px' }}>✕</button>
              </div>
              {!!S.refImages.length && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 5, letterSpacing: '.5px' }}>
                    🧩 Aset job ini {!j.refIds?.length && <span style={{ color: 'var(--muted2)', textTransform: 'none', fontWeight: 400, letterSpacing: 0 }}>— kosong = pake semua</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {S.refImages.map((r) => {
                      const on = (j.refIds || []).includes(r.id)
                      return (
                        <div key={r.id} onClick={() => toggleJobRef(j.id, r.id)} title={r.label || 'unnamed'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px 3px 3px',
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--border2)'}`,
                            borderRadius: 20, fontSize: 10.5, cursor: 'pointer',
                            background: on ? '#1a0000' : 'transparent',
                            color: on ? 'var(--accent)' : 'var(--muted)',
                          }}>
                          <img src={r.url} alt="" style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover' }} />
                          <span>{r.label || 'unnamed'}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <textarea rows={3} value={j.naskah} onChange={(e) => patchJob(j.id, { naskah: e.target.value })}
                placeholder="Tempel naskah buat job ini..." style={{ fontSize: 12 }} />
              {(j.status === 'running' || j.status === 'done') && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{j.total ? `${j.stage} — ${j.done}/${j.total}` : j.stage}</div>
                  <div className="progress-bar"><div className="progress-fill" style={{ width: (j.total ? Math.round((j.done / j.total) * 100) : j.status === 'done' ? 100 : 0) + '%' }} /></div>
                </div>
              )}
              {j.error && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 6 }}>❌ {j.error}</div>}
              {!!j.shots.filter((s) => s.videoUrl).length && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {j.shots.filter((s) => s.videoUrl).map((s) => (
                    <video key={s.id} src={s.videoUrl} muted loop playsInline style={{ width: 84, height: 112, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                  ))}
                </div>
              )}
            </div>
          ))}
          <div style={{ marginTop: 14 }}>
            {running
              ? <button className="btn btn-ghost" onClick={() => { stopRef.current = true; S.toast('Stopping...') }} style={{ width: '100%', justifyContent: 'center', padding: 13 }}>⏹ Stop</button>
              : <button className="btn btn-green" onClick={runAll} style={{ width: '100%', justifyContent: 'center', padding: 13 }}>▶️ Generate All Jobs</button>}
          </div>
          {running && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{global.done}/{global.total} job selesai</div>
              <div className="progress-bar"><div className="progress-fill" style={{ width: (global.total ? Math.round((global.done / global.total) * 100) : 0) + '%' }} /></div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
