'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Editor v1 — single source video + multi text overlay + trim + client-side
// export via MediaRecorder. Multi-clip timeline + audio + transitions later.

const DEFAULT_PROJECT = {
  name: 'Untitled project',
  source_result_id: null,
  source_url: null,
  source_type: 'video',
  trim_start: 0,           // seconds
  trim_end: null,          // seconds (null = source duration)
  ar: '9:16',              // canvas aspect
  text_clips: [],          // [{ id, text, start, end, x_pct, y_pct, size, color, weight, bg, align }]
}

function uid() { return Math.random().toString(36).slice(2, 10) }

export default function EditorClient({ workspaceId, userId, results, projects }) {
  const supabase = createClient()
  const [project, setProject] = useState(DEFAULT_PROJECT)
  const [projectId, setProjectId] = useState(null)
  const [selectedClipId, setSelectedClipId] = useState(null)
  const [duration, setDuration] = useState(0)    // source video duration
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const videoRef = useRef(null)

  // Filter selectable sources — only video results
  const videoSources = useMemo(() => results.filter((r) => r.type === 'video' && r.url), [results])

  function patch(p) { setProject((cur) => ({ ...cur, ...(typeof p === 'function' ? p(cur) : p) })) }

  function pickSource(result) {
    patch({
      source_result_id: result.id,
      source_url: result.url,
      source_type: result.type,
      trim_start: 0,
      trim_end: null,
      ar: result.ar || '9:16',
      name: result.label ? `${result.label} (edit)` : 'Untitled project',
    })
    setSelectedClipId(null)
    setCurrentTime(0)
    setDuration(0)
  }

  function addTextClip() {
    const newClip = {
      id: uid(),
      text: 'Tap to edit',
      start: Math.max(0, currentTime),
      end: Math.min(duration || 5, (currentTime || 0) + 2),
      x_pct: 50, y_pct: 80,
      size: 48, color: '#ffffff', weight: 700,
      bg: 'rgba(0,0,0,0.6)', align: 'center',
    }
    patch((p) => ({ ...p, text_clips: [...p.text_clips, newClip] }))
    setSelectedClipId(newClip.id)
  }
  function updateClip(id, patch) {
    setProject((p) => ({
      ...p,
      text_clips: p.text_clips.map((c) => c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c),
    }))
  }
  function deleteClip(id) {
    setProject((p) => ({ ...p, text_clips: p.text_clips.filter((c) => c.id !== id) }))
    if (selectedClipId === id) setSelectedClipId(null)
  }

  async function saveProject() {
    if (!project.source_result_id) { setErr('Pilih source video dulu'); return }
    setSaving(true); setErr('')
    try {
      if (projectId) {
        const { error } = await supabase.from('editor_projects')
          .update({ name: project.name, source_result_id: project.source_result_id, config: project, updated_at: new Date().toISOString() })
          .eq('id', projectId)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('editor_projects')
          .insert({ workspace_id: workspaceId, name: project.name, source_result_id: project.source_result_id, config: project, created_by: userId })
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
    setProject(data.config || DEFAULT_PROJECT)
    setProjectId(data.id)
    setSelectedClipId(null)
  }

  function newProject() {
    setProject(DEFAULT_PROJECT)
    setProjectId(null)
    setSelectedClipId(null)
  }

  const trimEnd = project.trim_end ?? duration
  const exportDur = Math.max(0, trimEnd - project.trim_start)

  async function exportVideo() {
    if (!project.source_url) { setErr('Belum ada source video'); return }
    if (!videoRef.current) return
    setExporting(true); setExportProgress('Persiapan...'); setErr('')
    try {
      const blob = await renderToBlob({
        sourceUrl: project.source_url,
        trimStart: project.trim_start,
        trimEnd: trimEnd,
        ar: project.ar,
        textClips: project.text_clips,
        onProgress: (msg) => setExportProgress(msg),
      })
      setExportProgress('Uploading hasil...')

      // Upload to Supabase Storage
      const path = `${workspaceId}/editor-${Date.now()}.webm`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, blob, {
        upsert: false, contentType: 'video/webm', cacheControl: '3600',
      })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)

      // INSERT results row so the edited video shows up in /qc
      const { error: insErr } = await supabase.from('results').insert({
        workspace_id: workspaceId, type: 'video', url: publicUrl,
        label: project.name + ' (edited)', ar: project.ar,
        group_label: 'editor',
        qc_status: 'pending',
        meta: { source: 'editor', editor_project_id: projectId, text_clips: project.text_clips.length, duration: exportDur },
        created_by: userId,
      })
      if (insErr) throw insErr
      setExportProgress(`✓ Done! Cek di /qc → status pending`)
    } catch (e) {
      setErr('Export gagal: ' + e.message)
      setExportProgress('')
    }
    setExporting(false)
  }

  // Playback control
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    function onLoadedMetadata() {
      setDuration(v.duration || 0)
      if (project.trim_end == null) patch({ trim_end: v.duration })
    }
    function onTimeUpdate() {
      setCurrentTime(v.currentTime)
      // Auto-loop within trim region
      if (v.currentTime >= trimEnd && playing) {
        v.currentTime = project.trim_start
      }
    }
    v.addEventListener('loadedmetadata', onLoadedMetadata)
    v.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata)
      v.removeEventListener('timeupdate', onTimeUpdate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.source_url, project.trim_start, project.trim_end, playing])

  function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (v.currentTime < project.trim_start || v.currentTime >= trimEnd) v.currentTime = project.trim_start
      v.play(); setPlaying(true)
    } else {
      v.pause(); setPlaying(false)
    }
  }

  function seekTo(t) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(duration, t))
    setCurrentTime(v.currentTime)
  }

  const selectedClip = project.text_clips.find((c) => c.id === selectedClipId)
  const aspectClass = project.ar === '16:9' ? 'aspect-video' : project.ar === '1:1' ? 'aspect-square' : 'aspect-[9/16]'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">✂️ Editor</h1>
          <p className="text-xs text-[var(--muted)]">Trim + text overlay + export ke /qc. Multi-track + audio + ffmpeg.wasm coming next.</p>
        </div>
        <div className="flex items-center gap-2">
          <input value={project.name} onChange={(e) => patch({ name: e.target.value })}
            placeholder="Project name"
            className="text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] w-56" />
          <button onClick={newProject} className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)]">+ New</button>
          <button onClick={saveProject} disabled={saving || !project.source_result_id} className="px-3 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
            {saving ? '⏳ Save...' : '💾 Save'}
          </button>
          <button onClick={exportVideo} disabled={exporting || !project.source_url}
            className="px-4 py-1.5 text-xs font-bold rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
            {exporting ? `⏳ ${exportProgress || 'Rendering...'}` : '⬇ Export → QC'}
          </button>
        </div>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}
      {exporting && exportProgress && (
        <div className="text-xs text-orange-400 bg-orange-900/20 border border-orange-700/40 p-3 rounded">⏳ {exportProgress}</div>
      )}

      <div className="grid grid-cols-[220px_1fr_280px] gap-3" style={{ minHeight: 600 }}>
        {/* LEFT: Media library + saved projects */}
        <div className="space-y-3">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">Source video ({videoSources.length})</div>
            <div className="space-y-1 max-h-72 overflow-auto">
              {videoSources.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)] p-2">Belum ada video. Generate di /generate dulu.</div>
              ) : videoSources.map((r) => {
                const on = project.source_result_id === r.id
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

        {/* CENTER: Preview + timeline */}
        <div className="space-y-3">
          {/* Preview */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3">
            <div className="relative mx-auto bg-black rounded overflow-hidden" style={{ maxWidth: 360 }}>
              <div className={`${aspectClass} relative w-full`}>
                {project.source_url ? (
                  <video ref={videoRef} src={project.source_url} className="w-full h-full object-contain" playsInline />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-[var(--muted)] text-center p-4">
                    Pilih source video dari panel kiri
                  </div>
                )}

                {/* Text overlay layer — only show clips that are active at currentTime */}
                {project.source_url && project.text_clips.map((c) => {
                  const isActive = currentTime >= c.start && currentTime <= c.end
                  if (!isActive) return null
                  return (
                    <div key={c.id}
                      onClick={() => setSelectedClipId(c.id)}
                      style={{
                        position: 'absolute', left: `${c.x_pct}%`, top: `${c.y_pct}%`,
                        transform: 'translate(-50%, -50%)',
                        color: c.color, fontWeight: c.weight, fontSize: `${c.size * 0.4}px`,
                        background: c.bg, padding: '4px 10px', borderRadius: 4,
                        textAlign: c.align, whiteSpace: 'pre', cursor: 'pointer',
                        textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                        outline: c.id === selectedClipId ? '2px solid var(--accent)' : 'none',
                      }}>
                      {c.text}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Transport */}
            <div className="flex items-center gap-2 mt-3">
              <button onClick={togglePlay} disabled={!project.source_url} className="px-3 py-1.5 rounded bg-[var(--accent)] text-white text-xs font-bold disabled:opacity-50">
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button onClick={() => seekTo(project.trim_start)} disabled={!project.source_url} className="px-2 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)]">⏮</button>
              <div className="text-[10px] text-[var(--muted)] font-mono flex-1 text-center">
                {currentTime.toFixed(2)}s / {duration.toFixed(2)}s · export {exportDur.toFixed(2)}s
              </div>
              <button onClick={addTextClip} disabled={!project.source_url}
                className="px-3 py-1.5 rounded bg-purple-500 text-white text-xs font-bold disabled:opacity-50">+ 📝 Text</button>
            </div>

            {/* Scrubber */}
            {duration > 0 && (
              <input type="range" min={0} max={duration} step={0.01} value={currentTime}
                onChange={(e) => seekTo(parseFloat(e.target.value))}
                className="w-full mt-2" />
            )}
          </div>

          {/* Timeline */}
          {project.source_url && (
            <Timeline
              duration={duration}
              currentTime={currentTime}
              trimStart={project.trim_start}
              trimEnd={trimEnd}
              onTrimStart={(t) => patch({ trim_start: Math.max(0, Math.min(t, trimEnd - 0.5)) })}
              onTrimEnd={(t) => patch({ trim_end: Math.max(project.trim_start + 0.5, Math.min(t, duration)) })}
              onSeek={seekTo}
              textClips={project.text_clips}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onUpdateClip={updateClip}
            />
          )}
        </div>

        {/* RIGHT: Properties panel */}
        <div className="space-y-3">
          {selectedClip ? (
            <PropertiesPanel clip={selectedClip} duration={duration}
              onUpdate={(p) => updateClip(selectedClip.id, p)}
              onDelete={() => deleteClip(selectedClip.id)} />
          ) : (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs text-[var(--muted)]">
              <div className="text-[10px] uppercase font-semibold mb-2">Properties</div>
              <div>Pilih text clip di timeline buat edit. Atau klik <strong>+ 📝 Text</strong> buat tambah text overlay baru.</div>
            </div>
          )}

          {project.source_url && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs">
              <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">Project info</div>
              <div className="space-y-1">
                <div>Source: <span className="text-[var(--muted)]">{project.source_url.slice(-30)}</span></div>
                <div>Trim: <strong>{project.trim_start.toFixed(2)}s</strong> → <strong>{trimEnd.toFixed(2)}s</strong></div>
                <div>Duration: <strong>{exportDur.toFixed(2)}s</strong></div>
                <div>AR: <strong>{project.ar}</strong></div>
                <div>Text overlays: <strong>{project.text_clips.length}</strong></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Timeline({ duration, currentTime, trimStart, trimEnd, onTrimStart, onTrimEnd, onSeek, textClips, selectedClipId, onSelectClip, onUpdateClip }) {
  const trackRef = useRef(null)
  const dragRef = useRef(null) // { kind: 'trimStart'|'trimEnd'|'clipMove'|'clipStart'|'clipEnd', clipId, origin }

  function pctToTime(pct) { return (pct / 100) * duration }
  function timeToPct(t) { return duration > 0 ? (t / duration) * 100 : 0 }

  function onMouseDown(e, kind, clipId) {
    const rect = trackRef.current.getBoundingClientRect()
    const origin = { x: e.clientX, rect, kind, clipId, startValue: clipId ? { ...textClips.find((c) => c.id === clipId) } : null }
    dragRef.current = origin

    function onMove(ev) {
      const x = ev.clientX - rect.left
      const pct = Math.max(0, Math.min(100, (x / rect.width) * 100))
      const t = pctToTime(pct)
      if (kind === 'trimStart') onTrimStart(t)
      else if (kind === 'trimEnd') onTrimEnd(t)
      else if (kind === 'clipMove') {
        const c = origin.startValue
        const len = c.end - c.start
        const dx = (ev.clientX - origin.x) / rect.width * duration
        const ns = Math.max(0, Math.min(duration - len, c.start + dx))
        onUpdateClip(clipId, { start: ns, end: ns + len })
      } else if (kind === 'clipStart') {
        const c = origin.startValue
        onUpdateClip(clipId, { start: Math.max(0, Math.min(c.end - 0.1, t)) })
      } else if (kind === 'clipEnd') {
        const c = origin.startValue
        onUpdateClip(clipId, { end: Math.max(c.start + 0.1, Math.min(duration, t)) })
      }
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onTrackClick(e) {
    if (dragRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = (x / rect.width) * 100
    onSeek(pctToTime(pct))
  }

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">Timeline</div>
        <div className="text-[9px] text-[var(--muted2)]">Klik buat seek · drag handle ujung trim · drag clip text</div>
      </div>

      {/* Source video track */}
      <div ref={trackRef} onClick={onTrackClick} className="relative h-10 bg-black/40 rounded cursor-pointer select-none" style={{ userSelect: 'none' }}>
        {/* Trim region highlight */}
        <div className="absolute top-0 bottom-0 bg-[var(--accent)]/20 border-l border-r border-[var(--accent)]"
          style={{ left: `${timeToPct(trimStart)}%`, width: `${timeToPct(trimEnd - trimStart)}%` }} />
        {/* Trim start handle */}
        <div onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, 'trimStart') }}
          className="absolute top-0 bottom-0 w-2 bg-[var(--accent)] cursor-ew-resize z-10"
          style={{ left: `calc(${timeToPct(trimStart)}% - 4px)` }} />
        {/* Trim end handle */}
        <div onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, 'trimEnd') }}
          className="absolute top-0 bottom-0 w-2 bg-[var(--accent)] cursor-ew-resize z-10"
          style={{ left: `calc(${timeToPct(trimEnd)}% - 4px)` }} />
        {/* Playhead */}
        <div className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
          style={{ left: `${timeToPct(currentTime)}%` }}>
          <div className="absolute -top-1 -left-1 w-2 h-2 bg-red-500 rounded-full" />
        </div>
        <div className="absolute left-2 top-1 text-[9px] text-white/60 pointer-events-none">📹 source ({duration.toFixed(1)}s)</div>
      </div>

      {/* Text clips track */}
      {textClips.length > 0 && (
        <div className="relative h-8 mt-2 bg-purple-900/20 rounded select-none">
          {textClips.map((c) => {
            const on = selectedClipId === c.id
            return (
              <div key={c.id}
                onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, 'clipMove', c.id); onSelectClip(c.id) }}
                onClick={(e) => { e.stopPropagation(); onSelectClip(c.id) }}
                className={`absolute top-1 bottom-1 rounded text-[10px] text-white font-semibold flex items-center px-2 cursor-grab ${on ? 'bg-purple-500 ring-2 ring-white' : 'bg-purple-600 hover:bg-purple-500'}`}
                style={{ left: `${timeToPct(c.start)}%`, width: `${Math.max(2, timeToPct(c.end - c.start))}%` }}
                title={c.text}>
                {/* Resize handles */}
                <div onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, 'clipStart', c.id) }}
                  className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-l" />
                <div onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, 'clipEnd', c.id) }}
                  className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-r" />
                <span className="truncate px-1">📝 {c.text}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Time ruler */}
      <div className="relative h-4 mt-1">
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
          <span key={i} className="absolute text-[9px] text-[var(--muted)] font-mono" style={{ left: `${p * 100}%`, transform: 'translateX(-50%)' }}>
            {(p * duration).toFixed(1)}s
          </span>
        ))}
      </div>
    </div>
  )
}

function PropertiesPanel({ clip, duration, onUpdate, onDelete }) {
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
          <input type="range" min={0} max={duration} step={0.05} value={clip.start}
            onChange={(e) => onUpdate({ start: parseFloat(e.target.value) })} className="w-full" />
        </Field>
        <Field label={`End: ${clip.end.toFixed(2)}s`}>
          <input type="range" min={0} max={duration} step={0.05} value={clip.end}
            onChange={(e) => onUpdate({ end: parseFloat(e.target.value) })} className="w-full" />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label={`X: ${clip.x_pct}%`}>
          <input type="range" min={0} max={100} value={clip.x_pct}
            onChange={(e) => onUpdate({ x_pct: parseInt(e.target.value) })} className="w-full" />
        </Field>
        <Field label={`Y: ${clip.y_pct}%`}>
          <input type="range" min={0} max={100} value={clip.y_pct}
            onChange={(e) => onUpdate({ y_pct: parseInt(e.target.value) })} className="w-full" />
        </Field>
      </div>

      <Field label={`Size: ${clip.size}px`}>
        <input type="range" min={16} max={120} value={clip.size}
          onChange={(e) => onUpdate({ size: parseInt(e.target.value) })} className="w-full" />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Color">
          <input type="color" value={clip.color} onChange={(e) => onUpdate({ color: e.target.value })}
            className="w-full h-8 rounded bg-[var(--surface2)] border border-[var(--border)] cursor-pointer" />
        </Field>
        <Field label="Background">
          <select value={clip.bg} onChange={(e) => onUpdate({ bg: e.target.value })}
            className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
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
          <select value={clip.weight} onChange={(e) => onUpdate({ weight: parseInt(e.target.value) })}
            className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value={400}>Regular</option>
            <option value={600}>Semibold</option>
            <option value={700}>Bold</option>
            <option value={900}>Black</option>
          </select>
        </Field>
        <Field label="Align">
          <select value={clip.align} onChange={(e) => onUpdate({ align: e.target.value })}
            className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </Field>
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

// ── Client-side rendering via MediaRecorder + canvas ───────────────
// Plays the source video, draws each frame to a canvas with text overlays
// applied, captures the canvas stream via MediaRecorder, returns the
// recorded Blob (WebM).
async function renderToBlob({ sourceUrl, trimStart, trimEnd, ar, textClips, onProgress }) {
  onProgress?.('Loading source video...')

  // 1. Load source video
  const video = document.createElement('video')
  video.src = sourceUrl
  video.crossOrigin = 'anonymous'
  video.muted = false
  await new Promise((res, rej) => {
    video.onloadedmetadata = res
    video.onerror = () => rej(new Error('Gagal load source video'))
  })

  const dur = trimEnd - trimStart

  // 2. Set up canvas matching source dimensions
  // Pick canvas size from aspect ratio (consistent output regardless of source)
  const [arW, arH] = ar === '16:9' ? [1280, 720] : ar === '1:1' ? [1080, 1080] : [720, 1280]
  const canvas = document.createElement('canvas')
  canvas.width = arW
  canvas.height = arH
  const ctx = canvas.getContext('2d')

  // 3. MediaRecorder on canvas stream
  const stream = canvas.captureStream(30)

  // Try to also capture audio from source video
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const src = audioCtx.createMediaElementSource(video)
    const dest = audioCtx.createMediaStreamDestination()
    src.connect(dest)
    src.connect(audioCtx.destination)
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
  } catch (e) {
    console.warn('Audio capture skipped:', e.message)
  }

  // Pick a supported mime type
  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }

  // 4. Seek to trim start
  video.currentTime = trimStart
  await new Promise((res) => video.onseeked = res)

  recorder.start()
  await video.play()
  onProgress?.(`Recording... 0% (${dur.toFixed(1)}s)`)

  const startTs = performance.now()
  let stopReq = false

  function drawFrame() {
    if (stopReq) return
    // Cover/contain — fit source to canvas keeping aspect
    const vw = video.videoWidth, vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      const srcAR = vw / vh, dstAR = canvas.width / canvas.height
      let dw, dh, dx, dy
      if (srcAR > dstAR) { dh = canvas.height; dw = dh * srcAR; dx = (canvas.width - dw) / 2; dy = 0 }
      else { dw = canvas.width; dh = dw / srcAR; dx = 0; dy = (canvas.height - dh) / 2 }
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(video, dx, dy, dw, dh)
    }
    // Overlay active text clips
    const t = video.currentTime
    textClips.forEach((c) => {
      if (t < c.start || t > c.end) return
      const x = (c.x_pct / 100) * canvas.width
      const y = (c.y_pct / 100) * canvas.height
      const fontSize = c.size * (canvas.width / 720)
      ctx.font = `${c.weight} ${fontSize}px system-ui, -apple-system, sans-serif`
      ctx.textAlign = c.align === 'left' ? 'left' : c.align === 'right' ? 'right' : 'center'
      ctx.textBaseline = 'middle'
      const metrics = ctx.measureText(c.text)
      const padding = fontSize * 0.3
      // Background pill
      if (c.bg && c.bg !== 'transparent') {
        ctx.fillStyle = c.bg
        const bgW = metrics.width + padding * 2
        const bgH = fontSize * 1.4
        let bgX = x
        if (c.align === 'center') bgX = x - bgW / 2
        else if (c.align === 'right') bgX = x - bgW
        ctx.fillRect(bgX, y - bgH / 2, bgW, bgH)
      }
      // Text shadow
      ctx.shadowColor = 'rgba(0,0,0,0.8)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetY = 1
      ctx.fillStyle = c.color
      ctx.fillText(c.text, x, y)
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
    })

    const elapsed = (performance.now() - startTs) / 1000
    const pct = Math.min(100, Math.round((elapsed / dur) * 100))
    onProgress?.(`Recording... ${pct}%`)

    if (video.currentTime >= trimEnd || elapsed > dur + 1) {
      stopReq = true
      video.pause()
      setTimeout(() => recorder.stop(), 100)
      return
    }
    requestAnimationFrame(drawFrame)
  }
  drawFrame()

  await new Promise((res) => {
    recorder.onstop = res
  })
  onProgress?.('Finalizing...')
  return new Blob(chunks, { type: mimeType })
}
