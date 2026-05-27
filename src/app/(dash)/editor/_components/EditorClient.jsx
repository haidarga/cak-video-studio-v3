'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { renderProject } from '@/lib/editor-render'

// Editor v2 (gacor): trim + speed + volume per source, text overlay,
// image overlay (logo/sticker), music underlay, ffmpeg.wasm MP4 export
// dengan canvas/WebM fallback.

const DEFAULT_PROJECT = {
  name: 'Untitled project',
  ar: '9:16',
  source: { result_id: null, url: null, trim_start: 0, trim_end: null, speed: 1, volume: 1 },
  text_clips: [],   // { id, kind:'text', text, start, end, x_pct, y_pct, size, color, weight, bg, align }
  image_clips: [],  // { id, kind:'image', src_url, src_name, start, end, x_pct, y_pct, w_pct, opacity }
  audio_clips: [],  // { id, kind:'audio', src_url, src_name, start, duration, volume }
}

function uid() { return Math.random().toString(36).slice(2, 10) }

// Backward-compat: old projects had flat source_url. Normalize on load.
function normalizeProject(raw) {
  if (!raw) return DEFAULT_PROJECT
  if (raw.source) return { ...DEFAULT_PROJECT, ...raw, source: { ...DEFAULT_PROJECT.source, ...raw.source } }
  // Old v1 shape
  return {
    ...DEFAULT_PROJECT,
    name: raw.name || 'Untitled',
    ar: raw.ar || '9:16',
    source: {
      result_id: raw.source_result_id || null,
      url: raw.source_url || null,
      trim_start: raw.trim_start || 0,
      trim_end: raw.trim_end || null,
      speed: 1, volume: 1,
    },
    text_clips: raw.text_clips || [],
    image_clips: [],
    audio_clips: [],
  }
}

export default function EditorClient({ workspaceId, userId, results, projects }) {
  const supabase = createClient()
  const [project, setProject] = useState(DEFAULT_PROJECT)
  const [projectId, setProjectId] = useState(null)
  const [selected, setSelected] = useState(null) // { kind: 'source'|'text'|'image'|'audio', id }
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const videoRef = useRef(null)
  const imageInputRef = useRef(null)
  const audioInputRef = useRef(null)

  const videoSources = useMemo(() => results.filter((r) => r.type === 'video' && r.url), [results])

  function patch(p) { setProject((cur) => ({ ...cur, ...(typeof p === 'function' ? p(cur) : p) })) }
  function patchSource(p) { setProject((cur) => ({ ...cur, source: { ...cur.source, ...p } })) }

  function pickSource(result) {
    setProject({
      ...DEFAULT_PROJECT,
      name: result.label ? `${result.label} (edit)` : 'Untitled project',
      ar: result.ar || '9:16',
      source: { result_id: result.id, url: result.url, trim_start: 0, trim_end: null, speed: 1, volume: 1 },
    })
    setSelected({ kind: 'source' })
    setCurrentTime(0); setDuration(0)
  }

  function addTextClip() {
    const c = {
      id: uid(), kind: 'text', text: 'Tap to edit',
      start: Math.max(0, currentTime), end: Math.min(duration || 5, (currentTime || 0) + 2),
      x_pct: 50, y_pct: 80, size: 48, color: '#ffffff', weight: 700,
      bg: 'rgba(0,0,0,0.6)', align: 'center',
    }
    patch((p) => ({ ...p, text_clips: [...p.text_clips, c] }))
    setSelected({ kind: 'text', id: c.id })
  }

  async function onImageFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''
    if (!f.type.startsWith('image/')) { setErr('File harus image (PNG/JPG/WebP)'); return }
    try {
      const path = `${workspaceId}/editor-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${f.name.split('.').pop()}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const c = {
        id: uid(), kind: 'image', src_url: publicUrl, src_name: f.name,
        start: currentTime, end: Math.min(duration || 5, currentTime + 3),
        x_pct: 90, y_pct: 10, w_pct: 15, opacity: 1,
      }
      patch((p) => ({ ...p, image_clips: [...p.image_clips, c] }))
      setSelected({ kind: 'image', id: c.id })
    } catch (e) { setErr('Upload image: ' + e.message) }
  }

  async function onAudioFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''
    if (!f.type.startsWith('audio/')) { setErr('File harus audio (MP3/WAV/M4A)'); return }
    try {
      const path = `${workspaceId}/editor-audio-${Date.now()}.${f.name.split('.').pop()}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      // Replace existing music (single-slot for v2)
      const c = {
        id: uid(), kind: 'audio', src_url: publicUrl, src_name: f.name,
        start: 0, duration: duration || 15, volume: 0.3,
      }
      patch({ audio_clips: [c] })
      setSelected({ kind: 'audio', id: c.id })
    } catch (e) { setErr('Upload audio: ' + e.message) }
  }

  function updateClip(kind, id, p) {
    setProject((proj) => ({
      ...proj,
      [`${kind}_clips`]: proj[`${kind}_clips`].map((c) =>
        c.id === id ? { ...c, ...(typeof p === 'function' ? p(c) : p) } : c
      ),
    }))
  }
  function deleteClip(kind, id) {
    setProject((proj) => ({
      ...proj,
      [`${kind}_clips`]: proj[`${kind}_clips`].filter((c) => c.id !== id),
    }))
    if (selected?.id === id) setSelected(null)
  }

  async function saveProject() {
    if (!project.source.result_id) { setErr('Pilih source video dulu'); return }
    setSaving(true); setErr('')
    try {
      if (projectId) {
        const { error } = await supabase.from('editor_projects')
          .update({ name: project.name, source_result_id: project.source.result_id, config: project, updated_at: new Date().toISOString() })
          .eq('id', projectId)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('editor_projects')
          .insert({ workspace_id: workspaceId, name: project.name, source_result_id: project.source.result_id, config: project, created_by: userId })
          .select('id').single()
        if (error) throw error
        setProjectId(data.id)
      }
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  async function loadProject(id) {
    setErr('')
    const { data, error } = await supabase.from('editor_projects').select('*').eq('id', id).single()
    if (error) { setErr(error.message); return }
    setProject(normalizeProject(data.config))
    setProjectId(data.id)
    setSelected(null)
  }

  function newProject() {
    setProject(DEFAULT_PROJECT); setProjectId(null); setSelected(null)
  }

  const trimEnd = project.source.trim_end ?? duration
  const exportDur = Math.max(0, (trimEnd - project.source.trim_start) / project.source.speed)

  async function exportVideo() {
    if (!project.source.url) { setErr('Belum ada source video'); return }
    setExporting(true); setExportProgress('Persiapan...'); setErr('')
    try {
      const projectForRender = {
        ...project,
        source: { ...project.source, trim_end: trimEnd },
      }
      const { blob, ext, mime } = await renderProject(projectForRender, setExportProgress)

      setExportProgress(`Uploading ${(blob.size / 1024 / 1024).toFixed(1)}MB hasil...`)
      const path = `${workspaceId}/editor-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, blob, {
        upsert: false, contentType: mime, cacheControl: '3600',
      })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const { error: insErr } = await supabase.from('results').insert({
        workspace_id: workspaceId, type: 'video', url: publicUrl,
        label: project.name + ' (edited)', ar: project.ar,
        group_label: 'editor', qc_status: 'pending',
        meta: {
          source: 'editor', editor_project_id: projectId,
          text_clips: project.text_clips.length,
          image_clips: project.image_clips.length,
          audio_clips: project.audio_clips.length,
          format: ext,
          duration: exportDur,
        },
        created_by: userId,
      })
      if (insErr) throw insErr
      setExportProgress(`✓ Done! ${ext.toUpperCase()} ${(blob.size / 1024 / 1024).toFixed(1)}MB — cek di /qc`)
    } catch (e) {
      setErr('Export gagal: ' + e.message)
      setExportProgress('')
    }
    setExporting(false)
  }

  // Playback
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    function onLoaded() {
      setDuration(v.duration || 0)
      if (project.source.trim_end == null) patchSource({ trim_end: v.duration })
    }
    function onTime() {
      setCurrentTime(v.currentTime)
      if (v.currentTime >= trimEnd && playing) { v.currentTime = project.source.trim_start }
    }
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('timeupdate', onTime)
    return () => { v.removeEventListener('loadedmetadata', onLoaded); v.removeEventListener('timeupdate', onTime) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.source.url, project.source.trim_start, project.source.trim_end, playing])

  useEffect(() => {
    const v = videoRef.current; if (!v) return
    v.playbackRate = project.source.speed
    v.volume = project.source.volume
  }, [project.source.speed, project.source.volume])

  function togglePlay() {
    const v = videoRef.current; if (!v) return
    if (v.paused) {
      if (v.currentTime < project.source.trim_start || v.currentTime >= trimEnd) v.currentTime = project.source.trim_start
      v.play(); setPlaying(true)
    } else { v.pause(); setPlaying(false) }
  }
  function seekTo(t) {
    const v = videoRef.current; if (!v) return
    v.currentTime = Math.max(0, Math.min(duration, t)); setCurrentTime(v.currentTime)
  }

  const aspectClass = project.ar === '16:9' ? 'aspect-video' : project.ar === '1:1' ? 'aspect-square' : 'aspect-[9/16]'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">✂️ Editor <span className="text-xs text-[var(--muted2)] font-normal">v2 gacor</span></h1>
          <p className="text-xs text-[var(--muted)]">Trim · Speed · Volume · Text · Image overlay · Music underlay · MP4 export via ffmpeg.wasm</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={project.name} onChange={(e) => patch({ name: e.target.value })}
            placeholder="Project name"
            className="text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] w-56" />
          <button onClick={newProject} className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)]">+ New</button>
          <button onClick={saveProject} disabled={saving || !project.source.result_id} className="px-3 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
            {saving ? '⏳ Save...' : '💾 Save'}
          </button>
          <button onClick={exportVideo} disabled={exporting || !project.source.url}
            className="px-4 py-1.5 text-xs font-bold rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
            {exporting ? `⏳ Rendering...` : '⬇ Export → QC'}
          </button>
        </div>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}
      {exporting && exportProgress && (
        <div className="text-xs text-orange-400 bg-orange-900/20 border border-orange-700/40 p-3 rounded whitespace-pre-wrap">⏳ {exportProgress}</div>
      )}
      {!exporting && exportProgress.startsWith('✓') && (
        <div className="text-xs text-green-400 bg-green-900/20 border border-green-700/40 p-3 rounded">{exportProgress}</div>
      )}

      <div className="grid grid-cols-[220px_1fr_300px] gap-3" style={{ minHeight: 600 }}>
        {/* LEFT SIDEBAR */}
        <div className="space-y-3">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">Source video ({videoSources.length})</div>
            <div className="space-y-1 max-h-64 overflow-auto">
              {videoSources.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)] p-2">Belum ada video. Generate di /generate dulu.</div>
              ) : videoSources.map((r) => {
                const on = project.source.result_id === r.id
                return (
                  <button key={r.id} onClick={() => pickSource(r)} className={`w-full text-left p-1.5 rounded border ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-[var(--surface2)]'}`}>
                    <div className="flex gap-2">
                      <video src={r.url} muted className="w-10 aspect-[9/16] object-cover rounded bg-black flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold truncate">{r.label || 'untitled'}</div>
                        <div className="text-[9px] text-[var(--muted)] truncate">{r.personas?.name || '—'}</div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Add overlays */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-1">+ Add overlay</div>
            <button onClick={addTextClip} disabled={!project.source.url} className="w-full text-xs px-2 py-1.5 rounded bg-purple-500/20 border border-purple-500/40 hover:bg-purple-500/30 text-purple-200 disabled:opacity-50">
              📝 Text overlay
            </button>
            <button onClick={() => imageInputRef.current?.click()} disabled={!project.source.url} className="w-full text-xs px-2 py-1.5 rounded bg-blue-500/20 border border-blue-500/40 hover:bg-blue-500/30 text-blue-200 disabled:opacity-50">
              🖼 Image / Logo
            </button>
            <button onClick={() => audioInputRef.current?.click()} disabled={!project.source.url} className="w-full text-xs px-2 py-1.5 rounded bg-orange-500/20 border border-orange-500/40 hover:bg-orange-500/30 text-orange-200 disabled:opacity-50">
              🎵 Music underlay
            </button>
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={onImageFile} />
            <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={onAudioFile} />
          </div>

          {projects.length > 0 && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
              <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">Recent projects</div>
              <div className="space-y-1 max-h-40 overflow-auto">
                {projects.map((pr) => (
                  <button key={pr.id} onClick={() => loadProject(pr.id)} className="w-full text-left text-[11px] px-2 py-1 rounded hover:bg-[var(--surface2)]">
                    <div className="font-semibold truncate">{pr.name}</div>
                    <div className="text-[9px] text-[var(--muted)]">{new Date(pr.updated_at).toLocaleString()}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* CENTER: Preview + multi-track timeline */}
        <div className="space-y-3 min-w-0">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3">
            <div className="relative mx-auto bg-black rounded overflow-hidden" style={{ maxWidth: 360 }}>
              <div className={`${aspectClass} relative w-full`}>
                {project.source.url ? (
                  <video ref={videoRef} src={project.source.url} className="w-full h-full object-contain" playsInline crossOrigin="anonymous" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-[var(--muted)] text-center p-4">
                    Pilih source video dari panel kiri
                  </div>
                )}

                {/* Image overlays */}
                {project.source.url && project.image_clips.map((c) => {
                  if (currentTime < c.start || currentTime > c.end) return null
                  const on = selected?.kind === 'image' && selected.id === c.id
                  return (
                    <img key={c.id} src={c.src_url} alt=""
                      onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'image', id: c.id }) }}
                      style={{
                        position: 'absolute', left: `${c.x_pct}%`, top: `${c.y_pct}%`,
                        transform: 'translate(-50%, -50%)', width: `${c.w_pct}%`, opacity: c.opacity,
                        outline: on ? '2px solid var(--accent)' : 'none', cursor: 'pointer', pointerEvents: 'auto',
                      }} />
                  )
                })}

                {/* Text overlays */}
                {project.source.url && project.text_clips.map((c) => {
                  if (currentTime < c.start || currentTime > c.end) return null
                  const on = selected?.kind === 'text' && selected.id === c.id
                  return (
                    <div key={c.id} onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'text', id: c.id }) }}
                      style={{
                        position: 'absolute', left: `${c.x_pct}%`, top: `${c.y_pct}%`,
                        transform: 'translate(-50%, -50%)',
                        color: c.color, fontWeight: c.weight, fontSize: `${c.size * 0.4}px`,
                        background: c.bg, padding: '4px 10px', borderRadius: 4, textAlign: c.align, whiteSpace: 'pre', cursor: 'pointer',
                        textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                        outline: on ? '2px solid var(--accent)' : 'none',
                      }}>{c.text}</div>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 mt-3">
              <button onClick={togglePlay} disabled={!project.source.url} className="px-3 py-1.5 rounded bg-[var(--accent)] text-white text-xs font-bold disabled:opacity-50">
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button onClick={() => seekTo(project.source.trim_start)} disabled={!project.source.url} className="px-2 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)]">⏮</button>
              <div className="text-[10px] text-[var(--muted)] font-mono flex-1 text-center">
                {currentTime.toFixed(2)}s / {duration.toFixed(2)}s · export {exportDur.toFixed(2)}s @ {project.source.speed}x
              </div>
              <button onClick={() => setSelected({ kind: 'source' })} className="text-[10px] underline text-[var(--muted)] hover:text-white">edit source</button>
            </div>

            {duration > 0 && (
              <input type="range" min={0} max={duration} step={0.01} value={currentTime}
                onChange={(e) => seekTo(parseFloat(e.target.value))} className="w-full mt-2" />
            )}
          </div>

          {/* Multi-track timeline */}
          {project.source.url && (
            <Timeline project={project} duration={duration} currentTime={currentTime} trimEnd={trimEnd}
              onSeek={seekTo} onSelectSource={() => setSelected({ kind: 'source' })}
              onTrimStart={(t) => patchSource({ trim_start: Math.max(0, Math.min(t, trimEnd - 0.5)) })}
              onTrimEnd={(t) => patchSource({ trim_end: Math.max(project.source.trim_start + 0.5, Math.min(t, duration)) })}
              selected={selected} onSelect={setSelected}
              onUpdateClip={updateClip} />
          )}
        </div>

        {/* RIGHT: Properties */}
        <div className="space-y-3">
          {selected?.kind === 'source' ? (
            <SourcePanel source={project.source} duration={duration}
              onUpdate={patchSource} ar={project.ar} onUpdateAr={(ar) => patch({ ar })} />
          ) : selected?.kind === 'text' ? (
            <TextPanel clip={project.text_clips.find((c) => c.id === selected.id)} duration={duration}
              onUpdate={(p) => updateClip('text', selected.id, p)}
              onDelete={() => deleteClip('text', selected.id)} />
          ) : selected?.kind === 'image' ? (
            <ImagePanel clip={project.image_clips.find((c) => c.id === selected.id)} duration={duration}
              onUpdate={(p) => updateClip('image', selected.id, p)}
              onDelete={() => deleteClip('image', selected.id)} />
          ) : selected?.kind === 'audio' ? (
            <AudioPanel clip={project.audio_clips.find((c) => c.id === selected.id)} duration={duration}
              onUpdate={(p) => updateClip('audio', selected.id, p)}
              onDelete={() => deleteClip('audio', selected.id)} />
          ) : (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs text-[var(--muted)]">
              <div className="text-[10px] uppercase font-semibold mb-2">Properties</div>
              Pilih track atau clip di timeline buat edit. Atau klik <em>"edit source"</em> di transport.
            </div>
          )}

          {project.source.url && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs">
              <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">Project</div>
              <div>Trim: <strong>{project.source.trim_start.toFixed(2)}s → {trimEnd.toFixed(2)}s</strong></div>
              <div>Speed: <strong>{project.source.speed}x</strong> · Volume: <strong>{Math.round(project.source.volume * 100)}%</strong></div>
              <div>Export: <strong>{exportDur.toFixed(2)}s @ {project.ar}</strong></div>
              <div className="text-[10px] text-[var(--muted2)] mt-2">
                {project.text_clips.length} text · {project.image_clips.length} image · {project.audio_clips.length} music
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Timeline({ project, duration, currentTime, trimEnd, onSeek, onSelectSource, onTrimStart, onTrimEnd, selected, onSelect, onUpdateClip }) {
  const trackRef = useRef(null)
  const dragRef = useRef(null)
  const pctToTime = (pct) => (pct / 100) * duration
  const timeToPct = (t) => duration > 0 ? (t / duration) * 100 : 0

  function startDrag(e, kind, clipKind, clipId) {
    e.stopPropagation()
    const rect = trackRef.current.getBoundingClientRect()
    const startClip = clipKind && clipId ? { ...project[`${clipKind}_clips`].find((c) => c.id === clipId) } : null
    const origin = { x: e.clientX, rect, kind, clipKind, clipId, startClip }
    dragRef.current = origin

    function onMove(ev) {
      const x = ev.clientX - rect.left
      const pct = Math.max(0, Math.min(100, (x / rect.width) * 100))
      const t = pctToTime(pct)
      if (kind === 'trimStart') onTrimStart(t)
      else if (kind === 'trimEnd') onTrimEnd(t)
      else if (kind === 'clipMove') {
        const c = startClip
        const len = c.end - c.start
        const dx = (ev.clientX - origin.x) / rect.width * duration
        const ns = Math.max(0, Math.min(duration - len, c.start + dx))
        onUpdateClip(clipKind, clipId, { start: ns, end: ns + len })
      } else if (kind === 'clipStart') {
        const c = startClip
        onUpdateClip(clipKind, clipId, { start: Math.max(0, Math.min(c.end - 0.1, t)) })
      } else if (kind === 'clipEnd') {
        const c = startClip
        onUpdateClip(clipKind, clipId, { end: Math.max(c.start + 0.1, Math.min(duration, t)) })
      }
    }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); dragRef.current = null }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }

  function onTrackClick(e) {
    if (dragRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    onSeek(pctToTime((x / rect.width) * 100))
  }

  const Tracks = [
    { kind: 'video', label: '📹 video', color: 'bg-[var(--accent)]/30', items: [{ id: 'src', start: project.source.trim_start, end: trimEnd, label: 'source', isSource: true }] },
    { kind: 'image', label: '🖼 image', color: 'bg-blue-900/30', items: project.image_clips },
    { kind: 'text', label: '📝 text', color: 'bg-purple-900/30', items: project.text_clips },
    { kind: 'audio', label: '🎵 audio', color: 'bg-orange-900/30', items: project.audio_clips.map((c) => ({ ...c, end: c.start + c.duration })) },
  ]

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 select-none">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">Timeline</div>
        <div className="text-[9px] text-[var(--muted2)]">Drag pill = move · drag edge = resize · click track = seek</div>
      </div>

      <div ref={trackRef} className="relative cursor-pointer" onClick={onTrackClick}>
        {Tracks.map((trk) => (
          <div key={trk.kind} className="flex items-center gap-2 mb-1.5">
            <div className="w-12 text-[9px] text-[var(--muted)] font-semibold flex-shrink-0">{trk.label}</div>
            <div className={`relative flex-1 h-7 ${trk.color} rounded`}>
              {trk.items.map((c) => {
                const isSel = !c.isSource && selected?.kind === trk.kind && selected.id === c.id
                const start = c.start || 0
                const end = c.end || start + 1
                const isSrc = c.isSource
                return (
                  <div key={c.id}
                    onMouseDown={(e) => { if (isSrc) return; startDrag(e, 'clipMove', trk.kind, c.id); onSelect({ kind: trk.kind, id: c.id }) }}
                    onClick={(e) => { e.stopPropagation(); if (isSrc) onSelectSource(); else onSelect({ kind: trk.kind, id: c.id }) }}
                    className={`absolute top-0.5 bottom-0.5 rounded text-[9px] text-white font-semibold flex items-center px-1.5 ${isSrc ? 'cursor-pointer' : 'cursor-grab'} ${isSel ? 'ring-2 ring-white' : ''} ${trk.kind === 'video' ? 'bg-[var(--accent)]' : trk.kind === 'image' ? 'bg-blue-600' : trk.kind === 'text' ? 'bg-purple-600' : 'bg-orange-600'}`}
                    style={{ left: `${timeToPct(start)}%`, width: `${Math.max(2, timeToPct(end - start))}%` }}
                    title={c.label || c.text || c.src_name || ''}>
                    {isSrc && <>
                      <div onMouseDown={(e) => startDrag(e, 'trimStart')} className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/40 cursor-ew-resize rounded-l" />
                      <div onMouseDown={(e) => startDrag(e, 'trimEnd')} className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/40 cursor-ew-resize rounded-r" />
                    </>}
                    {!isSrc && <>
                      <div onMouseDown={(e) => startDrag(e, 'clipStart', trk.kind, c.id)} className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-l" />
                      <div onMouseDown={(e) => startDrag(e, 'clipEnd', trk.kind, c.id)} className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-r" />
                    </>}
                    <span className="truncate px-1">
                      {isSrc ? '📹 src' : c.text ? `📝 ${c.text.slice(0, 18)}` : c.src_name ? (trk.kind === 'image' ? `🖼 ${c.src_name.slice(0, 14)}` : `🎵 ${c.src_name.slice(0, 14)}`) : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {/* Playhead spans all tracks */}
        <div className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none" style={{ left: `calc(48px + (100% - 48px) * ${timeToPct(currentTime) / 100})` }}>
          <div className="absolute -top-1 -left-1 w-2 h-2 bg-red-500 rounded-full" />
        </div>
      </div>

      <div className="relative h-3 mt-1 ml-12">
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
          <span key={i} className="absolute text-[9px] text-[var(--muted)] font-mono" style={{ left: `${p * 100}%`, transform: 'translateX(-50%)' }}>
            {(p * duration).toFixed(1)}s
          </span>
        ))}
      </div>
    </div>
  )
}

function SourcePanel({ source, duration, onUpdate, ar, onUpdateAr }) {
  const trimEnd = source.trim_end ?? duration
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">📹 Source video</div>
      <Field label="Aspect ratio">
        <select value={ar} onChange={(e) => onUpdateAr(e.target.value)} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
          <option value="9:16">9:16 vertical</option>
          <option value="16:9">16:9 horizontal</option>
          <option value="1:1">1:1 square</option>
        </select>
      </Field>
      <Field label={`Trim start: ${source.trim_start.toFixed(2)}s`}>
        <input type="range" min={0} max={duration} step={0.05} value={source.trim_start}
          onChange={(e) => onUpdate({ trim_start: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Trim end: ${trimEnd.toFixed(2)}s`}>
        <input type="range" min={0} max={duration} step={0.05} value={trimEnd}
          onChange={(e) => onUpdate({ trim_end: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Speed: ${source.speed}x`}>
        <input type="range" min={0.25} max={3} step={0.05} value={source.speed}
          onChange={(e) => onUpdate({ speed: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Volume: ${Math.round(source.volume * 100)}%`}>
        <input type="range" min={0} max={1.5} step={0.05} value={source.volume}
          onChange={(e) => onUpdate({ volume: parseFloat(e.target.value) })} className="w-full" />
      </Field>
    </div>
  )
}

function TextPanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">📝 Text clip</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <Field label="Text">
        <textarea value={clip.text} onChange={(e) => onUpdate({ text: e.target.value })} rows={2}
          className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`Start: ${clip.start.toFixed(2)}s`}>
          <input type="range" min={0} max={duration} step={0.05} value={clip.start} onChange={(e) => onUpdate({ start: parseFloat(e.target.value) })} className="w-full" />
        </Field>
        <Field label={`End: ${clip.end.toFixed(2)}s`}>
          <input type="range" min={0} max={duration} step={0.05} value={clip.end} onChange={(e) => onUpdate({ end: parseFloat(e.target.value) })} className="w-full" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`X: ${clip.x_pct}%`}>
          <input type="range" min={0} max={100} value={clip.x_pct} onChange={(e) => onUpdate({ x_pct: parseInt(e.target.value) })} className="w-full" />
        </Field>
        <Field label={`Y: ${clip.y_pct}%`}>
          <input type="range" min={0} max={100} value={clip.y_pct} onChange={(e) => onUpdate({ y_pct: parseInt(e.target.value) })} className="w-full" />
        </Field>
      </div>
      <Field label={`Size: ${clip.size}px`}>
        <input type="range" min={16} max={120} value={clip.size} onChange={(e) => onUpdate({ size: parseInt(e.target.value) })} className="w-full" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Color">
          <input type="color" value={clip.color} onChange={(e) => onUpdate({ color: e.target.value })} className="w-full h-8 rounded bg-[var(--surface2)] border border-[var(--border)] cursor-pointer" />
        </Field>
        <Field label="BG">
          <select value={clip.bg} onChange={(e) => onUpdate({ bg: e.target.value })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value="transparent">Transparent</option>
            <option value="rgba(0,0,0,0.6)">Black 60%</option>
            <option value="rgba(0,0,0,0.85)">Black 85%</option>
            <option value="rgba(255,255,255,0.85)">White 85%</option>
            <option value="rgba(255,87,87,0.85)">Red 85%</option>
            <option value="rgba(255,193,7,0.85)">Yellow 85%</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Weight">
          <select value={clip.weight} onChange={(e) => onUpdate({ weight: parseInt(e.target.value) })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value={400}>Regular</option><option value={600}>Semibold</option>
            <option value={700}>Bold</option><option value={900}>Black</option>
          </select>
        </Field>
        <Field label="Align">
          <select value={clip.align} onChange={(e) => onUpdate({ align: e.target.value })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </Field>
      </div>
    </div>
  )
}

function ImagePanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">🖼 Image overlay</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <img src={clip.src_url} alt="" className="w-full max-h-24 object-contain bg-black/30 rounded" />
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_name}</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`Start: ${clip.start.toFixed(2)}s`}>
          <input type="range" min={0} max={duration} step={0.05} value={clip.start} onChange={(e) => onUpdate({ start: parseFloat(e.target.value) })} className="w-full" />
        </Field>
        <Field label={`End: ${clip.end.toFixed(2)}s`}>
          <input type="range" min={0} max={duration} step={0.05} value={clip.end} onChange={(e) => onUpdate({ end: parseFloat(e.target.value) })} className="w-full" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`X: ${clip.x_pct}%`}>
          <input type="range" min={0} max={100} value={clip.x_pct} onChange={(e) => onUpdate({ x_pct: parseInt(e.target.value) })} className="w-full" />
        </Field>
        <Field label={`Y: ${clip.y_pct}%`}>
          <input type="range" min={0} max={100} value={clip.y_pct} onChange={(e) => onUpdate({ y_pct: parseInt(e.target.value) })} className="w-full" />
        </Field>
      </div>
      <Field label={`Width: ${clip.w_pct}% of frame`}>
        <input type="range" min={5} max={100} value={clip.w_pct} onChange={(e) => onUpdate({ w_pct: parseInt(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Opacity: ${Math.round(clip.opacity * 100)}%`}>
        <input type="range" min={0} max={1} step={0.05} value={clip.opacity} onChange={(e) => onUpdate({ opacity: parseFloat(e.target.value) })} className="w-full" />
      </Field>
    </div>
  )
}

function AudioPanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">🎵 Music underlay</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <audio src={clip.src_url} controls className="w-full" />
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_name}</div>
      <Field label={`Mulai di: ${clip.start.toFixed(2)}s`}>
        <input type="range" min={0} max={duration} step={0.1} value={clip.start} onChange={(e) => onUpdate({ start: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Volume: ${Math.round(clip.volume * 100)}%`}>
        <input type="range" min={0} max={1.5} step={0.05} value={clip.volume} onChange={(e) => onUpdate({ volume: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <div className="text-[9px] text-[var(--muted2)]">
        Tip: music underlay biasanya 20-40% buat di belakang dialog.
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <div className="text-[9px] uppercase text-[var(--muted)] font-semibold mb-1">{label}</div>
      {children}
    </div>
  )
}
