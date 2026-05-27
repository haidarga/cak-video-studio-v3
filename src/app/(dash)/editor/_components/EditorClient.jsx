'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { renderProject, totalDuration, clipDuration, clipInTrack, activeClipAt } from '@/lib/editor-render'

// Editor v3 final: multi-clip video sequencing + transitions (cut/fade/crossfade)
// + filters (brightness/contrast/saturation/blur) per clip + speed + volume +
// text + image overlay + music underlay + ffmpeg.wasm MP4 export.

const DEFAULT_FILTERS = { brightness: 0, contrast: 1, saturation: 1, blur: 0 }
const DEFAULT_TRANSITION = { type: 'cut', duration: 0.5 }

const DEFAULT_PROJECT = {
  name: 'Untitled project',
  ar: '9:16',
  video_clips: [], // { id, src_url, src_label, src_duration, src_in, src_out, speed, volume, filters, transition_in }
  text_clips: [],
  image_clips: [],
  audio_clips: [],
}

function uid() { return Math.random().toString(36).slice(2, 10) }

function normalizeProject(raw) {
  if (!raw) return DEFAULT_PROJECT
  // v3 native
  if (Array.isArray(raw.video_clips)) {
    return {
      ...DEFAULT_PROJECT,
      ...raw,
      video_clips: raw.video_clips.map((c) => ({
        ...c,
        filters: { ...DEFAULT_FILTERS, ...(c.filters || {}) },
        transition_in: { ...DEFAULT_TRANSITION, ...(c.transition_in || {}) },
      })),
    }
  }
  // v2 had single `source`
  if (raw.source) {
    return {
      ...DEFAULT_PROJECT,
      name: raw.name || 'Untitled', ar: raw.ar || '9:16',
      video_clips: raw.source.url ? [{
        id: uid(), src_url: raw.source.url, src_label: '(legacy)',
        src_duration: raw.source.trim_end || 60,
        src_in: raw.source.trim_start || 0,
        src_out: raw.source.trim_end || 60,
        speed: raw.source.speed || 1, volume: raw.source.volume || 1,
        filters: { ...DEFAULT_FILTERS },
        transition_in: { ...DEFAULT_TRANSITION },
      }] : [],
      text_clips: raw.text_clips || [],
      image_clips: raw.image_clips || [],
      audio_clips: raw.audio_clips || [],
    }
  }
  // v1
  return {
    ...DEFAULT_PROJECT,
    name: raw.name || 'Untitled', ar: raw.ar || '9:16',
    video_clips: raw.source_url ? [{
      id: uid(), src_url: raw.source_url, src_label: '(legacy v1)',
      src_duration: raw.trim_end || 60,
      src_in: raw.trim_start || 0,
      src_out: raw.trim_end || 60,
      speed: 1, volume: 1,
      filters: { ...DEFAULT_FILTERS },
      transition_in: { ...DEFAULT_TRANSITION },
    }] : [],
    text_clips: raw.text_clips || [],
    image_clips: [], audio_clips: [],
  }
}

export default function EditorClient({ workspaceId, userId, results, projects }) {
  const supabase = createClient()
  const [project, setProject] = useState(DEFAULT_PROJECT)
  const [projectId, setProjectId] = useState(null)
  const [selected, setSelected] = useState(null) // { kind, id }
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const videoRef = useRef(null)
  const playRafRef = useRef(null)
  const imageInputRef = useRef(null)
  const audioInputRef = useRef(null)

  const videoSources = useMemo(() => results.filter((r) => r.type === 'video' && r.url), [results])
  const totalDur = useMemo(() => totalDuration(project.video_clips), [project.video_clips])
  const activeClipInfo = useMemo(() => activeClipAt(currentTime, project.video_clips), [currentTime, project.video_clips])
  const activeClip = activeClipInfo ? project.video_clips[activeClipInfo.index] : null

  function patch(p) { setProject((cur) => ({ ...cur, ...(typeof p === 'function' ? p(cur) : p) })) }

  async function addVideoClip(result) {
    setErr('')
    // Probe duration via a temporary video element
    const probe = document.createElement('video')
    probe.src = result.url
    probe.crossOrigin = 'anonymous'
    const dur = await new Promise((res) => { probe.onloadedmetadata = () => res(probe.duration || 10); probe.onerror = () => res(10) })
    const c = {
      id: uid(), src_url: result.url, src_label: result.label || 'untitled',
      src_duration: dur, src_in: 0, src_out: dur, speed: 1, volume: 1,
      filters: { ...DEFAULT_FILTERS },
      transition_in: project.video_clips.length === 0 ? { ...DEFAULT_TRANSITION } : { type: 'crossfade', duration: 0.5 },
    }
    patch((p) => ({ ...p, video_clips: [...p.video_clips, c] }))
    if (project.video_clips.length === 0) {
      setProject((p) => ({ ...p, name: result.label ? `${result.label} (edit)` : p.name, ar: result.ar || p.ar }))
    }
    setSelected({ kind: 'video', id: c.id })
  }

  function removeVideoClip(id) {
    patch((p) => ({ ...p, video_clips: p.video_clips.filter((c) => c.id !== id) }))
    if (selected?.id === id) setSelected(null)
  }

  function moveVideoClip(id, dir) {
    patch((p) => {
      const idx = p.video_clips.findIndex((c) => c.id === id)
      if (idx < 0) return p
      const nidx = dir === 'up' ? idx - 1 : idx + 1
      if (nidx < 0 || nidx >= p.video_clips.length) return p
      const next = [...p.video_clips]
      ;[next[idx], next[nidx]] = [next[nidx], next[idx]]
      return { ...p, video_clips: next }
    })
  }

  function addTextClip() {
    const c = {
      id: uid(), kind: 'text', text: 'Tap to edit',
      start: Math.max(0, currentTime), end: Math.min(totalDur || 5, (currentTime || 0) + 2),
      x_pct: 50, y_pct: 80, size: 48, color: '#ffffff', weight: 700,
      bg: 'rgba(0,0,0,0.6)', align: 'center',
    }
    patch((p) => ({ ...p, text_clips: [...p.text_clips, c] }))
    setSelected({ kind: 'text', id: c.id })
  }

  async function onImageFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    if (!f.type.startsWith('image/')) { setErr('File harus image'); return }
    try {
      const path = `${workspaceId}/editor-img-${Date.now()}.${f.name.split('.').pop()}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const c = {
        id: uid(), kind: 'image', src_url: publicUrl, src_name: f.name,
        start: currentTime, end: Math.min(totalDur || 5, currentTime + 3),
        x_pct: 90, y_pct: 10, w_pct: 15, opacity: 1,
      }
      patch((p) => ({ ...p, image_clips: [...p.image_clips, c] }))
      setSelected({ kind: 'image', id: c.id })
    } catch (e) { setErr('Upload image: ' + e.message) }
  }

  async function onAudioFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    if (!f.type.startsWith('audio/')) { setErr('File harus audio'); return }
    try {
      const path = `${workspaceId}/editor-audio-${Date.now()}.${f.name.split('.').pop()}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const c = { id: uid(), kind: 'audio', src_url: publicUrl, src_name: f.name, start: 0, duration: totalDur || 15, volume: 0.3 }
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
    setProject((proj) => ({ ...proj, [`${kind}_clips`]: proj[`${kind}_clips`].filter((c) => c.id !== id) }))
    if (selected?.id === id) setSelected(null)
  }

  async function saveProject() {
    if (project.video_clips.length === 0) { setErr('Tambah minimal 1 video clip dulu'); return }
    setSaving(true); setErr('')
    try {
      if (projectId) {
        const { error } = await supabase.from('editor_projects')
          .update({ name: project.name, source_result_id: null, config: project, updated_at: new Date().toISOString() })
          .eq('id', projectId)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('editor_projects')
          .insert({ workspace_id: workspaceId, name: project.name, config: project, created_by: userId })
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
    setProjectId(data.id); setSelected(null); setCurrentTime(0)
  }

  function newProject() { setProject(DEFAULT_PROJECT); setProjectId(null); setSelected(null); setCurrentTime(0) }

  async function exportVideo() {
    if (project.video_clips.length === 0) { setErr('Belum ada video clip'); return }
    setExporting(true); setExportProgress('Persiapan...'); setErr('')
    try {
      const { blob, ext, mime } = await renderProject(project, setExportProgress)
      setExportProgress(`Uploading ${(blob.size / 1024 / 1024).toFixed(1)}MB...`)
      const path = `${workspaceId}/editor-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, blob, { upsert: false, contentType: mime, cacheControl: '3600' })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const { error: insErr } = await supabase.from('results').insert({
        workspace_id: workspaceId, type: 'video', url: publicUrl,
        label: project.name + ' (edited)', ar: project.ar,
        group_label: 'editor', qc_status: 'pending',
        meta: {
          source: 'editor', editor_project_id: projectId, format: ext,
          duration: totalDur, video_clips: project.video_clips.length,
          text_clips: project.text_clips.length, image_clips: project.image_clips.length, audio_clips: project.audio_clips.length,
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

  // Preview playback: drive video element from currentTime + activeClip
  useEffect(() => {
    const v = videoRef.current
    if (!v || !activeClip) return
    if (v.src !== activeClip.src_url) {
      v.src = activeClip.src_url
      v.load()
    }
    const targetTime = activeClipInfo.srcTime
    if (Math.abs(v.currentTime - targetTime) > 0.3) {
      v.currentTime = targetTime
    }
    v.playbackRate = activeClip.speed || 1
    v.volume = Math.min(1, activeClip.volume ?? 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id])

  function startPlayback() {
    if (!project.video_clips.length) return
    const v = videoRef.current; if (!v) return
    setPlaying(true)
    const startWallTime = performance.now()
    const startTimelineTime = currentTime >= totalDur ? 0 : currentTime
    if (currentTime >= totalDur) setCurrentTime(0)
    function loop() {
      const elapsed = (performance.now() - startWallTime) / 1000
      const t = Math.min(totalDur, startTimelineTime + elapsed)
      setCurrentTime(t)
      if (t >= totalDur) { setPlaying(false); return }
      // Sync video element to active clip
      const info = activeClipAt(t, project.video_clips)
      if (info) {
        const vid = videoRef.current
        if (vid) {
          const clip = project.video_clips[info.index]
          if (vid.src !== clip.src_url) { vid.src = clip.src_url; vid.load() }
          if (Math.abs(vid.currentTime - info.srcTime) > 0.5) vid.currentTime = info.srcTime
          if (vid.paused) vid.play().catch(() => {})
        }
      }
      playRafRef.current = requestAnimationFrame(loop)
    }
    playRafRef.current = requestAnimationFrame(loop)
  }
  function stopPlayback() {
    setPlaying(false)
    if (playRafRef.current) { cancelAnimationFrame(playRafRef.current); playRafRef.current = null }
    if (videoRef.current) videoRef.current.pause()
  }
  function togglePlay() { playing ? stopPlayback() : startPlayback() }

  function seekTo(t) {
    const nt = Math.max(0, Math.min(totalDur, t))
    setCurrentTime(nt)
    if (playing) {
      stopPlayback()
      setTimeout(startPlayback, 50)
    } else {
      // Sync video immediately
      const info = activeClipAt(nt, project.video_clips)
      if (info && videoRef.current) {
        const clip = project.video_clips[info.index]
        if (videoRef.current.src !== clip.src_url) { videoRef.current.src = clip.src_url; videoRef.current.load() }
        videoRef.current.currentTime = info.srcTime
      }
    }
  }

  const aspectClass = project.ar === '16:9' ? 'aspect-video' : project.ar === '1:1' ? 'aspect-square' : 'aspect-[9/16]'
  const videoFilter = activeClip?.filters
    ? `brightness(${1 + (activeClip.filters.brightness || 0)}) contrast(${activeClip.filters.contrast || 1}) saturate(${activeClip.filters.saturation || 1}) blur(${activeClip.filters.blur || 0}px)`
    : 'none'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">✂️ Editor <span className="text-xs text-[var(--muted2)] font-normal">v3 full</span></h1>
          <p className="text-xs text-[var(--muted)]">Multi-clip · Transitions · Filters · Text · Image · Music · MP4</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={project.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Project name"
            className="text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] w-56" />
          <button onClick={newProject} className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)]">+ New</button>
          <button onClick={saveProject} disabled={saving || project.video_clips.length === 0} className="px-3 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
            {saving ? '⏳ Save...' : '💾 Save'}
          </button>
          <button onClick={exportVideo} disabled={exporting || project.video_clips.length === 0}
            className="px-4 py-1.5 text-xs font-bold rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
            {exporting ? `⏳ Rendering...` : `⬇ Export → QC (${totalDur.toFixed(1)}s)`}
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

      <div className="grid grid-cols-[230px_1fr_310px] gap-3" style={{ minHeight: 650 }}>
        {/* LEFT */}
        <div className="space-y-3">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">+ Tambah video clip</div>
            <div className="space-y-1 max-h-64 overflow-auto">
              {videoSources.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)] p-2">Belum ada video. Generate di /generate dulu.</div>
              ) : videoSources.map((r) => (
                <button key={r.id} onClick={() => addVideoClip(r)} className="w-full text-left p-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface2)] hover:border-[var(--accent)]">
                  <div className="flex gap-2">
                    <video src={r.url} muted className="w-10 aspect-[9/16] object-cover rounded bg-black flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold truncate">{r.label || 'untitled'}</div>
                      <div className="text-[9px] text-[var(--muted)] truncate">+ tambah ke sequence</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-1">+ Overlay & audio</div>
            <button onClick={addTextClip} disabled={!project.video_clips.length} className="w-full text-xs px-2 py-1.5 rounded bg-purple-500/20 border border-purple-500/40 hover:bg-purple-500/30 text-purple-200 disabled:opacity-50">📝 Text overlay</button>
            <button onClick={() => imageInputRef.current?.click()} disabled={!project.video_clips.length} className="w-full text-xs px-2 py-1.5 rounded bg-blue-500/20 border border-blue-500/40 hover:bg-blue-500/30 text-blue-200 disabled:opacity-50">🖼 Image / Logo</button>
            <button onClick={() => audioInputRef.current?.click()} disabled={!project.video_clips.length} className="w-full text-xs px-2 py-1.5 rounded bg-orange-500/20 border border-orange-500/40 hover:bg-orange-500/30 text-orange-200 disabled:opacity-50">🎵 Music underlay</button>
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

        {/* CENTER */}
        <div className="space-y-3 min-w-0">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3">
            <div className="relative mx-auto bg-black rounded overflow-hidden" style={{ maxWidth: 360 }}>
              <div className={`${aspectClass} relative w-full`}>
                <video ref={videoRef} className="w-full h-full object-contain" playsInline crossOrigin="anonymous" muted={false}
                  style={{ filter: videoFilter }} />

                {project.image_clips.map((c) => {
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
                {project.text_clips.map((c) => {
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
                {activeClip && (
                  <div className="absolute bottom-1 left-1 text-[9px] bg-black/70 text-white px-1.5 py-0.5 rounded">
                    Clip {activeClipInfo.index + 1}/{project.video_clips.length}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mt-3">
              <button onClick={togglePlay} disabled={!project.video_clips.length} className="px-3 py-1.5 rounded bg-[var(--accent)] text-white text-xs font-bold disabled:opacity-50">
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button onClick={() => seekTo(0)} disabled={!project.video_clips.length} className="px-2 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)]">⏮</button>
              <div className="text-[10px] text-[var(--muted)] font-mono flex-1 text-center">
                {currentTime.toFixed(2)}s / {totalDur.toFixed(2)}s
              </div>
            </div>

            {totalDur > 0 && (
              <input type="range" min={0} max={totalDur} step={0.01} value={currentTime}
                onChange={(e) => seekTo(parseFloat(e.target.value))} className="w-full mt-2" />
            )}
          </div>

          {project.video_clips.length > 0 && (
            <Timeline project={project} totalDur={totalDur} currentTime={currentTime}
              selected={selected} onSelect={setSelected} onSeek={seekTo} onUpdateClip={updateClip} />
          )}
        </div>

        {/* RIGHT */}
        <div className="space-y-3">
          {selected?.kind === 'video' ? (
            <VideoClipPanel clip={project.video_clips.find((c) => c.id === selected.id)}
              isFirst={project.video_clips[0]?.id === selected.id}
              onUpdate={(p) => updateClip('video', selected.id, p)}
              onDelete={() => removeVideoClip(selected.id)}
              onMoveUp={() => moveVideoClip(selected.id, 'up')}
              onMoveDown={() => moveVideoClip(selected.id, 'down')} />
          ) : selected?.kind === 'text' ? (
            <TextPanel clip={project.text_clips.find((c) => c.id === selected.id)} duration={totalDur}
              onUpdate={(p) => updateClip('text', selected.id, p)} onDelete={() => deleteClip('text', selected.id)} />
          ) : selected?.kind === 'image' ? (
            <ImagePanel clip={project.image_clips.find((c) => c.id === selected.id)} duration={totalDur}
              onUpdate={(p) => updateClip('image', selected.id, p)} onDelete={() => deleteClip('image', selected.id)} />
          ) : selected?.kind === 'audio' ? (
            <AudioPanel clip={project.audio_clips.find((c) => c.id === selected.id)} duration={totalDur}
              onUpdate={(p) => updateClip('audio', selected.id, p)} onDelete={() => deleteClip('audio', selected.id)} />
          ) : (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs text-[var(--muted)]">
              <div className="text-[10px] uppercase font-semibold mb-2">Properties</div>
              Pilih clip di timeline buat edit. Add video clips dari panel kiri buat mulai.
            </div>
          )}

          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">Project</div>
            <div>Total: <strong>{totalDur.toFixed(2)}s</strong> @ {project.ar}</div>
            <div className="text-[10px] text-[var(--muted2)] mt-1">
              {project.video_clips.length} clip · {project.text_clips.length} text · {project.image_clips.length} img · {project.audio_clips.length} music
            </div>
            <Field label="Aspect ratio" className="mt-2">
              <select value={project.ar} onChange={(e) => patch({ ar: e.target.value })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
                <option value="9:16">9:16 vertical</option>
                <option value="16:9">16:9 horizontal</option>
                <option value="1:1">1:1 square</option>
              </select>
            </Field>
          </div>
        </div>
      </div>
    </div>
  )
}

function Timeline({ project, totalDur, currentTime, selected, onSelect, onSeek, onUpdateClip }) {
  const trackRef = useRef(null)
  const dragRef = useRef(null)
  const pctToTime = (pct) => (pct / 100) * totalDur
  const timeToPct = (t) => totalDur > 0 ? (t / totalDur) * 100 : 0

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
      if (kind === 'clipMove' && clipKind !== 'video') {
        const c = startClip
        const len = c.end - c.start
        const dx = (ev.clientX - origin.x) / rect.width * totalDur
        const ns = Math.max(0, Math.min(totalDur - len, c.start + dx))
        onUpdateClip(clipKind, clipId, { start: ns, end: ns + len })
      } else if (kind === 'clipStart' && clipKind !== 'video') {
        const c = startClip
        onUpdateClip(clipKind, clipId, { start: Math.max(0, Math.min(c.end - 0.1, t)) })
      } else if (kind === 'clipEnd' && clipKind !== 'video') {
        const c = startClip
        onUpdateClip(clipKind, clipId, { end: Math.max(c.start + 0.1, Math.min(totalDur, t)) })
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

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 select-none">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">Timeline · multi-track</div>
        <div className="text-[9px] text-[var(--muted2)]">Klik clip = select · drag pill (non-video) = move</div>
      </div>

      <div ref={trackRef} className="relative cursor-pointer" onClick={onTrackClick}>
        {/* VIDEO track */}
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-12 text-[9px] text-[var(--muted)] font-semibold flex-shrink-0">📹 video</div>
          <div className="relative flex-1 h-8 bg-[var(--accent)]/10 rounded">
            {project.video_clips.map((c, i) => {
              const start = clipInTrack(project.video_clips, i)
              const dur = clipDuration(c)
              const isSel = selected?.kind === 'video' && selected.id === c.id
              const hasTrans = i > 0 && c.transition_in && c.transition_in.type !== 'cut'
              return (
                <div key={c.id}
                  onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'video', id: c.id }) }}
                  className={`absolute top-0.5 bottom-0.5 rounded text-[9px] text-white font-semibold flex items-center px-1.5 cursor-pointer bg-[var(--accent)] ${isSel ? 'ring-2 ring-white' : ''}`}
                  style={{ left: `${timeToPct(start)}%`, width: `${Math.max(2, timeToPct(dur))}%` }}
                  title={c.src_label}>
                  {hasTrans && <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-3 h-3 bg-yellow-400 rounded-full text-black text-[8px] flex items-center justify-center font-bold" title={`${c.transition_in.type} ${c.transition_in.duration}s`}>×</div>}
                  <span className="truncate px-1">📹 {i + 1}. {c.src_label?.slice(0, 14) || '—'}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* OVERLAYS */}
        {[
          { kind: 'image', label: '🖼 image', color: 'bg-blue-900/20', pillBg: 'bg-blue-600' },
          { kind: 'text', label: '📝 text', color: 'bg-purple-900/20', pillBg: 'bg-purple-600' },
          { kind: 'audio', label: '🎵 audio', color: 'bg-orange-900/20', pillBg: 'bg-orange-600' },
        ].map((trk) => {
          const items = trk.kind === 'audio'
            ? (project.audio_clips || []).map((c) => ({ ...c, end: c.start + c.duration }))
            : (project[`${trk.kind}_clips`] || [])
          return (
            <div key={trk.kind} className="flex items-center gap-2 mb-1.5">
              <div className="w-12 text-[9px] text-[var(--muted)] font-semibold flex-shrink-0">{trk.label}</div>
              <div className={`relative flex-1 h-7 ${trk.color} rounded`}>
                {items.map((c) => {
                  const isSel = selected?.kind === trk.kind && selected.id === c.id
                  return (
                    <div key={c.id}
                      onMouseDown={(e) => { startDrag(e, 'clipMove', trk.kind, c.id); onSelect({ kind: trk.kind, id: c.id }) }}
                      onClick={(e) => { e.stopPropagation(); onSelect({ kind: trk.kind, id: c.id }) }}
                      className={`absolute top-0.5 bottom-0.5 rounded text-[9px] text-white font-semibold flex items-center px-1.5 cursor-grab ${trk.pillBg} ${isSel ? 'ring-2 ring-white' : ''}`}
                      style={{ left: `${timeToPct(c.start)}%`, width: `${Math.max(2, timeToPct(c.end - c.start))}%` }}>
                      <div onMouseDown={(e) => startDrag(e, 'clipStart', trk.kind, c.id)} className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-l" />
                      <div onMouseDown={(e) => startDrag(e, 'clipEnd', trk.kind, c.id)} className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-r" />
                      <span className="truncate px-1">{trk.kind === 'text' ? `📝 ${c.text?.slice(0, 14)}` : trk.kind === 'image' ? `🖼 ${c.src_name?.slice(0, 12)}` : `🎵 ${c.src_name?.slice(0, 12)}`}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Playhead */}
        <div className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none" style={{ left: `calc(48px + (100% - 48px) * ${timeToPct(currentTime) / 100})` }}>
          <div className="absolute -top-1 -left-1 w-2 h-2 bg-red-500 rounded-full" />
        </div>
      </div>

      <div className="relative h-3 mt-1 ml-12">
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
          <span key={i} className="absolute text-[9px] text-[var(--muted)] font-mono" style={{ left: `${p * 100}%`, transform: 'translateX(-50%)' }}>
            {(p * totalDur).toFixed(1)}s
          </span>
        ))}
      </div>
    </div>
  )
}

function VideoClipPanel({ clip, isFirst, onUpdate, onDelete, onMoveUp, onMoveDown }) {
  if (!clip) return null
  const updFilter = (k, v) => onUpdate({ filters: { ...clip.filters, [k]: v } })
  const updTrans = (k, v) => onUpdate({ transition_in: { ...clip.transition_in, [k]: v } })
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">📹 Video clip</div>
        <div className="flex gap-1">
          <button onClick={onMoveUp} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface2)] hover:bg-[var(--border)]" title="Move up">▲</button>
          <button onClick={onMoveDown} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface2)] hover:bg-[var(--border)]" title="Move down">▼</button>
          <button onClick={onDelete} className="text-[10px] px-1.5 py-0.5 rounded text-red-400 hover:bg-[var(--surface2)]">Hapus</button>
        </div>
      </div>
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_label}</div>

      <Field label={`Trim in: ${(clip.src_in || 0).toFixed(2)}s`}>
        <input type="range" min={0} max={clip.src_duration} step={0.05} value={clip.src_in} onChange={(e) => onUpdate({ src_in: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Trim out: ${(clip.src_out || 0).toFixed(2)}s of ${clip.src_duration?.toFixed(1)}s`}>
        <input type="range" min={0} max={clip.src_duration} step={0.05} value={clip.src_out} onChange={(e) => onUpdate({ src_out: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Speed: ${clip.speed}x`}>
        <input type="range" min={0.25} max={3} step={0.05} value={clip.speed} onChange={(e) => onUpdate({ speed: parseFloat(e.target.value) })} className="w-full" />
      </Field>
      <Field label={`Volume: ${Math.round(clip.volume * 100)}%`}>
        <input type="range" min={0} max={1.5} step={0.05} value={clip.volume} onChange={(e) => onUpdate({ volume: parseFloat(e.target.value) })} className="w-full" />
      </Field>

      {!isFirst && (
        <div className="pt-2 border-t border-[var(--border)]">
          <div className="text-[10px] uppercase font-semibold text-yellow-400 mb-1.5">🎬 Transition (from previous)</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type">
              <select value={clip.transition_in.type} onChange={(e) => updTrans('type', e.target.value)} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
                <option value="cut">Cut (none)</option>
                <option value="fade">Fade</option>
                <option value="crossfade">Crossfade</option>
              </select>
            </Field>
            <Field label={`Duration: ${clip.transition_in.duration}s`}>
              <input type="range" min={0.1} max={2} step={0.1} value={clip.transition_in.duration} onChange={(e) => updTrans('duration', parseFloat(e.target.value))} className="w-full" disabled={clip.transition_in.type === 'cut'} />
            </Field>
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--border)]">
        <div className="text-[10px] uppercase font-semibold text-cyan-400 mb-1.5">🎨 Filters</div>
        <Field label={`Brightness: ${clip.filters.brightness > 0 ? '+' : ''}${(clip.filters.brightness * 100).toFixed(0)}%`}>
          <input type="range" min={-0.5} max={0.5} step={0.05} value={clip.filters.brightness} onChange={(e) => updFilter('brightness', parseFloat(e.target.value))} className="w-full" />
        </Field>
        <Field label={`Contrast: ${clip.filters.contrast.toFixed(2)}x`}>
          <input type="range" min={0.5} max={2} step={0.05} value={clip.filters.contrast} onChange={(e) => updFilter('contrast', parseFloat(e.target.value))} className="w-full" />
        </Field>
        <Field label={`Saturation: ${clip.filters.saturation.toFixed(2)}x`}>
          <input type="range" min={0} max={3} step={0.05} value={clip.filters.saturation} onChange={(e) => updFilter('saturation', parseFloat(e.target.value))} className="w-full" />
        </Field>
        <Field label={`Blur: ${clip.filters.blur}px`}>
          <input type="range" min={0} max={20} step={1} value={clip.filters.blur} onChange={(e) => updFilter('blur', parseInt(e.target.value))} className="w-full" />
        </Field>
      </div>
    </div>
  )
}

function TextPanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">📝 Text overlay</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <Field label="Text">
        <textarea value={clip.text} onChange={(e) => onUpdate({ text: e.target.value })} rows={2} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
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
        <Field label={`X: ${clip.x_pct}%`}><input type="range" min={0} max={100} value={clip.x_pct} onChange={(e) => onUpdate({ x_pct: parseInt(e.target.value) })} className="w-full" /></Field>
        <Field label={`Y: ${clip.y_pct}%`}><input type="range" min={0} max={100} value={clip.y_pct} onChange={(e) => onUpdate({ y_pct: parseInt(e.target.value) })} className="w-full" /></Field>
      </div>
      <Field label={`Size: ${clip.size}px`}><input type="range" min={16} max={120} value={clip.size} onChange={(e) => onUpdate({ size: parseInt(e.target.value) })} className="w-full" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Color"><input type="color" value={clip.color} onChange={(e) => onUpdate({ color: e.target.value })} className="w-full h-8 rounded cursor-pointer" /></Field>
        <Field label="BG">
          <select value={clip.bg} onChange={(e) => onUpdate({ bg: e.target.value })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value="transparent">Transparent</option>
            <option value="rgba(0,0,0,0.6)">Black 60%</option>
            <option value="rgba(0,0,0,0.85)">Black 85%</option>
            <option value="rgba(255,255,255,0.85)">White 85%</option>
            <option value="rgba(255,87,87,0.85)">Red</option>
            <option value="rgba(255,193,7,0.85)">Yellow</option>
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
        <Field label={`Start: ${clip.start.toFixed(2)}s`}><input type="range" min={0} max={duration} step={0.05} value={clip.start} onChange={(e) => onUpdate({ start: parseFloat(e.target.value) })} className="w-full" /></Field>
        <Field label={`End: ${clip.end.toFixed(2)}s`}><input type="range" min={0} max={duration} step={0.05} value={clip.end} onChange={(e) => onUpdate({ end: parseFloat(e.target.value) })} className="w-full" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`X: ${clip.x_pct}%`}><input type="range" min={0} max={100} value={clip.x_pct} onChange={(e) => onUpdate({ x_pct: parseInt(e.target.value) })} className="w-full" /></Field>
        <Field label={`Y: ${clip.y_pct}%`}><input type="range" min={0} max={100} value={clip.y_pct} onChange={(e) => onUpdate({ y_pct: parseInt(e.target.value) })} className="w-full" /></Field>
      </div>
      <Field label={`Width: ${clip.w_pct}%`}><input type="range" min={5} max={100} value={clip.w_pct} onChange={(e) => onUpdate({ w_pct: parseInt(e.target.value) })} className="w-full" /></Field>
      <Field label={`Opacity: ${Math.round(clip.opacity * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={clip.opacity} onChange={(e) => onUpdate({ opacity: parseFloat(e.target.value) })} className="w-full" /></Field>
    </div>
  )
}

function AudioPanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">🎵 Music</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <audio src={clip.src_url} controls className="w-full" />
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_name}</div>
      <Field label={`Mulai di: ${clip.start.toFixed(2)}s`}><input type="range" min={0} max={duration} step={0.1} value={clip.start} onChange={(e) => onUpdate({ start: parseFloat(e.target.value) })} className="w-full" /></Field>
      <Field label={`Volume: ${Math.round(clip.volume * 100)}%`}><input type="range" min={0} max={1.5} step={0.05} value={clip.volume} onChange={(e) => onUpdate({ volume: parseFloat(e.target.value) })} className="w-full" /></Field>
    </div>
  )
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <div className="text-[9px] uppercase text-[var(--muted)] font-semibold mb-1">{label}</div>
      {children}
    </div>
  )
}
