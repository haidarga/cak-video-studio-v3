'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { renderProject, totalDuration, clipDuration, activeBaseClipAt, activeOverlaysAt, wrapTextLines } from '@/lib/editor-render'
import { FONT_OPTIONS, DEFAULT_FONT, getFontCss } from '@/lib/editor-fonts'
import { proxify } from '@/lib/editor-proxy'
import AudioWaveform from './AudioWaveform'

// Editor v4 — multi-track stacking (base + B-roll overlays).
// Video clips have track_idx (0=base sequential, 1+ = overlay PiP) +
// in_track (explicit timeline position) + position (for overlays).

const DEFAULT_FILTERS = { brightness: 0, contrast: 1, saturation: 1, blur: 0 }
const DEFAULT_TRANSITION = { type: 'cut', duration: 0.5 }
const DEFAULT_POSITION = { x_pct: 75, y_pct: 25, w_pct: 35, opacity: 1 }

// FONT_OPTIONS / DEFAULT_FONT / getFontCss come from @/lib/editor-fonts so
// the canvas render path (editor-render.js) sees the same family stacks.

// Default effect state per text clip. All disabled by default — old clips
// without these fields still render exactly as before (we fall back to the
// hard-coded subtle shadow in the renderer when nothing is enabled).
const DEFAULT_EFFECTS = {
  stroke: { enabled: false, width: 3, color: '#000000' },
  shadow: { enabled: true, x: 0, y: 2, blur: 4, color: 'rgba(0,0,0,0.8)' },
  glow: { enabled: false, blur: 14, color: '#ffd700' },
}

// Style presets — quick way to apply a common look without touching individual
// sliders. User can still customize after picking a preset.
const EFFECT_PRESETS = {
  clean: { stroke: { enabled: false, width: 3, color: '#000000' }, shadow: { enabled: false, x: 0, y: 0, blur: 0, color: 'rgba(0,0,0,0)' }, glow: { enabled: false, blur: 0, color: '#000' } },
  drop: { stroke: { enabled: false, width: 3, color: '#000000' }, shadow: { enabled: true, x: 0, y: 3, blur: 6, color: 'rgba(0,0,0,0.85)' }, glow: { enabled: false, blur: 0, color: '#000' } },
  tiktok: { stroke: { enabled: true, width: 4, color: '#000000' }, shadow: { enabled: true, x: 0, y: 2, blur: 0, color: 'rgba(0,0,0,1)' }, glow: { enabled: false, blur: 0, color: '#000' } },
  neon: { stroke: { enabled: false, width: 2, color: '#06b6d4' }, shadow: { enabled: false, x: 0, y: 0, blur: 0, color: 'transparent' }, glow: { enabled: true, blur: 18, color: '#06b6d4' } },
  pop3d: { stroke: { enabled: true, width: 2, color: '#000000' }, shadow: { enabled: true, x: 4, y: 4, blur: 0, color: 'rgba(0,0,0,1)' }, glow: { enabled: false, blur: 0, color: '#000' } },
  highlight: { stroke: { enabled: false, width: 0, color: '#000' }, shadow: { enabled: false, x: 0, y: 0, blur: 0, color: 'transparent' }, glow: { enabled: true, blur: 10, color: '#fde047' } },
}

// Compose text-shadow CSS string from shadow + glow effects.
function composeTextShadow(effects) {
  const parts = []
  if (effects?.glow?.enabled) {
    // Stacked glow for stronger halo — 3 layers at increasing blur reads as a real glow.
    const g = effects.glow
    parts.push(`0 0 ${g.blur * 0.4}px ${g.color}`)
    parts.push(`0 0 ${g.blur}px ${g.color}`)
    parts.push(`0 0 ${g.blur * 1.6}px ${g.color}`)
  }
  if (effects?.shadow?.enabled) {
    const s = effects.shadow
    parts.push(`${s.x}px ${s.y}px ${s.blur}px ${s.color}`)
  }
  return parts.join(', ') || 'none'
}

const DEFAULT_PROJECT = {
  name: 'Untitled project',
  ar: '9:16',
  persona_id: null,
  video_clips: [],
  text_clips: [],
  image_clips: [],
  audio_clips: [],
}

function uid() { return Math.random().toString(36).slice(2, 10) }

// Pick the lowest track_idx where a new clip [start, end] doesn't overlap any
// existing clip on that track. Lets multiple text/image/audio overlays stack
// VISUALLY in the timeline on separate rows instead of crashing into one
// confusing pile, while still rendering layered in the preview.
//   getStart/getEnd extract the time bounds from a clip — audio uses
//   start + duration, text/image use start/end directly.
function pickTrackIdx(clips, start, end, getStart, getEnd) {
  for (let idx = 0; idx < 20; idx++) {
    const conflict = clips.some((c) => {
      if ((c.track_idx || 0) !== idx) return false
      return !(getEnd(c) <= start || getStart(c) >= end)
    })
    if (!conflict) return idx
  }
  return 19 // safety cap so a runaway pile doesn't pin the UI
}
const _bounds = {
  text: { s: (c) => c.start, e: (c) => c.end },
  image: { s: (c) => c.start, e: (c) => c.end },
  audio: { s: (c) => c.start, e: (c) => c.start + c.duration },
}

function normalizeProject(raw) {
  if (!raw) return DEFAULT_PROJECT
  // v4 native (has track_idx + in_track)
  if (Array.isArray(raw.video_clips) && raw.video_clips.length > 0 && raw.video_clips[0].track_idx != null) {
    return {
      ...DEFAULT_PROJECT, ...raw,
      video_clips: raw.video_clips.map((c) => ({
        ...c,
        filters: { ...DEFAULT_FILTERS, ...(c.filters || {}) },
        transition_in: { ...DEFAULT_TRANSITION, ...(c.transition_in || {}) },
        position: { ...DEFAULT_POSITION, ...(c.position || {}) },
      })),
    }
  }
  // v3 (array, no track_idx) — backfill: all base track, sequential in_track
  if (Array.isArray(raw.video_clips)) {
    let acc = 0
    const next = raw.video_clips.map((c) => {
      const dur = (c.src_out - c.src_in) / (c.speed || 1)
      const ck = {
        ...c, track_idx: 0, in_track: acc,
        filters: { ...DEFAULT_FILTERS, ...(c.filters || {}) },
        transition_in: { ...DEFAULT_TRANSITION, ...(c.transition_in || {}) },
        position: { ...DEFAULT_POSITION },
      }
      acc += dur
      if (raw.video_clips[raw.video_clips.indexOf(c) + 1]?.transition_in?.type && raw.video_clips[raw.video_clips.indexOf(c) + 1].transition_in.type !== 'cut') {
        acc -= raw.video_clips[raw.video_clips.indexOf(c) + 1].transition_in.duration || 0.5
      }
      return ck
    })
    return { ...DEFAULT_PROJECT, ...raw, video_clips: next }
  }
  // v2/v1 — single source
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
        track_idx: 0, in_track: 0,
        filters: { ...DEFAULT_FILTERS },
        transition_in: { ...DEFAULT_TRANSITION },
        position: { ...DEFAULT_POSITION },
      }] : [],
      text_clips: raw.text_clips || [],
      image_clips: raw.image_clips || [],
      audio_clips: raw.audio_clips || [],
    }
  }
  return DEFAULT_PROJECT
}

export default function EditorClient({ workspaceId, userId, results: initialResults, projects, personas = [] }) {
  const [results, setResults] = useState(initialResults)
  const supabase = createClient()
  const [project, setProject] = useState(DEFAULT_PROJECT)
  const [projectId, setProjectId] = useState(null)
  const [selected, setSelected] = useState(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState('')
  const playRafRef = useRef(null)
  // Undo/redo history stack — snapshots of project (max 50)
  const historyRef = useRef({ past: [], future: [] })

  // Hidden canvas just for measureText — used to compute text wrap in JS
  // (instead of relying on CSS auto-wrap) so preview line breaks match
  // canvas export line breaks byte-for-byte. CSS preview pane and the
  // render canvas are different absolute pixel widths, so any wrap that
  // depends on CSS layout will differ from canvas wrap. Doing the wrap in
  // JS using the canvas frame W as the reference width and applying the
  // SAME wrapTextLines fn on both paths fixes the mismatch.
  const measureCanvasRef = useRef(null)
  if (!measureCanvasRef.current && typeof document !== 'undefined') {
    measureCanvasRef.current = document.createElement('canvas')
  }
  // fontsReady forces a re-render once Google Fonts finish loading so the
  // initial wrap measurements use the right glyph widths.
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) { setFontsReady(true); return }
    document.fonts.ready.then(() => setFontsReady(true))
  }, [])
  // Compute wrapped lines for a text clip using canvas measureText. Same
  // function shape as in editor-render.js so preview and export agree.
  function getCanvasW(ar) {
    return ar === '16:9' ? 1280 : ar === '1:1' ? 1080 : 720
  }
  function computeTextLines(c, ar) {
    if (!measureCanvasRef.current) return [c.text || '']
    const ctx = measureCanvasRef.current.getContext('2d')
    const W = getCanvasW(ar)
    const fontSize = c.size * (W / 720) // matches editor-render baseFontSize
    const fontCss = getFontCss(c.font || DEFAULT_FONT)
    ctx.font = `${c.weight || 400} ${fontSize}px ${fontCss}`
    const maxLineWidth = W * ((c.max_width_pct ?? 90) / 100)
    return wrapTextLines(ctx, c.text || '', maxLineWidth)
  }
  // eslint-disable-next-line no-unused-vars
  const _fontsReadyForRender = fontsReady // referenced to keep the dep relevant
  function pushHistory(prevProject) {
    historyRef.current.past.push(JSON.stringify(prevProject))
    if (historyRef.current.past.length > 50) historyRef.current.past.shift()
    historyRef.current.future = [] // wipe redo on new action
  }
  function undo() {
    const h = historyRef.current
    if (h.past.length === 0) return
    h.future.push(JSON.stringify(project))
    const prev = h.past.pop()
    setProject(JSON.parse(prev))
  }
  function redo() {
    const h = historyRef.current
    if (h.future.length === 0) return
    h.past.push(JSON.stringify(project))
    const next = h.future.pop()
    setProject(JSON.parse(next))
  }
  // Wrapped patch that captures history snapshot first
  function patchWithHistory(p) {
    pushHistory(project)
    setProject((cur) => ({ ...cur, ...(typeof p === 'function' ? p(cur) : p) }))
  }
  const baseVideoRef = useRef(null) // single video element for base track
  const overlayRefs = useRef(new Map()) // clip.id -> HTMLVideoElement
  // Cloned-voice audio elements — clip.id -> HTMLAudioElement.
  // When a clip with use_cloned_voice is active, the base/overlay video gets
  // muted and the cloned audio plays in sync with the video's srcTime.
  const clonedAudioRefs = useRef(new Map())
  // Single BGM element (project.audio_clips[0]). Volume drops to bgm_duck when
  // any cloned voice is currently playing.
  const bgmAudioRef = useRef(null)
  const imageInputRef = useRef(null)
  const audioInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const importInputRef = useRef(null)

  function exportProjectJson() {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${project.name.replace(/[^a-z0-9]/gi, '_')}.cakedit.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  async function importProjectJson(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    try {
      const txt = await f.text()
      const parsed = JSON.parse(txt)
      pushHistory(project)
      setProject(normalizeProject(parsed))
      setProjectId(null) // imported as new, not linked to existing DB row
      setSelected(null); setCurrentTime(0)
      setErr('')
    } catch (e) { setErr('Import gagal: ' + e.message) }
  }
  const [uploadingVideo, setUploadingVideo] = useState(null) // { name, sizeMB, stage }

  const videoSources = useMemo(() => results.filter((r) => r.type === 'video' && r.url), [results])

  // Delete a video result from the workspace (removes from results table + this
  // picker). Confirm because this is destructive — also affects QC, /results,
  // and any project that currently references it.
  async function deleteVideoSource(r) {
    if (!confirm(`Hapus "${r.label || 'video'}" dari workspace?\n\nIni juga ngehapus dari QC + /results. Project yang udah pakai clip ini tetep jalan (URL still valid sampai storage cleanup), tapi gak bisa di-pilih ulang.`)) return
    const { error } = await supabase.from('results').delete().eq('id', r.id)
    if (error) { setErr('Hapus gagal: ' + error.message); return }
    setResults((prev) => prev.filter((x) => x.id !== r.id))
  }
  const totalDur = useMemo(() => totalDuration(project.video_clips), [project.video_clips])
  const baseClips = useMemo(() => project.video_clips.filter((c) => (c.track_idx || 0) === 0).sort((a, b) => (a.in_track || 0) - (b.in_track || 0)), [project.video_clips])
  const overlayList = useMemo(() => project.video_clips.filter((c) => (c.track_idx || 0) > 0), [project.video_clips])
  const baseInfo = useMemo(() => activeBaseClipAt(currentTime, project.video_clips), [currentTime, project.video_clips])
  const activeOverlaysList = useMemo(() => activeOverlaysAt(currentTime, project.video_clips), [currentTime, project.video_clips])

  // Find next available track_idx for new overlay
  function nextOverlayTrack() {
    const used = new Set(project.video_clips.filter((c) => (c.track_idx || 0) > 0).map((c) => c.track_idx))
    let n = 1
    while (used.has(n)) n++
    return n
  }
  function nextBaseInTrack() {
    if (baseClips.length === 0) return 0
    const last = baseClips[baseClips.length - 1]
    return (last.in_track || 0) + clipDuration(last)
  }

  function patch(p) { setProject((cur) => ({ ...cur, ...(typeof p === 'function' ? p(cur) : p) })) }

  async function addVideoClip(result, asOverlay) {
    setErr('')
    const probe = document.createElement('video')
    probe.src = proxify(result.url); probe.crossOrigin = 'anonymous'
    const dur = await new Promise((res) => { probe.onloadedmetadata = () => res(probe.duration || 10); probe.onerror = () => res(10) })
    // If the source result has a cloned audio (post-gen via /api/voice/convert),
    // attach it here so the editor can swap native audio for the persona's voice.
    // The cloned audio is the SAME audio timing/phonemes, just different voice —
    // lip-sync stays in sync.
    const cloned = result.meta?.cloned_audio_url || null
    const c = {
      id: uid(), src_url: result.url, src_label: result.label || 'untitled',
      src_duration: dur, src_in: 0, src_out: dur,
      speed: 1, volume: asOverlay ? 0.5 : 1,
      track_idx: asOverlay ? nextOverlayTrack() : 0,
      in_track: asOverlay ? currentTime : nextBaseInTrack(),
      filters: { ...DEFAULT_FILTERS },
      transition_in: { ...DEFAULT_TRANSITION, type: baseClips.length === 0 || asOverlay ? 'cut' : 'crossfade' },
      position: { ...DEFAULT_POSITION },
      cloned_audio_url: cloned,
      use_cloned_voice: !!cloned,
      voice_name: result.meta?.voice_name || '',
    }
    patch((p) => ({ ...p, video_clips: [...p.video_clips, c] }))
    if (project.video_clips.length === 0 && !asOverlay) {
      setProject((p) => ({ ...p, name: result.label ? `${result.label} (edit)` : p.name, ar: result.ar || p.ar }))
    }
    setSelected({ kind: 'video', id: c.id })
  }

  function removeVideoClip(id) {
    patch((p) => ({ ...p, video_clips: p.video_clips.filter((c) => c.id !== id) }))
    if (selected?.id === id) setSelected(null)
  }

  function addTextClip() {
    const start = Math.max(0, currentTime)
    const end = Math.min(totalDur || 5, (currentTime || 0) + 2)
    patch((p) => {
      const track_idx = pickTrackIdx(p.text_clips, start, end, _bounds.text.s, _bounds.text.e)
      const c = {
        id: uid(), kind: 'text', text: 'Tap to edit',
        start, end, track_idx,
        x_pct: 50, y_pct: 80, size: 48, scale: 1, max_width_pct: 90, color: '#ffffff', weight: 700, font: DEFAULT_FONT,
        bg: 'rgba(0,0,0,0.6)', align: 'center', animation: 'fade',
        effects: DEFAULT_EFFECTS,
      }
      setSelected({ kind: 'text', id: c.id })
      return { ...p, text_clips: [...p.text_clips, c] }
    })
  }

  async function onImageFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    if (!f.type.startsWith('image/')) { setErr('File harus image'); return }
    try {
      const path = `${workspaceId}/editor-img-${Date.now()}.${f.name.split('.').pop()}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const start = currentTime
      const end = Math.min(totalDur || 5, currentTime + 3)
      patch((p) => {
        const track_idx = pickTrackIdx(p.image_clips, start, end, _bounds.image.s, _bounds.image.e)
        const c = {
          id: uid(), kind: 'image', src_url: publicUrl, src_name: f.name,
          start, end, track_idx,
          x_pct: 90, y_pct: 10, w_pct: 15, opacity: 1,
        }
        setSelected({ kind: 'image', id: c.id })
        return { ...p, image_clips: [...p.image_clips, c] }
      })
    } catch (e) { setErr('Upload image: ' + e.message) }
  }

  async function onVideoFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    if (!f.type.startsWith('video/')) { setErr('File harus video (MP4/WebM/MOV)'); return }
    const sizeMB = f.size / 1024 / 1024
    if (sizeMB > 200) { setErr(`File ${sizeMB.toFixed(1)}MB > 200MB max. Compress dulu.`); return }
    setUploadingVideo({ name: f.name, sizeMB: sizeMB.toFixed(1), stage: 'uploading' }); setErr('')
    try {
      const ext = (f.name.split('.').pop() || 'mp4').toLowerCase()
      const path = `${workspaceId}/editor-upload-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type, cacheControl: '3600' })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)

      setUploadingVideo((s) => ({ ...s, stage: 'inserting' }))
      // INSERT to results so it appears in media library + persona-filtered.
      // Default persona = project.persona_id (if set).
      const { data: row, error: insErr } = await supabase.from('results').insert({
        workspace_id: workspaceId, type: 'video', url: publicUrl,
        label: f.name.replace(/\.[^.]+$/, ''), ar: project.ar || '9:16',
        group_label: 'editor_upload',
        meta: { source: 'editor_upload', original_name: f.name, size_bytes: f.size },
        persona_id: project.persona_id || null,
        created_by: userId,
      }).select('id, type, url, label, ar, qc_status, group_label, created_at, personas(id, name, username, avatar_url)').single()
      if (insErr) throw insErr
      // Inject ke local results state at top, so user bisa langsung pick
      setResults((prev) => [row, ...prev])
      setUploadingVideo(null)
    } catch (e) { setErr('Upload video: ' + e.message); setUploadingVideo(null) }
  }

  async function onAudioFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    if (!f.type.startsWith('audio/')) { setErr('File harus audio'); return }
    try {
      const path = `${workspaceId}/editor-audio-${Date.now()}.${f.name.split('.').pop()}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      // src_start = where in the source music file to begin (skip intro).
      // src_end   = where in the source music file to end (cut tail). null = play to natural end.
      // start     = where in the VIDEO TIMELINE the music begins (delay before first note).
      const c = { id: uid(), kind: 'audio', src_url: publicUrl, src_name: f.name, start: 0, src_start: 0, src_end: null, duration: totalDur || 15, volume: 0.3, track_idx: 0 }
      patch({ audio_clips: [c] })
      setSelected({ kind: 'audio', id: c.id })
    } catch (e) { setErr('Upload audio: ' + e.message) }
  }

  async function autoSubtitle({ karaoke = false } = {}) {
    if (baseClips.length === 0) { setErr('Tambah base clip dulu'); return }
    setTranscribing(true); setErr('')
    pushHistory(project)
    let allNewClips = []
    try {
      // Iterate ALL base clips — transcribe per clip + offset segments by clip's in_track
      for (let i = 0; i < baseClips.length; i++) {
        const clip = baseClips[i]
        setTranscribeProgress(`Transcribing clip ${i + 1}/${baseClips.length}...`)
        const res = await fetch('/api/transcribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-word-level': karaoke ? 'true' : 'false' },
          body: JSON.stringify({ url: clip.src_url }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(`Clip ${i + 1}: ${data.error}`)
        if (!data.segments?.length) continue
        const offset = clip.in_track || 0
        const clipsForThis = data.segments.map((s) => {
          const start = offset + s.start
          const end = offset + s.end
          // Track-assign against ALL accumulated clips so subsequent clips
          // land beside, not on top of, earlier auto-sub batches.
          const track_idx = pickTrackIdx(allNewClips, start, end, _bounds.text.s, _bounds.text.e)
          const c = {
            id: uid(), kind: 'text', text: s.text.toUpperCase(),
            start, end, track_idx,
            x_pct: 50, y_pct: 75, size: 56, scale: 1, max_width_pct: 90, color: '#ffffff', weight: 900, font: DEFAULT_FONT,
            bg: 'rgba(0,0,0,0.85)', align: 'center', effects: EFFECT_PRESETS.tiktok,
            animation: karaoke ? 'karaoke' : 'fade',
            // Karaoke: per-word data for highlight
            words: karaoke && s.words ? s.words.map((w) => ({ ...w, start: offset + w.start, end: offset + w.end })) : null,
          }
          allNewClips.push(c) // push as we go so next clip sees this one for collision check
          return c
        })
      }
      patch((p) => ({ ...p, text_clips: [...p.text_clips, ...allNewClips] }))
      setTranscribeProgress(`✓ Generated ${allNewClips.length} subtitle clips dari ${baseClips.length} base clip${baseClips.length > 1 ? 's' : ''}${karaoke ? ' (karaoke)' : ''}`)
    } catch (e) { setErr(`Auto-subtitle gagal: ${e.message}`); setTranscribeProgress('') }
    setTranscribing(false)
  }

  function applyTikTokStyle() {
    patch((p) => ({
      ...p,
      text_clips: p.text_clips.map((c) => ({
        ...c, text: c.text.toUpperCase(), size: 56, weight: 900,
        color: '#ffffff', bg: 'rgba(0,0,0,0.85)', align: 'center',
        x_pct: 50, y_pct: 75, animation: 'fade',
      })),
    }))
  }

  function updateClip(kind, id, p) {
    setProject((proj) => ({
      ...proj,
      [`${kind}_clips`]: proj[`${kind}_clips`].map((c) => c.id === id ? { ...c, ...(typeof p === 'function' ? p(c) : p) } : c),
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
          .update({ name: project.name, config: project, updated_at: new Date().toISOString() })
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
  function newProject() {
    pushHistory(project)
    setProject(DEFAULT_PROJECT); setProjectId(null); setSelected(null); setCurrentTime(0)
  }

  // Clone current project
  async function cloneProject() {
    setErr('')
    try {
      const { data, error } = await supabase.from('editor_projects')
        .insert({ workspace_id: workspaceId, name: project.name + ' (copy)', config: project, created_by: userId })
        .select('id').single()
      if (error) throw error
      setProjectId(data.id)
      setProject({ ...project, name: project.name + ' (copy)' })
      alert('Project cloned. Saved sebagai "' + project.name + ' (copy)"')
    } catch (e) { setErr('Clone gagal: ' + e.message) }
  }

  // Split selected video clip at currentTime
  function splitClipAtPlayhead() {
    if (!selected || selected.kind !== 'video') {
      setErr('Pilih video clip dulu buat split (S key)')
      return
    }
    const clip = project.video_clips.find((c) => c.id === selected.id)
    if (!clip) return
    const cStart = clip.in_track || 0
    const cEnd = cStart + clipDuration(clip)
    if (currentTime <= cStart + 0.1 || currentTime >= cEnd - 0.1) {
      setErr('Playhead harus di tengah clip buat split (gak di ujung-ujung)')
      return
    }
    const speed = clip.speed || 1
    const offsetInTrack = currentTime - cStart // seconds dari clip start
    const offsetInSrc = offsetInTrack * speed
    const splitSrcTime = (clip.src_in || 0) + offsetInSrc

    pushHistory(project)
    // Clip pertama: src_in..splitSrcTime, in_track sama
    const clipA = { ...clip, src_out: splitSrcTime }
    // Clip kedua: splitSrcTime..src_out, in_track = currentTime
    const clipB = { ...clip, id: uid(), src_in: splitSrcTime, in_track: currentTime, transition_in: { type: 'cut', duration: 0 } }
    setProject((p) => ({
      ...p,
      video_clips: p.video_clips.flatMap((c) => c.id === clip.id ? [clipA, clipB] : [c]),
    }))
    setSelected({ kind: 'video', id: clipA.id })
    setErr('')
  }

  // mode: 'fast' = canvas WebM (real-time, no ffmpeg load — fastest)
  //       'mp4'  = ffmpeg.wasm MP4 (slow first time, more compatible)
  async function exportVideo(mode = 'fast') {
    if (project.video_clips.length === 0) { setErr('Belum ada video clip'); return }
    setExporting(true); setExportProgress('Persiapan...'); setErr('')
    try {
      const { blob, ext, mime } = await renderProject(project, setExportProgress, { mode })
      setExportProgress(`Uploading ${(blob.size / 1024 / 1024).toFixed(1)}MB...`)
      const path = `${workspaceId}/editor-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, blob, { upsert: false, contentType: mime, cacheControl: '3600' })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const { error: insErr } = await supabase.from('results').insert({
        workspace_id: workspaceId, type: 'video', url: publicUrl,
        label: project.name + ' (edited)', ar: project.ar,
        group_label: 'editor', qc_status: 'pending',
        persona_id: project.persona_id || null,
        meta: {
          source: 'editor', editor_project_id: projectId, format: ext, duration: totalDur,
          base_clips: baseClips.length, overlay_clips: overlayList.length,
          text_clips: project.text_clips.length, image_clips: project.image_clips.length, audio_clips: project.audio_clips.length,
        },
        created_by: userId,
      })
      if (insErr) throw insErr
      setExportProgress(`✓ Done! ${ext.toUpperCase()} ${(blob.size / 1024 / 1024).toFixed(1)}MB — cek di /qc`)
    } catch (e) { setErr('Export gagal: ' + e.message); setExportProgress('') }
    setExporting(false)
  }

  // Sync base video element to current playhead position.
  //
  // Deps include `baseInfo?.srcTime` so dragging the timeline scrubber within
  // the same clip refires the effect and seeks the <video>. Without srcTime,
  // useEffect only fired when active clip CHANGED — within-clip scrubbing
  // showed a stale frame because the effect never re-ran.
  //
  // Also depend on src_in/src_out so trim edits immediately resync preview
  // to the new trim range (was the 'trim doesn't update preview' bug).
  useEffect(() => {
    const v = baseVideoRef.current
    if (!v || !baseInfo) return
    // v.src reads back the BROWSER-RESOLVED absolute URL; we compare against
    // the raw upstream src_url via a data marker to avoid a relative-vs-
    // absolute mismatch that would re-set v.src every render and flicker the
    // preview on/off (the original bug this comment is here to prevent).
    if (v.dataset.upstreamSrc !== baseInfo.clip.src_url) {
      v.src = proxify(baseInfo.clip.src_url)
      v.dataset.upstreamSrc = baseInfo.clip.src_url
      v.load()
    }
    if (Math.abs(v.currentTime - baseInfo.srcTime) > 0.3) v.currentTime = baseInfo.srcTime
    v.playbackRate = baseInfo.clip.speed || 1
    const usesCloned = baseInfo.clip.cloned_audio_url && baseInfo.clip.use_cloned_voice !== false
    v.muted = !!usesCloned
    v.volume = Math.min(1, baseInfo.clip.volume ?? 1)
    // Pause any cloned audio that isn't the active one
    clonedAudioRefs.current.forEach((el, cid) => {
      if (cid !== baseInfo.clip.id && el && !el.paused) el.pause()
    })
    if (usesCloned) {
      const cv = clonedAudioRefs.current.get(baseInfo.clip.id)
      if (cv) {
        if (Math.abs(cv.currentTime - baseInfo.srcTime) > 0.3) cv.currentTime = baseInfo.srcTime
        if (playing && cv.paused) cv.play().catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseInfo?.clip?.id, baseInfo?.srcTime, baseInfo?.clip?.src_in, baseInfo?.clip?.src_out, baseInfo?.clip?.src_url, playing])

  // Keyboard shortcuts: Delete = delete selected clip; Space = play/pause
  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      const isMac = navigator.platform.includes('Mac')
      const cmd = isMac ? e.metaKey : e.ctrlKey
      if (cmd && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); undo()
      } else if (cmd && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault(); redo()
      } else if (e.key.toLowerCase() === 's' && !cmd) {
        e.preventDefault(); splitClipAtPlayhead()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault()
        if (selected.kind === 'video') removeVideoClip(selected.id)
        else deleteClip(selected.kind, selected.id)
      } else if (e.key === ' ') {
        e.preventDefault(); togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, playing])

  // Sync overlay video elements + their cloned-voice audio (if any).
  useEffect(() => {
    overlayList.forEach((c) => {
      const v = overlayRefs.current.get(c.id)
      if (!v) return
      const isActive = currentTime >= (c.in_track || 0) && currentTime < (c.in_track || 0) + clipDuration(c)
      const cv = clonedAudioRefs.current.get(c.id)
      if (!isActive) {
        if (!v.paused) v.pause()
        if (cv && !cv.paused) cv.pause()
        return
      }
      const desired = (c.src_in || 0) + (currentTime - (c.in_track || 0)) * (c.speed || 1)
      if (Math.abs(v.currentTime - desired) > 0.5) v.currentTime = desired
      v.playbackRate = c.speed || 1
      const usesCloned = c.cloned_audio_url && c.use_cloned_voice !== false
      v.muted = !!usesCloned
      v.volume = Math.min(1, c.volume ?? 0.5)
      if (usesCloned && cv) {
        const cvDesired = currentTime - (c.in_track || 0)
        if (Math.abs(cv.currentTime - cvDesired) > 0.5) cv.currentTime = cvDesired
      }
    })
  }, [currentTime, overlayList])

  // BGM auto-duck: when any cloned voice is currently playing, drop BGM vol.
  useEffect(() => {
    const el = bgmAudioRef.current
    if (!el || !project.audio_clips?.[0]) return
    const a = project.audio_clips[0]
    const baseVol = a.volume ?? 0.3
    const duck = a.bgm_duck ?? 0.25
    const voiced = project.video_clips.filter((c) => c.cloned_audio_url && c.use_cloned_voice !== false)
    const ducking = voiced.some((c) => {
      const s = c.in_track || 0
      return currentTime >= s && currentTime < s + clipDuration(c)
    })
    el.volume = Math.min(1, baseVol * (ducking ? duck : 1))
  }, [currentTime, project.audio_clips, project.video_clips])

  function startPlayback() {
    if (project.video_clips.length === 0) return
    setPlaying(true)
    const startWall = performance.now()
    const startT = currentTime >= totalDur ? 0 : currentTime
    if (currentTime >= totalDur) setCurrentTime(0)
    // BGM: respects 3 controls — timeline delay (a.start), source crop start
    // (a.src_start), source crop end (a.src_end). If we're before timeline
    // delay, don't .play() yet; the RAF loop will kick it off when t crosses
    // a.start (see below).
    if (bgmAudioRef.current && project.audio_clips?.[0]?.src_url) {
      const a = project.audio_clips[0]
      const tDelay = a.start || 0
      const srcStart = a.src_start || 0
      if (startT >= tDelay) {
        bgmAudioRef.current.currentTime = srcStart + (startT - tDelay)
        bgmAudioRef.current.play().catch(() => {})
      } else {
        bgmAudioRef.current.currentTime = srcStart
        // wait until elapsed reaches tDelay; RAF loop starts it.
      }
    }
    // Display-rate throttle for setCurrentTime. RAF fires at ~60Hz but React
    // re-rendering EditorClient (1900 LOC) at that rate stalls preview — the
    // BGM-duck + overlay-sync useEffects also re-fire each render. Cap state
    // updates to ~10Hz: the timeline cursor still moves smoothly (visually),
    // useEffects only run 10x/sec instead of 60x. The RAF loop itself keeps
    // running at full RAF rate using the local `t` variable for accurate sync.
    let lastDisplayUpdate = 0
    function loop() {
      const elapsed = (performance.now() - startWall) / 1000
      const t = Math.min(totalDur, startT + elapsed)
      const now = performance.now()
      if (now - lastDisplayUpdate >= 100) {
        setCurrentTime(t)
        lastDisplayUpdate = now
      }
      if (t >= totalDur) { setCurrentTime(t); setPlaying(false); return }
      // Sync base video
      const bi = activeBaseClipAt(t, project.video_clips)
      if (bi && baseVideoRef.current) {
        const v = baseVideoRef.current
        if (v.dataset.upstreamSrc !== bi.clip.src_url) {
          v.src = proxify(bi.clip.src_url)
          v.dataset.upstreamSrc = bi.clip.src_url
          v.load()
        }
        if (Math.abs(v.currentTime - bi.srcTime) > 0.5) v.currentTime = bi.srcTime
        if (v.paused) v.play().catch(() => {})
        // Cloned voice for base clip
        const usesCloned = bi.clip.cloned_audio_url && bi.clip.use_cloned_voice !== false
        const cv = clonedAudioRefs.current.get(bi.clip.id)
        if (usesCloned && cv) {
          if (Math.abs(cv.currentTime - bi.srcTime) > 0.5) cv.currentTime = bi.srcTime
          if (cv.paused) cv.play().catch(() => {})
        }
      }
      // Sync overlay videos + their cloned audio. Cloned voice volume tracks
      // clip.volume so user can scale it down (incl. set to 0 = full mute).
      project.video_clips.forEach((c) => {
        if ((c.track_idx || 0) === 0) return
        const v = overlayRefs.current.get(c.id)
        if (!v) return
        const isActive = t >= (c.in_track || 0) && t < (c.in_track || 0) + clipDuration(c)
        const cv = clonedAudioRefs.current.get(c.id)
        if (!isActive) {
          if (!v.paused) v.pause()
          if (cv && !cv.paused) cv.pause()
          return
        }
        if (v.paused) v.play().catch(() => {})
        if (cv && c.cloned_audio_url && c.use_cloned_voice !== false) {
          cv.volume = Math.min(1, c.volume ?? 1)
          if (cv.paused) cv.play().catch(() => {})
        }
      })
      // BGM gating: start/stop based on timeline position vs a.start. Without
      // this, music with a delay would either start immediately (wrong) or
      // never start when scrubbing past delay during playback.
      const a = project.audio_clips?.[0]
      const bgm = bgmAudioRef.current
      if (a && bgm) {
        const tDelay = a.start || 0
        const srcStart = a.src_start || 0
        const srcEnd = a.src_end || null
        const srcDuration = srcEnd != null ? Math.max(0, srcEnd - srcStart) : null
        const timelineEnd = srcDuration != null ? tDelay + srcDuration : null
        const shouldPlay = t >= tDelay && (timelineEnd == null || t < timelineEnd)
        if (shouldPlay) {
          if (bgm.paused) {
            bgm.currentTime = srcStart + (t - tDelay)
            bgm.play().catch(() => {})
          }
        } else if (!bgm.paused) {
          bgm.pause()
        }
      }
      playRafRef.current = requestAnimationFrame(loop)
    }
    playRafRef.current = requestAnimationFrame(loop)
  }
  function stopPlayback() {
    setPlaying(false)
    if (playRafRef.current) { cancelAnimationFrame(playRafRef.current); playRafRef.current = null }
    // Final cursor sync — the play loop throttles setCurrentTime to 10Hz, so
    // on stop the state can lag the actual frame by up to ~100ms. Snap to the
    // active video's time so cursor lands where audio actually paused.
    if (baseVideoRef.current && baseInfo) {
      const v = baseVideoRef.current
      const inTrack = baseInfo.clip.in_track || 0
      const srcIn = baseInfo.clip.src_in || 0
      const speed = baseInfo.clip.speed || 1
      const t = inTrack + (v.currentTime - srcIn) / speed
      if (isFinite(t) && t >= 0) setCurrentTime(Math.min(totalDur, t))
    }
    if (baseVideoRef.current) baseVideoRef.current.pause()
    overlayList.forEach((c) => { const v = overlayRefs.current.get(c.id); if (v) v.pause() })
    clonedAudioRefs.current.forEach((el) => { if (el && !el.paused) el.pause() })
    if (bgmAudioRef.current && !bgmAudioRef.current.paused) bgmAudioRef.current.pause()
  }
  function togglePlay() { playing ? stopPlayback() : startPlayback() }
  function seekTo(t) {
    const nt = Math.max(0, Math.min(totalDur, t))
    setCurrentTime(nt)
    if (playing) { stopPlayback(); setTimeout(startPlayback, 50) }
  }

  const aspectClass = project.ar === '16:9' ? 'aspect-video' : project.ar === '1:1' ? 'aspect-square' : 'aspect-[9/16]'
  // Build CSS filter string ONLY when filter values are non-default. Applying
  // `filter: brightness(1) contrast(1) saturate(1) blur(0px)` (identity) still
  // forces the browser to composite every video frame through a filter chain,
  // which kills preview FPS on weaker GPUs. Returning 'none' when all values
  // are default lets the browser short-circuit the filter pass entirely.
  const baseFilter = useMemo(() => {
    const f = baseInfo?.clip?.filters
    if (!f) return 'none'
    const isDefault = (f.brightness || 0) === 0
      && (f.contrast || 1) === 1
      && (f.saturation || 1) === 1
      && (f.blur || 0) === 0
    if (isDefault) return 'none'
    return `brightness(${1 + (f.brightness || 0)}) contrast(${f.contrast || 1}) saturate(${f.saturation || 1}) blur(${f.blur || 0}px)`
  }, [baseInfo?.clip?.filters?.brightness, baseInfo?.clip?.filters?.contrast, baseInfo?.clip?.filters?.saturation, baseInfo?.clip?.filters?.blur])

  // Zoom + Pan: CSS transform on base video. zoom=1 / no clip = no transform
  // (lets browser skip the GPU compositing pass entirely).
  const baseZoom = baseInfo?.clip?.zoom || 1
  const basePanX = baseInfo?.clip?.pan_x_pct ?? 50
  const basePanY = baseInfo?.clip?.pan_y_pct ?? 50
  const baseTransform = baseZoom > 1 ? `scale(${baseZoom})` : undefined
  const baseTransformOrigin = baseZoom > 1 ? `${basePanX}% ${basePanY}%` : undefined

  // Cache overlay filter strings the same way — `filter: none` everywhere by
  // default keeps the composite cheap.
  function overlayFilter(c) {
    const f = c?.filters
    if (!f) return 'none'
    if ((f.brightness || 0) === 0 && (f.contrast || 1) === 1 && (f.saturation || 1) === 1 && (f.blur || 0) === 0) return 'none'
    return `brightness(${1 + (f.brightness || 0)}) contrast(${f.contrast || 1}) saturate(${f.saturation || 1}) blur(${f.blur || 0}px)`
  }

  // Distinct track indices for timeline rendering (overlay tracks)
  const overlayTrackIdxs = useMemo(() => {
    const s = new Set(overlayList.map((c) => c.track_idx))
    return Array.from(s).sort((a, b) => b - a) // higher first (top of timeline)
  }, [overlayList])

  // Inject Google Fonts <link> once — covers all FONT_OPTIONS in a single
  // request. Without this the font dropdown picks the family but the browser
  // falls back to Inter because the family isn't loaded.
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (document.getElementById('editor-google-fonts')) return
    const families = FONT_OPTIONS.map((f) => f.google).filter(Boolean).map((g) => `family=${g}`).join('&')
    const link = document.createElement('link')
    link.id = 'editor-google-fonts'
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`
    document.head.appendChild(link)
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">✂️ Editor <span className="text-xs text-[var(--muted2)] font-normal">v4 multi-track</span></h1>
          <p className="text-xs text-[var(--muted)]">Multi-track stacking · B-roll overlay · Transitions · Filters · Subtitle · MP4</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={project.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Project name"
            className="text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] w-48" />
          <select value={project.persona_id || ''} onChange={(e) => patch({ persona_id: e.target.value || null })}
            className="text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
            title="Tag this project ke persona — auto group di /qc">
            <option value="">🎭 — pilih persona —</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>{p.name} {p.username ? `(@${p.username})` : ''}</option>
            ))}
          </select>
          <button onClick={undo} disabled={historyRef.current.past.length === 0} title="Undo (Ctrl+Z)" className="px-2 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)] disabled:opacity-30">↶</button>
          <button onClick={redo} disabled={historyRef.current.future.length === 0} title="Redo (Ctrl+Y / Ctrl+Shift+Z)" className="px-2 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)] disabled:opacity-30">↷</button>
          <button onClick={splitClipAtPlayhead} disabled={!selected || selected.kind !== 'video'} title="Split clip at playhead (S)" className="px-2 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)] disabled:opacity-30">✂ Split</button>
          <button onClick={newProject} className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)]">+ New</button>
          <button onClick={cloneProject} disabled={project.video_clips.length === 0} title="Clone project as copy" className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)] disabled:opacity-50">📋 Clone</button>
          <button onClick={exportProjectJson} disabled={project.video_clips.length === 0} title="Export project as JSON" className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)] disabled:opacity-50">⬇ JSON</button>
          <button onClick={() => importInputRef.current?.click()} title="Import project from JSON" className="px-3 py-1.5 text-xs rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface2)]">⬆ JSON</button>
          <input ref={importInputRef} type="file" accept="application/json" className="hidden" onChange={importProjectJson} />
          <button onClick={saveProject} disabled={saving || project.video_clips.length === 0} className="px-3 py-1.5 text-xs rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
            {saving ? '⏳ Save...' : '💾 Save'}
          </button>
          {/* Primary = MP4 (ffmpeg.wasm). Preserves source video stream — no
              double-encode, no canvas drawImage resample, constant frame rate.
              Slower (30-60s for first export, ~10-20s after wasm caches) but
              quality MATCHES the source clips. Fast is kept as a secondary
              "draft" option for quick QC previews where quality doesn't matter. */}
          <button onClick={() => exportVideo('mp4')} disabled={exporting || project.video_clips.length === 0}
            title="ffmpeg.wasm MP4 — preserves source video quality, constant frame rate. Use for anything you actually post."
            className="px-4 py-1.5 text-xs font-bold rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
            {exporting ? `⏳ Rendering...` : `🎬 Export → QC (${totalDur.toFixed(1)}s)`}
          </button>
          <button onClick={() => exportVideo('fast')} disabled={exporting || project.video_clips.length === 0}
            title="Canvas real-time — fastest but re-encodes everything (quality loss + frame-drop risk). Draft only."
            className="px-3 py-1.5 text-xs font-semibold rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
            ⚡ Draft (fast)
          </button>
        </div>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}
      {exporting && exportProgress && <div className="text-xs text-orange-400 bg-orange-900/20 border border-orange-700/40 p-3 rounded whitespace-pre-wrap">⏳ {exportProgress}</div>}
      {!exporting && exportProgress.startsWith('✓') && <div className="text-xs text-green-400 bg-green-900/20 border border-green-700/40 p-3 rounded">{exportProgress}</div>}
      {transcribeProgress && (
        <div className={`text-xs p-3 rounded border ${transcribeProgress.startsWith('✓') ? 'text-green-400 bg-green-900/20 border-green-700/40' : 'text-pink-300 bg-pink-900/20 border-pink-700/40'}`}>
          {transcribing ? '⏳ ' : ''}{transcribeProgress}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr_310px] gap-3" style={{ minHeight: 700 }}>
        {/* LEFT */}
        <div className="space-y-3">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">+ Tambah video clip</div>
              <button onClick={() => videoInputRef.current?.click()} disabled={!!uploadingVideo}
                className="text-[10px] px-2 py-1 rounded bg-cyan-500/30 border border-cyan-500/60 hover:bg-cyan-500/50 text-cyan-200 font-bold disabled:opacity-50"
                title="Upload video dari file manager">
                {uploadingVideo ? '⏳' : '📤 Upload'}
              </button>
              <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={onVideoFile} />
            </div>
            {uploadingVideo && (
              <div className="text-[9px] text-cyan-300 bg-cyan-900/20 border border-cyan-700/40 rounded px-1.5 py-1 mb-2">
                ⏳ {uploadingVideo.stage === 'inserting' ? 'Saving...' : `Uploading ${uploadingVideo.name} (${uploadingVideo.sizeMB}MB)`}
              </div>
            )}
            <div className="space-y-2 max-h-72 overflow-auto">
              {videoSources.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)] p-2">Belum ada video. Klik <strong>📤 Upload</strong> atau gen di /generate.</div>
              ) : videoSources.map((r) => (
                <div key={r.id} className="bg-[var(--surface2)] rounded p-1.5 border border-[var(--border)] group relative">
                  {/* Delete button — small ✕ at top-right corner, only visible on hover */}
                  <button onClick={() => deleteVideoSource(r)}
                    className="absolute top-1 right-1 text-[10px] w-5 h-5 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/60 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center font-bold z-10"
                    title="Hapus video ini dari workspace">
                    ✕
                  </button>
                  <div className="flex gap-2 mb-1.5">
                    <video src={proxify(r.url)} muted className="w-10 aspect-[9/16] object-cover rounded bg-black flex-shrink-0" />
                    <div className="min-w-0 flex-1 pr-5">
                      <div className="text-[11px] font-semibold truncate flex items-center gap-1">
                        {r.label || 'untitled'}
                        {r.meta?.cloned_audio_url && <span title={`Voice cloned: ${r.meta?.voice_name || 'cloned'}`} className="text-[8px] px-1 rounded bg-green-500/30 text-green-200 font-bold">🎙</span>}
                      </div>
                      <div className="text-[9px] text-[var(--muted)] truncate">{r.personas?.name || '—'}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <button onClick={() => addVideoClip(r, false)}
                      className="text-[10px] px-1.5 py-1 rounded bg-[var(--accent)]/30 border border-[var(--accent)]/60 text-white hover:bg-[var(--accent)]/50 font-semibold"
                      title="Append to base track (sequential)">
                      📹 Base
                    </button>
                    <button onClick={() => addVideoClip(r, true)} disabled={baseClips.length === 0}
                      className="text-[10px] px-1.5 py-1 rounded bg-yellow-500/30 border border-yellow-500/60 text-yellow-200 hover:bg-yellow-500/50 font-semibold disabled:opacity-50"
                      title="Add as B-roll overlay (picture-in-picture)">
                      🎬 B-roll
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="text-[9px] text-[var(--muted2)] mt-1.5 px-1">
              <strong>📹 Base</strong>: full-frame sequential.<br />
              <strong>🎬 B-roll</strong>: overlay PiP, layered on top.
            </div>
          </div>

          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-1">+ Overlay & audio</div>
            <button onClick={() => autoSubtitle({ karaoke: false })} disabled={transcribing || baseClips.length === 0}
              className="w-full text-xs px-2 py-1.5 rounded bg-gradient-to-r from-pink-500 to-purple-500 hover:opacity-90 text-white font-bold disabled:opacity-50">
              {transcribing ? '⏳ Transcribing...' : `✨ Auto-subtitle (${baseClips.length} clip)`}
            </button>
            <button onClick={() => autoSubtitle({ karaoke: true })} disabled={transcribing || baseClips.length === 0}
              className="w-full text-xs px-2 py-1.5 rounded bg-gradient-to-r from-yellow-400 to-pink-500 hover:opacity-90 text-white font-bold disabled:opacity-50">
              🎤 Karaoke subtitle (word-level)
            </button>
            <button onClick={applyTikTokStyle} disabled={!project.text_clips.length}
              className="w-full text-xs px-2 py-1.5 rounded bg-pink-500/20 border border-pink-500/40 hover:bg-pink-500/30 text-pink-200 disabled:opacity-50">
              🔥 TikTok style ke {project.text_clips.length} text
            </button>
            <button onClick={addTextClip} disabled={!project.video_clips.length} className="w-full text-xs px-2 py-1.5 rounded bg-purple-500/20 border border-purple-500/40 hover:bg-purple-500/30 text-purple-200 disabled:opacity-50">📝 + Text overlay</button>
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
            <div className="relative mx-auto bg-black rounded overflow-hidden" style={{ maxWidth: 360 }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
              onDrop={(e) => {
                e.preventDefault()
                const file = e.dataTransfer.files?.[0]
                if (!file) return
                // Inject ke video file input handler
                const synthetic = { target: { files: [file], value: '' } }
                onVideoFile(synthetic)
              }}>
              <div className={`${aspectClass} relative w-full`}>
                {/* Base video — transform = zoom + pan, applied via inline style.
                    Inline so onDrag callbacks (trim, zoom, pan) can mutate
                    directly via ref without setState. */}
                <video ref={baseVideoRef} className="w-full h-full object-contain" playsInline crossOrigin="anonymous" muted={false}
                  style={{
                    filter: baseFilter,
                    transform: baseTransform,
                    transformOrigin: baseTransformOrigin,
                  }} />

                {/* Hidden audio elements — one per clip with cloned voice, plus BGM.
                    The render/preview engines reach these by ref to swap native
                    audio for the persona's cloned voice (lip-sync preserved). */}
                {project.video_clips.filter((c) => c.cloned_audio_url).map((c) => (
                  <audio key={'cv-' + c.id} src={proxify(c.cloned_audio_url)} preload="auto" crossOrigin="anonymous"
                    ref={(el) => { if (el) clonedAudioRefs.current.set(c.id, el); else clonedAudioRefs.current.delete(c.id) }} />
                ))}
                {project.audio_clips?.[0]?.src_url && (
                  <audio ref={bgmAudioRef} src={proxify(project.audio_clips[0].src_url)} preload="auto" crossOrigin="anonymous"
                    loop={false} />
                )}

                {/* Overlay videos (B-roll).
                    preload="metadata" prevents the browser from eagerly
                    decoding every overlay's frame data at mount. Without this
                    a project with 5+ overlays would have all of them buffering
                    + decoding in the background even when only one is
                    visible — that's the preview-lag root cause. The browser
                    upgrades preload to "auto" once .play() is called. */}
                {overlayList.map((c) => {
                  const isActive = currentTime >= (c.in_track || 0) && currentTime < (c.in_track || 0) + clipDuration(c)
                  const on = selected?.kind === 'video' && selected.id === c.id
                  const pos = c.position || DEFAULT_POSITION
                  return (
                    <video key={c.id} ref={(el) => { if (el) overlayRefs.current.set(c.id, el); else overlayRefs.current.delete(c.id) }}
                      src={proxify(c.src_url)} crossOrigin="anonymous" muted={!isActive}
                      preload="metadata"
                      onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'video', id: c.id }) }}
                      style={{
                        position: 'absolute', left: `${pos.x_pct}%`, top: `${pos.y_pct}%`,
                        transform: 'translate(-50%, -50%)', width: `${pos.w_pct}%`, opacity: isActive ? (pos.opacity ?? 1) : 0,
                        pointerEvents: isActive ? 'auto' : 'none', cursor: 'pointer',
                        outline: on ? '2px solid var(--accent)' : 'none', zIndex: c.track_idx + 5,
                        filter: overlayFilter(c),
                      }} />
                  )
                })}

                {/* Image overlays */}
                {project.image_clips.map((c) => {
                  if (currentTime < c.start || currentTime > c.end) return null
                  const on = selected?.kind === 'image' && selected.id === c.id
                  return (
                    <img key={c.id} src={proxify(c.src_url)} alt=""
                      onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'image', id: c.id }) }}
                      style={{
                        position: 'absolute', left: `${c.x_pct}%`, top: `${c.y_pct}%`,
                        transform: 'translate(-50%, -50%)', width: `${c.w_pct}%`, opacity: c.opacity,
                        outline: on ? '2px solid var(--accent)' : 'none', cursor: 'pointer', pointerEvents: 'auto', zIndex: 50,
                      }} />
                  )
                })}

                {/* Text overlays — supports fade, pop, karaoke (word-level highlight) */}
                {project.text_clips.map((c) => {
                  if (currentTime < c.start || currentTime > c.end) return null
                  const on = selected?.kind === 'text' && selected.id === c.id
                  const animDur = 0.25
                  let opacity = 1, popScale = 1
                  if (c.animation === 'fade') {
                    const sinceStart = currentTime - c.start
                    const tillEnd = c.end - currentTime
                    if (sinceStart < animDur) opacity = sinceStart / animDur
                    else if (tillEnd < animDur) opacity = tillEnd / animDur
                  } else if (c.animation === 'pop') {
                    const sinceStart = currentTime - c.start
                    if (sinceStart < animDur) {
                      const p = sinceStart / animDur
                      popScale = 0.5 + p * 0.5 + Math.sin(p * Math.PI) * 0.15
                      opacity = p
                    }
                  }
                  // Karaoke: highlight current word(s) in different color
                  const isKaraoke = c.animation === 'karaoke' && Array.isArray(c.words) && c.words.length > 0
                  // Zoom = pure CSS transform scale. Doesn't touch wrap calc.
                  const userScale = c.scale ?? 1
                  const finalScale = popScale * userScale
                  // CRITICAL: wrap is computed in JS using canvas measureText
                  // against the EXPORT frame width — exactly what the canvas
                  // render will do. We then render the preview as pre-formatted
                  // text (whiteSpace: 'pre') joined by \n so CSS DOESN'T
                  // re-wrap based on its own pane width. This is the only
                  // way to guarantee preview line breaks == export line breaks
                  // across different absolute pixel widths.
                  const wrappedLines = isKaraoke ? null : computeTextLines(c, project.ar)
                  return (
                    <div key={c.id} onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'text', id: c.id }) }}
                      style={{
                        position: 'absolute', left: `${c.x_pct}%`, top: `${c.y_pct}%`,
                        transform: `translate(-50%, -50%) scale(${finalScale})`,
                        color: c.color, fontWeight: c.weight, fontSize: `${c.size * 0.4}px`,
                        fontFamily: getFontCss(c.font || DEFAULT_FONT),
                        background: c.bg, padding: '4px 10px', borderRadius: 4, textAlign: c.align,
                        // pre = respect explicit \n from our wrap (no CSS auto-wrap that
                        // would re-break the text based on the preview pane's CSS pixel width).
                        whiteSpace: 'pre', cursor: 'pointer',
                        textShadow: c.effects ? composeTextShadow(c.effects) : '0 1px 3px rgba(0,0,0,0.8)',
                        WebkitTextStroke: c.effects?.stroke?.enabled
                          ? `${c.effects.stroke.width * 0.4}px ${c.effects.stroke.color}`
                          : 'initial',
                        paintOrder: 'stroke fill',
                        outline: on ? '2px solid var(--accent)' : 'none',
                        opacity, zIndex: 100,
                      }}>
                      {isKaraoke ? c.words.map((w, i) => {
                        const active = currentTime >= w.start && currentTime <= w.end
                        return (
                          <span key={i} style={{ color: active ? '#fbbf24' : c.color, transition: 'color 0.05s' }}>
                            {w.word}{i < c.words.length - 1 ? ' ' : ''}
                          </span>
                        )
                      }) : (wrappedLines || ['']).join('\n')}
                    </div>
                  )
                })}

                {baseInfo && (
                  <div className="absolute bottom-1 left-1 text-[9px] bg-black/70 text-white px-1.5 py-0.5 rounded z-[200]">
                    Base {baseInfo.index + 1}/{baseClips.length}
                    {activeOverlaysList.length > 0 && ` · +${activeOverlaysList.length} overlay`}
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
            <Timeline project={project} baseClips={baseClips} overlayList={overlayList} overlayTrackIdxs={overlayTrackIdxs}
              totalDur={totalDur} currentTime={currentTime}
              selected={selected} onSelect={setSelected} onSeek={seekTo} onUpdateClip={updateClip}
              onDeleteClip={removeVideoClip} />
          )}
        </div>

        {/* RIGHT */}
        <div className="space-y-3">
          {selected?.kind === 'video' ? (
            <VideoClipPanel clip={project.video_clips.find((c) => c.id === selected.id)}
              onUpdate={(p) => updateClip('video', selected.id, p)} onDelete={() => removeVideoClip(selected.id)}
              isBase={project.video_clips.find((c) => c.id === selected.id)?.track_idx === 0}
              isFirst={baseClips[0]?.id === selected.id}
              totalDur={totalDur}
              previewSeek={(srcTime) => {
                // Direct DOM seek (no setState) — used by trim sliders so the
                // video frame follows the slider live during drag.
                const v = baseVideoRef.current
                if (v) v.currentTime = Math.max(0, srcTime)
              }}
              previewTransform={(zoom, panX, panY) => {
                // Direct style mutation for live zoom/pan preview during slider
                // drag. Bypasses React render entirely.
                const v = baseVideoRef.current
                if (!v) return
                v.style.transform = zoom > 1 ? `scale(${zoom})` : ''
                v.style.transformOrigin = zoom > 1 ? `${panX}% ${panY}%` : ''
              }} />
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
              {baseClips.length} base · {overlayList.length} overlay · {project.text_clips.length} text · {project.image_clips.length} img · {project.audio_clips.length} music
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

function Timeline({ project, baseClips, overlayList, overlayTrackIdxs, totalDur, currentTime, selected, onSelect, onSeek, onUpdateClip, onDeleteClip }) {
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
      if (kind === 'clipMove' && clipKind === 'video') {
        const c = startClip
        const dur = clipDuration(c)
        const dx = (ev.clientX - origin.x) / rect.width * totalDur
        const ns = Math.max(0, Math.min(Math.max(0, totalDur - dur), (c.in_track || 0) + dx))
        // VERTICAL drag — change track_idx based on cursor Y over track rows
        const dy = ev.clientY - rect.top
        const TRACK_H = 32 // approx per-row height
        const totalOverlayRows = (project.video_clips || []).filter((x) => (x.track_idx || 0) > 0).reduce((s, x) => Math.max(s, x.track_idx || 0), 0)
        // Row layout: 0 = top overlay, increasing down; base is below overlays.
        // For simplicity: top half of timeline = overlay (track 1+), bottom = base (track 0)
        const baseRowY = (totalOverlayRows + 0.5) * TRACK_H + 8
        let newTrackIdx = c.track_idx || 0
        if (dy > baseRowY) newTrackIdx = 0
        else {
          // overlay row index from top
          const overlayRowIdx = Math.max(1, Math.min(totalOverlayRows + 1, Math.ceil((dy - 4) / TRACK_H)))
          newTrackIdx = totalOverlayRows + 1 - overlayRowIdx + 1 // top row = highest track_idx
          if (totalOverlayRows === 0) newTrackIdx = 1
        }
        const updates = { in_track: ns }
        if (newTrackIdx !== (c.track_idx || 0)) {
          updates.track_idx = newTrackIdx
          // If converting base -> overlay, ensure position exists with default
          if ((c.track_idx || 0) === 0 && newTrackIdx > 0) {
            updates.position = { x_pct: 75, y_pct: 25, w_pct: 35, opacity: 1 }
          }
        }
        onUpdateClip(clipKind, clipId, updates)
      } else if (kind === 'clipStart' && clipKind === 'video') {
        // Trim video clip in source — drag left edge changes src_in
        const c = startClip
        const dx = (ev.clientX - origin.x) / rect.width * totalDur
        // For BASE clip: keep in_track but adjust src_in (effectively content trim)
        // For OVERLAY: adjust src_in and shift in_track to compensate so visual start stays
        const newSrcIn = Math.max(0, Math.min(c.src_out - 0.2, (c.src_in || 0) + dx * (c.speed || 1)))
        if ((c.track_idx || 0) === 0) {
          onUpdateClip(clipKind, clipId, { src_in: newSrcIn })
        } else {
          onUpdateClip(clipKind, clipId, { src_in: newSrcIn, in_track: Math.max(0, (c.in_track || 0) + dx) })
        }
      } else if (kind === 'clipEnd' && clipKind === 'video') {
        const c = startClip
        const dx = (ev.clientX - origin.x) / rect.width * totalDur
        const newSrcOut = Math.max(c.src_in + 0.2, Math.min(c.src_duration || c.src_out + 100, (c.src_out || 0) + dx * (c.speed || 1)))
        onUpdateClip(clipKind, clipId, { src_out: newSrcOut })
      } else if (kind === 'clipMove' && clipKind !== 'video') {
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

  function clipDuration(c) {
    const len = Math.max(0, (c.src_out ?? 0) - (c.src_in ?? 0))
    return len / Math.max(0.01, c.speed || 1)
  }

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 select-none">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">Timeline · multi-track stacking</div>
        <div className="text-[9px] text-[var(--muted2)]">B-roll on top · drag overlay pill to reposition</div>
      </div>

      <div ref={trackRef} className="relative cursor-pointer" onClick={onTrackClick}>
        {/* Overlay video tracks (rendered top-to-bottom, higher track_idx first) */}
        {overlayTrackIdxs.map((trackIdx) => (
          <div key={`ov-${trackIdx}`} className="flex items-center gap-2 mb-1">
            <div className="w-14 text-[9px] text-yellow-400 font-bold flex-shrink-0">🎬 ov{trackIdx}</div>
            <div className="relative flex-1 h-7 bg-yellow-900/15 rounded">
              {overlayList.filter((c) => c.track_idx === trackIdx).map((c) => {
                const isSel = selected?.kind === 'video' && selected.id === c.id
                const start = c.in_track || 0
                const dur = clipDuration(c)
                return (
                  <div key={c.id}
                    onMouseDown={(e) => { startDrag(e, 'clipMove', 'video', c.id); onSelect({ kind: 'video', id: c.id }) }}
                    onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'video', id: c.id }) }}
                    className={`absolute top-0.5 bottom-0.5 rounded text-[9px] text-white font-semibold flex items-center px-1.5 cursor-grab bg-yellow-600 ${isSel ? 'ring-2 ring-white' : ''}`}
                    style={{ left: `${timeToPct(start)}%`, width: `${Math.max(2, timeToPct(dur))}%` }}
                    title={c.src_label}>
                    <div onMouseDown={(e) => startDrag(e, 'clipStart', 'video', c.id)} className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-l" title="Drag = trim start" />
                    <div onMouseDown={(e) => startDrag(e, 'clipEnd', 'video', c.id)} className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-r" title="Drag = trim end" />
                    <span className="truncate px-1 flex-1">🎬 {c.src_label?.slice(0, 14) || '—'}</span>
                    {isSel && <button onClick={(e) => { e.stopPropagation(); onDeleteClip?.(c.id) }}
                      className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center hover:bg-red-600">×</button>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {/* Base video track */}
        <div className="flex items-center gap-2 mb-1.5 border-t border-[var(--border)] pt-1.5">
          <div className="w-14 text-[9px] text-[var(--accent)] font-bold flex-shrink-0">📹 base</div>
          <div className="relative flex-1 h-8 bg-[var(--accent)]/10 rounded">
            {baseClips.map((c, i) => {
              const isSel = selected?.kind === 'video' && selected.id === c.id
              const start = c.in_track || 0
              const dur = clipDuration(c)
              const hasTrans = i > 0 && c.transition_in && c.transition_in.type !== 'cut'
              return (
                <div key={c.id}
                  onMouseDown={(e) => { startDrag(e, 'clipMove', 'video', c.id); onSelect({ kind: 'video', id: c.id }) }}
                  onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'video', id: c.id }) }}
                  className={`absolute top-0.5 bottom-0.5 rounded text-[9px] text-white font-semibold flex items-center px-1.5 cursor-grab bg-[var(--accent)] ${isSel ? 'ring-2 ring-white' : ''}`}
                  style={{ left: `${timeToPct(start)}%`, width: `${Math.max(2, timeToPct(dur))}%` }}
                  title={`${c.src_label} — drag vertically to move between tracks`}>
                  {hasTrans && <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-3 h-3 bg-yellow-400 rounded-full text-black text-[8px] flex items-center justify-center font-bold" title={`${c.transition_in.type} ${c.transition_in.duration}s`}>×</div>}
                  <div onMouseDown={(e) => startDrag(e, 'clipStart', 'video', c.id)} className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-l" title="Drag = trim start" />
                  <div onMouseDown={(e) => startDrag(e, 'clipEnd', 'video', c.id)} className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-r" title="Drag = trim end" />
                  <span className="truncate px-1 flex-1">📹 {i + 1}. {c.src_label?.slice(0, 14) || '—'}</span>
                  {isSel && <button onClick={(e) => { e.stopPropagation(); onDeleteClip?.(c.id) }}
                    className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center hover:bg-red-600">×</button>}
                </div>
              )
            })}
          </div>
        </div>

        {/* Overlay tracks (image/text/audio). Each kind splits into MULTIPLE
            rows by track_idx so clips that overlap in TIME render on separate
            visual rows — no more crashing into a confusing pile of bars.
            Auto-collapses to 1 row when only track 0 is in use. */}
        {[
          { kind: 'image', label: '🖼 img', color: 'bg-blue-900/20', pillBg: 'bg-blue-600' },
          { kind: 'text', label: '📝 txt', color: 'bg-purple-900/20', pillBg: 'bg-purple-600' },
          { kind: 'audio', label: '🎵 aud', color: 'bg-orange-900/20', pillBg: 'bg-orange-600' },
        ].map((trk) => {
          const raw = trk.kind === 'audio'
            ? (project.audio_clips || []).map((c) => ({ ...c, end: c.start + c.duration }))
            : (project[`${trk.kind}_clips`] || [])
          // Group by track_idx, sort ascending. Always show at least row 0 so
          // empty tracks still display a labelled lane (user can drop a clip).
          const trackMap = new Map()
          raw.forEach((c) => {
            const t = c.track_idx || 0
            if (!trackMap.has(t)) trackMap.set(t, [])
            trackMap.get(t).push(c)
          })
          if (!trackMap.has(0)) trackMap.set(0, [])
          const trackIdxs = Array.from(trackMap.keys()).sort((a, b) => a - b)
          return (
            <div key={trk.kind} className="space-y-0.5 mb-1">
              {trackIdxs.map((trkIdx, rowI) => {
                const items = trackMap.get(trkIdx)
                const isFirstRow = rowI === 0
                return (
                  <div key={`${trk.kind}-${trkIdx}`} className="flex items-center gap-2">
                    <div className="w-14 text-[9px] text-[var(--muted)] font-semibold flex-shrink-0">
                      {isFirstRow ? trk.label : ''}
                      {trackIdxs.length > 1 && <span className="ml-1 opacity-60">{trkIdx}</span>}
                    </div>
                    <div className={`relative flex-1 h-6 ${trk.color} rounded`}>
                      {items.map((c) => {
                        const isSel = selected?.kind === trk.kind && selected.id === c.id
                        return (
                          <div key={c.id}
                            onMouseDown={(e) => { startDrag(e, 'clipMove', trk.kind, c.id); onSelect({ kind: trk.kind, id: c.id }) }}
                            onClick={(e) => { e.stopPropagation(); onSelect({ kind: trk.kind, id: c.id }) }}
                            className={`absolute top-0.5 bottom-0.5 rounded text-[9px] text-white font-semibold flex items-center px-1.5 cursor-grab overflow-hidden ${trk.pillBg} ${isSel ? 'ring-2 ring-white' : ''}`}
                            style={{ left: `${timeToPct(c.start)}%`, width: `${Math.max(2, timeToPct(c.end - c.start))}%` }}>
                            {/* Audio: render waveform in background */}
                            {trk.kind === 'audio' && c.src_url && (
                              <div className="absolute inset-0 opacity-50 pointer-events-none">
                                <AudioWaveform url={c.src_url} color="rgba(255,255,255,0.7)" />
                              </div>
                            )}
                            <div onMouseDown={(e) => startDrag(e, 'clipStart', trk.kind, c.id)} className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-l z-10" />
                            <div onMouseDown={(e) => startDrag(e, 'clipEnd', trk.kind, c.id)} className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/30 cursor-ew-resize rounded-r z-10" />
                            <span className="truncate px-1 relative z-10">{trk.kind === 'text' ? `📝 ${c.text?.slice(0, 10)}` : trk.kind === 'image' ? `🖼 ${c.src_name?.slice(0, 10)}` : `🎵 ${c.src_name?.slice(0, 10)}`}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}

        {/* Playhead */}
        <div className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none" style={{ left: `calc(56px + (100% - 56px) * ${timeToPct(currentTime) / 100})` }}>
          <div className="absolute -top-1 -left-1 w-2 h-2 bg-red-500 rounded-full" />
        </div>
      </div>

      <div className="relative h-3 mt-1 ml-14">
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
          <span key={i} className="absolute text-[9px] text-[var(--muted)] font-mono" style={{ left: `${p * 100}%`, transform: 'translateX(-50%)' }}>
            {(p * totalDur).toFixed(1)}s
          </span>
        ))}
      </div>
    </div>
  )
}

function VideoClipPanel({ clip, isBase, isFirst, totalDur, onUpdate, onDelete, previewSeek, previewTransform }) {
  if (!clip) return null
  const updFilter = (k, v) => onUpdate({ filters: { ...clip.filters, [k]: v } })
  const updTrans = (k, v) => onUpdate({ transition_in: { ...clip.transition_in, [k]: v } })
  const updPos = (k, v) => onUpdate({ position: { ...clip.position, [k]: v } })
  const zoom = clip.zoom ?? 1
  const panX = clip.pan_x_pct ?? 50
  const panY = clip.pan_y_pct ?? 50
  // For onDrag callbacks — directly mutate preview without setState.
  function dragZoom(v) { previewTransform?.(v, panX, panY) }
  function dragPanX(v) { previewTransform?.(zoom, v, panY) }
  function dragPanY(v) { previewTransform?.(zoom, panX, v) }
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold">
          {isBase ? <span className="text-[var(--accent)]">📹 Base clip</span> : <span className="text-yellow-400">🎬 B-roll overlay (track {clip.track_idx})</span>}
        </div>
        <button onClick={onDelete} className="text-[10px] px-1.5 py-0.5 rounded text-red-400 hover:bg-[var(--surface2)]">Hapus</button>
      </div>
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_label}</div>

      {!isBase && (
        <Field label={`Mulai di: ${(clip.in_track || 0).toFixed(2)}s`}>
          <LiveRange min={0} max={totalDur || 30} step={0.05} value={clip.in_track || 0}
            onCommit={(v) => onUpdate({ in_track: v })} />
        </Field>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">✂️ Trim</div>
        {(clip.src_in !== 0 || clip.src_out !== clip.src_duration) && (
          <button onClick={() => onUpdate({ src_in: 0, src_out: clip.src_duration })}
            className="text-[10px] text-[var(--accent)] hover:underline" title="Reset to full clip">
            ↺ Reset trim
          </button>
        )}
      </div>
      <Field label={`Trim in: ${(clip.src_in || 0).toFixed(2)}s`}>
        <LiveRange min={0} max={clip.src_duration} step={0.05} value={clip.src_in}
          onDrag={isBase ? (v) => previewSeek?.(v) : undefined}
          onCommit={(v) => onUpdate({ src_in: v })} />
      </Field>
      <Field label={`Trim out: ${(clip.src_out || 0).toFixed(2)}s of ${clip.src_duration?.toFixed(1)}s`}>
        <LiveRange min={0} max={clip.src_duration} step={0.05} value={clip.src_out}
          onDrag={isBase ? (v) => previewSeek?.(v) : undefined}
          onCommit={(v) => onUpdate({ src_out: v })} />
      </Field>
      <Field label={`Speed: ${clip.speed}x`}>
        <LiveRange min={0.25} max={3} step={0.05} value={clip.speed} onCommit={(v) => onUpdate({ speed: v })} />
      </Field>
      <Field label="Speed ramp (linear in→out)">
        <div className="grid grid-cols-2 gap-1">
          <input type="number" step={0.05} min={0.25} max={3} placeholder="In" value={clip.speed_in ?? ''}
            onChange={(e) => onUpdate({ speed_in: e.target.value === '' ? null : parseFloat(e.target.value) })}
            className="w-full text-xs px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)]" />
          <input type="number" step={0.05} min={0.25} max={3} placeholder="Out" value={clip.speed_out ?? ''}
            onChange={(e) => onUpdate({ speed_out: e.target.value === '' ? null : parseFloat(e.target.value) })}
            className="w-full text-xs px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)]" />
        </div>
        <div className="text-[9px] text-[var(--muted2)] mt-0.5">Kosong = constant speed (use ↑). Isi = ramp linear dari In ke Out.</div>
      </Field>
      <Field label={`Volume: ${Math.round(clip.volume * 100)}%`}>
        <LiveRange min={0} max={1.5} step={0.05} value={clip.volume} onCommit={(v) => onUpdate({ volume: v })} />
      </Field>

      {/* Zoom + Pan — base clip only. Crop a window from source, scale back to
          canvas. Pan X/Y = focus point inside the source (0% = left/top,
          100% = right/bottom, 50% = center). */}
      {isBase && (
        <div className="pt-2 border-t border-[var(--border)]">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase font-semibold text-cyan-400">🔍 Zoom + Pan</div>
            {(zoom !== 1 || panX !== 50 || panY !== 50) && (
              <button onClick={() => { onUpdate({ zoom: 1, pan_x_pct: 50, pan_y_pct: 50 }); previewTransform?.(1, 50, 50) }}
                className="text-[10px] text-[var(--accent)] hover:underline">↺ Reset</button>
            )}
          </div>
          <Field label={`Zoom: ${zoom.toFixed(2)}x`}>
            <LiveRange min={1} max={4} step={0.05} value={zoom}
              onDrag={dragZoom}
              onCommit={(v) => onUpdate({ zoom: v })} />
          </Field>
          {zoom > 1 && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Pan X: ${Math.round(panX)}%`}>
                <LiveRange min={0} max={100} step={1} value={panX}
                  onDrag={dragPanX}
                  onCommit={(v) => onUpdate({ pan_x_pct: Math.round(v) })} />
              </Field>
              <Field label={`Pan Y: ${Math.round(panY)}%`}>
                <LiveRange min={0} max={100} step={1} value={panY}
                  onDrag={dragPanY}
                  onCommit={(v) => onUpdate({ pan_y_pct: Math.round(v) })} />
              </Field>
            </div>
          )}
          {zoom > 1 && (
            <div className="grid grid-cols-3 gap-1 mt-1.5">
              <button onClick={() => { onUpdate({ pan_x_pct: 25, pan_y_pct: 25 }); previewTransform?.(zoom, 25, 25) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↖ TL</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 50, pan_y_pct: 25 }); previewTransform?.(zoom, 50, 25) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↑ Top</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 75, pan_y_pct: 25 }); previewTransform?.(zoom, 75, 25) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↗ TR</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 25, pan_y_pct: 50 }); previewTransform?.(zoom, 25, 50) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">← Left</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 50, pan_y_pct: 50 }); previewTransform?.(zoom, 50, 50) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">⊙ Center</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 75, pan_y_pct: 50 }); previewTransform?.(zoom, 75, 50) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">→ Right</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 25, pan_y_pct: 75 }); previewTransform?.(zoom, 25, 75) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↙ BL</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 50, pan_y_pct: 75 }); previewTransform?.(zoom, 50, 75) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↓ Btm</button>
              <button onClick={() => { onUpdate({ pan_x_pct: 75, pan_y_pct: 75 }); previewTransform?.(zoom, 75, 75) }} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↘ BR</button>
            </div>
          )}
        </div>
      )}

      {/* Cloned voice — present when result has cloned_audio_url. Lets user
          swap native AI audio for the persona's voice (timing preserved). */}
      {clip.cloned_audio_url && (
        <div className="pt-2 border-t border-[var(--border)]">
          <div className="text-[10px] uppercase font-semibold text-green-400 mb-1.5">🎙 Cloned Voice</div>
          <div className="text-[10px] text-[var(--muted2)] mb-1.5">
            Voice cloned: <strong className="text-green-300">{clip.voice_name || 'cloned'}</strong>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={clip.use_cloned_voice !== false}
              onChange={(e) => onUpdate({ use_cloned_voice: e.target.checked })} className="w-4 h-4" />
            <span className="text-xs">Pake cloned voice (mute native audio)</span>
          </label>
          <audio src={proxify(clip.cloned_audio_url)} controls className="w-full h-8 mt-1.5" />
          <div className="text-[9px] text-[var(--muted2)] mt-1 leading-relaxed">
            ⚠️ Preview disini cuma play audio cloned-nya. Render final + sync sama video belum di-wire ke pipeline editor — masih TODO.
          </div>
        </div>
      )}

      {!isBase && (
        <div className="pt-2 border-t border-[var(--border)]">
          <div className="text-[10px] uppercase font-semibold text-yellow-400 mb-1.5">📍 Position (Picture-in-Picture)</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={`X: ${clip.position.x_pct}%`}>
              <LiveRange min={0} max={100} step={1} value={clip.position.x_pct} onCommit={(v) => updPos('x_pct', Math.round(v))} />
            </Field>
            <Field label={`Y: ${clip.position.y_pct}%`}>
              <LiveRange min={0} max={100} step={1} value={clip.position.y_pct} onCommit={(v) => updPos('y_pct', Math.round(v))} />
            </Field>
          </div>
          <Field label={`Width: ${clip.position.w_pct}%`}>
            <LiveRange min={10} max={400} step={1} value={clip.position.w_pct} onCommit={(v) => updPos('w_pct', Math.round(v))} />
          </Field>
          <Field label={`Opacity: ${Math.round(clip.position.opacity * 100)}%`}>
            <LiveRange min={0} max={1} step={0.05} value={clip.position.opacity} onCommit={(v) => updPos('opacity', v)} />
          </Field>
          <div className="grid grid-cols-3 gap-1 mt-2">
            <button onClick={() => onUpdate({ position: { ...clip.position, x_pct: 25, y_pct: 25, w_pct: 40 } })} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↖ TL</button>
            <button onClick={() => onUpdate({ position: { ...clip.position, x_pct: 50, y_pct: 50, w_pct: 60 } })} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">⊕ Center</button>
            <button onClick={() => onUpdate({ position: { ...clip.position, x_pct: 75, y_pct: 25, w_pct: 40 } })} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↗ TR</button>
            <button onClick={() => onUpdate({ position: { ...clip.position, x_pct: 25, y_pct: 75, w_pct: 40 } })} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↙ BL</button>
            <button onClick={() => onUpdate({ position: { ...clip.position, x_pct: 50, y_pct: 50, w_pct: 100, opacity: 1 } })} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">⊟ Full</button>
            <button onClick={() => onUpdate({ position: { ...clip.position, x_pct: 75, y_pct: 75, w_pct: 40 } })} className="text-[9px] px-1 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)]">↘ BR</button>
          </div>
        </div>
      )}

      {isBase && !isFirst && (
        <div className="pt-2 border-t border-[var(--border)]">
          <div className="text-[10px] uppercase font-semibold text-yellow-400 mb-1.5">🎬 Transition (from previous)</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type">
              <select value={clip.transition_in.type} onChange={(e) => updTrans('type', e.target.value)} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
                <option value="cut">Cut (no transition)</option>
                <optgroup label="Fade">
                  <option value="fade">Fade (default)</option>
                  <option value="crossfade">Crossfade</option>
                  <option value="fadeblack">Fade to black</option>
                  <option value="fadewhite">Fade to white</option>
                  <option value="dissolve">Dissolve</option>
                </optgroup>
                <optgroup label="Slide">
                  <option value="slideleft">Slide ←</option>
                  <option value="slideright">Slide →</option>
                  <option value="slideup">Slide ↑</option>
                  <option value="slidedown">Slide ↓</option>
                </optgroup>
                <optgroup label="Wipe">
                  <option value="wipeleft">Wipe ←</option>
                  <option value="wiperight">Wipe →</option>
                  <option value="wipeup">Wipe ↑</option>
                  <option value="wipedown">Wipe ↓</option>
                </optgroup>
                <optgroup label="Circle">
                  <option value="circleopen">Circle open</option>
                  <option value="circleclose">Circle close</option>
                </optgroup>
                <optgroup label="Effect">
                  <option value="zoomin">Zoom in</option>
                  <option value="pixelize">Pixelize</option>
                  <option value="radial">Radial</option>
                  <option value="hblur">Horizontal blur</option>
                </optgroup>
              </select>
            </Field>
            <Field label={`Duration: ${clip.transition_in.duration}s`}>
              <LiveRange min={0.1} max={2} step={0.1} value={clip.transition_in.duration} onCommit={(v) => updTrans('duration', v)} disabled={clip.transition_in.type === 'cut'} />
            </Field>
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--border)]">
        <div className="text-[10px] uppercase font-semibold text-cyan-400 mb-1.5">🎨 Filters</div>
        <Field label={`Brightness: ${clip.filters.brightness > 0 ? '+' : ''}${(clip.filters.brightness * 100).toFixed(0)}%`}>
          <LiveRange min={-0.5} max={0.5} step={0.05} value={clip.filters.brightness} onCommit={(v) => updFilter('brightness', v)} />
        </Field>
        <Field label={`Contrast: ${clip.filters.contrast.toFixed(2)}x`}>
          <LiveRange min={0.5} max={2} step={0.05} value={clip.filters.contrast} onCommit={(v) => updFilter('contrast', v)} />
        </Field>
        <Field label={`Saturation: ${clip.filters.saturation.toFixed(2)}x`}>
          <LiveRange min={0} max={3} step={0.05} value={clip.filters.saturation} onCommit={(v) => updFilter('saturation', v)} />
        </Field>
        <Field label={`Blur: ${clip.filters.blur}px`}>
          <LiveRange min={0} max={20} step={1} value={clip.filters.blur} onCommit={(v) => updFilter('blur', Math.round(v))} />
        </Field>
      </div>
    </div>
  )
}

function TextPanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">📝 Text overlay</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <Field label="Text">
        <textarea value={clip.text} onChange={(e) => onUpdate({ text: e.target.value })} rows={2} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`Start: ${clip.start.toFixed(2)}s`}>
          <LiveRange min={0} max={duration} step={0.05} value={clip.start} onCommit={(v) => onUpdate({ start: v })} />
        </Field>
        <Field label={`End: ${clip.end.toFixed(2)}s`}>
          <LiveRange min={0} max={duration} step={0.05} value={clip.end} onCommit={(v) => onUpdate({ end: v })} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {/* onDrag fires every slider tick → realtime preview while dragging.
            onCommit still fires on release for the final snap. */}
        <Field label={`X: ${clip.x_pct}%`}><LiveRange min={0} max={100} step={1} value={clip.x_pct} onDrag={(v) => onUpdate({ x_pct: Math.round(v) })} onCommit={(v) => onUpdate({ x_pct: Math.round(v) })} /></Field>
        <Field label={`Y: ${clip.y_pct}%`}><LiveRange min={0} max={100} step={1} value={clip.y_pct} onDrag={(v) => onUpdate({ y_pct: Math.round(v) })} onCommit={(v) => onUpdate({ y_pct: Math.round(v) })} /></Field>
      </div>
      {/* Size = the FONT SIZE driving wrap behavior (bigger = wraps sooner).
          Scale = pure VISUAL zoom on top — doesn't change wrap or line count.
          User asked for these to be separate so they can pump up the visual
          size without the caption breaking into more rows. */}
      <Field label={`Size: ${clip.size}px`}><LiveRange min={16} max={120} step={1} value={clip.size} onDrag={(v) => onUpdate({ size: Math.round(v) })} onCommit={(v) => onUpdate({ size: Math.round(v) })} /></Field>
      <Field label={`Zoom: ${((clip.scale ?? 1) * 100).toFixed(0)}% (pure visual zoom in/out — gak ngubah wrap)`}>
        <LiveRange min={0.3} max={3} step={0.05} value={clip.scale ?? 1}
          onDrag={(v) => onUpdate({ scale: Math.round(v * 100) / 100 })}
          onCommit={(v) => onUpdate({ scale: Math.round(v * 100) / 100 })} />
      </Field>
      {/* Box Width = how much of the frame the wrap budget can use. Default 90.
          Bump UP if text wraps too tight (using only 60% of frame). Bump DOWN
          if you want narrower captions. */}
      <Field label={`Box Width: ${clip.max_width_pct ?? 90}% (lebar wrap — kalo terlalu sempit, naikin)`}>
        <LiveRange min={40} max={100} step={1} value={clip.max_width_pct ?? 90}
          onDrag={(v) => onUpdate({ max_width_pct: Math.round(v) })}
          onCommit={(v) => onUpdate({ max_width_pct: Math.round(v) })} />
      </Field>
      <Field label="Font">
        <select value={clip.font || DEFAULT_FONT} onChange={(e) => onUpdate({ font: e.target.value })}
          style={{ fontFamily: getFontCss(clip.font || DEFAULT_FONT) }}
          className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
          {FONT_OPTIONS.map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>{f.label}</option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Color"><input type="color" value={clip.color} onChange={(e) => onUpdate({ color: e.target.value })} className="w-full h-8 rounded cursor-pointer" /></Field>
        <Field label="BG">
          <select value={clip.bg} onChange={(e) => onUpdate({ bg: e.target.value })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value="transparent">Transparent</option><option value="rgba(0,0,0,0.6)">Black 60%</option>
            <option value="rgba(0,0,0,0.85)">Black 85%</option><option value="rgba(255,255,255,0.85)">White 85%</option>
            <option value="rgba(255,87,87,0.85)">Red</option><option value="rgba(255,193,7,0.85)">Yellow</option>
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
      <Field label="Animation">
        <select value={clip.animation || 'none'} onChange={(e) => onUpdate({ animation: e.target.value === 'none' ? null : e.target.value })} className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
          <option value="none">None (static)</option><option value="fade">Fade in/out</option><option value="pop">Pop (scale + fade)</option>
        </select>
      </Field>

      <EffectsSection
        effects={clip.effects || DEFAULT_EFFECTS}
        onUpdate={(next) => onUpdate({ effects: next })}
      />
    </div>
  )
}

// Effects section — Stroke / Shadow / Glow. Each effect: enable toggle + a
// small grid of inline controls. Picks a preset auto-fills all three with
// nice defaults; user can still customize after.
function EffectsSection({ effects, onUpdate }) {
  const updateEffect = (key, patch) => onUpdate({ ...effects, [key]: { ...effects[key], ...patch } })
  const applyPreset = (k) => { const p = EFFECT_PRESETS[k]; if (p) onUpdate(p) }
  const stroke = effects.stroke || DEFAULT_EFFECTS.stroke
  const shadow = effects.shadow || DEFAULT_EFFECTS.shadow
  const glow = effects.glow || DEFAULT_EFFECTS.glow
  return (
    <div className="border-t border-[var(--border)] pt-2 space-y-2">
      <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">✨ Effects</div>
      <Field label="Style preset (quick fill)">
        <select onChange={(e) => { if (e.target.value) applyPreset(e.target.value); e.target.value = '' }}
          className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
          <option value="">— pilih preset —</option>
          <option value="clean">Clean (no effects)</option>
          <option value="drop">Drop shadow (soft)</option>
          <option value="tiktok">TikTok stroke (thick black outline)</option>
          <option value="neon">Neon glow (cyan)</option>
          <option value="pop3d">3D pop (offset shadow)</option>
          <option value="highlight">Highlight glow (yellow)</option>
        </select>
      </Field>

      {/* Stroke */}
      <div className="bg-[var(--surface2)] rounded p-2 space-y-1.5">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={stroke.enabled} onChange={(e) => updateEffect('stroke', { enabled: e.target.checked })} />
          <span className="text-[11px] font-semibold">Stroke (outline)</span>
        </label>
        {stroke.enabled && (
          <div className="grid grid-cols-[1fr_60px] gap-2 items-center">
            <Field label={`Width: ${stroke.width}px`}>
              <LiveRange min={1} max={12} step={1} value={stroke.width}
                onDrag={(v) => updateEffect('stroke', { width: Math.round(v) })}
                onCommit={(v) => updateEffect('stroke', { width: Math.round(v) })} />
            </Field>
            <Field label="Color">
              <input type="color" value={stroke.color} onChange={(e) => updateEffect('stroke', { color: e.target.value })} className="w-full h-7 rounded cursor-pointer" />
            </Field>
          </div>
        )}
      </div>

      {/* Shadow */}
      <div className="bg-[var(--surface2)] rounded p-2 space-y-1.5">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={shadow.enabled} onChange={(e) => updateEffect('shadow', { enabled: e.target.checked })} />
          <span className="text-[11px] font-semibold">Drop shadow</span>
        </label>
        {shadow.enabled && (
          <div className="space-y-1.5">
            <div className="grid grid-cols-3 gap-1">
              <Field label={`X: ${shadow.x}`}>
                <LiveRange min={-20} max={20} step={1} value={shadow.x}
                  onDrag={(v) => updateEffect('shadow', { x: Math.round(v) })}
                  onCommit={(v) => updateEffect('shadow', { x: Math.round(v) })} />
              </Field>
              <Field label={`Y: ${shadow.y}`}>
                <LiveRange min={-20} max={20} step={1} value={shadow.y}
                  onDrag={(v) => updateEffect('shadow', { y: Math.round(v) })}
                  onCommit={(v) => updateEffect('shadow', { y: Math.round(v) })} />
              </Field>
              <Field label={`Blur: ${shadow.blur}`}>
                <LiveRange min={0} max={30} step={1} value={shadow.blur}
                  onDrag={(v) => updateEffect('shadow', { blur: Math.round(v) })}
                  onCommit={(v) => updateEffect('shadow', { blur: Math.round(v) })} />
              </Field>
            </div>
            <Field label="Color">
              <input type="color" value={hexFromRgba(shadow.color)}
                onChange={(e) => updateEffect('shadow', { color: e.target.value })}
                className="w-full h-7 rounded cursor-pointer" />
            </Field>
          </div>
        )}
      </div>

      {/* Glow */}
      <div className="bg-[var(--surface2)] rounded p-2 space-y-1.5">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={glow.enabled} onChange={(e) => updateEffect('glow', { enabled: e.target.checked })} />
          <span className="text-[11px] font-semibold">Glow (neon / halo)</span>
        </label>
        {glow.enabled && (
          <div className="grid grid-cols-[1fr_60px] gap-2 items-center">
            <Field label={`Blur: ${glow.blur}px`}>
              <LiveRange min={2} max={40} step={1} value={glow.blur}
                onDrag={(v) => updateEffect('glow', { blur: Math.round(v) })}
                onCommit={(v) => updateEffect('glow', { blur: Math.round(v) })} />
            </Field>
            <Field label="Color">
              <input type="color" value={glow.color} onChange={(e) => updateEffect('glow', { color: e.target.value })} className="w-full h-7 rounded cursor-pointer" />
            </Field>
          </div>
        )}
      </div>
    </div>
  )
}

// Color picker only accepts #rrggbb. Strip rgba() → hex for the picker UI;
// alpha is lost but acceptable for the editor controls (user can re-pick).
function hexFromRgba(s) {
  if (!s) return '#000000'
  if (s.startsWith('#')) return s.slice(0, 7)
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return '#000000'
  return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('')
}

function ImagePanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">🖼 Image overlay</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <img src={proxify(clip.src_url)} alt="" className="w-full max-h-24 object-contain bg-black/30 rounded" />
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_name}</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`Start: ${clip.start.toFixed(2)}s`}><LiveRange min={0} max={duration} step={0.05} value={clip.start} onCommit={(v) => onUpdate({ start: v })} /></Field>
        <Field label={`End: ${clip.end.toFixed(2)}s`}><LiveRange min={0} max={duration} step={0.05} value={clip.end} onCommit={(v) => onUpdate({ end: v })} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`X: ${clip.x_pct}%`}><LiveRange min={0} max={100} step={1} value={clip.x_pct} onDrag={(v) => onUpdate({ x_pct: Math.round(v) })} onCommit={(v) => onUpdate({ x_pct: Math.round(v) })} /></Field>
        <Field label={`Y: ${clip.y_pct}%`}><LiveRange min={0} max={100} step={1} value={clip.y_pct} onDrag={(v) => onUpdate({ y_pct: Math.round(v) })} onCommit={(v) => onUpdate({ y_pct: Math.round(v) })} /></Field>
      </div>
      <Field label={`Width: ${clip.w_pct}%`}><LiveRange min={5} max={400} step={1} value={clip.w_pct} onDrag={(v) => onUpdate({ w_pct: Math.round(v) })} onCommit={(v) => onUpdate({ w_pct: Math.round(v) })} /></Field>
      <Field label={`Opacity: ${Math.round(clip.opacity * 100)}%`}><LiveRange min={0} max={1} step={0.05} value={clip.opacity} onDrag={(v) => onUpdate({ opacity: v })} onCommit={(v) => onUpdate({ opacity: v })} /></Field>
    </div>
  )
}

function AudioPanel({ clip, duration, onUpdate, onDelete }) {
  if (!clip) return null
  const srcStart = clip.src_start || 0
  const srcEnd = clip.src_end
  // Probe element max duration via audio.duration once loaded. Until then,
  // bound src_end by a reasonable ceiling so the slider still works.
  const [srcDur, setSrcDur] = useState(srcEnd ?? 300)
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">🎵 Music</div>
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
      <audio src={proxify(clip.src_url)} controls className="w-full"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (d && isFinite(d)) setSrcDur(d) }} />
      <div className="text-[9px] text-[var(--muted)] truncate">{clip.src_name} · sumber {srcDur.toFixed(1)}s</div>
      <Field label={`Mulai di video (delay): ${clip.start.toFixed(2)}s`}>
        <LiveRange min={0} max={duration} step={0.1} value={clip.start} onCommit={(v) => onUpdate({ start: v })} />
      </Field>
      <Field label={`Skip awal lagu: ${srcStart.toFixed(2)}s`}>
        <LiveRange min={0} max={Math.max(0, srcDur - 0.5)} step={0.1} value={srcStart} onCommit={(v) => onUpdate({ src_start: v })} />
        <div className="text-[9px] text-[var(--muted2)] mt-0.5">Crop awal — buang intro lagu sebelum kicks in.</div>
      </Field>
      <Field label={srcEnd != null ? `Potong akhir di: ${srcEnd.toFixed(2)}s` : 'Potong akhir: (tidak ada — main sampai habis)'}>
        <div className="flex items-center gap-2">
          <LiveRange min={Math.min(srcStart + 0.5, srcDur)} max={srcDur} step={0.1}
            value={srcEnd != null ? srcEnd : srcDur}
            onCommit={(v) => onUpdate({ src_end: v >= srcDur - 0.05 ? null : v })} />
          {srcEnd != null && (
            <button onClick={() => onUpdate({ src_end: null })} type="button"
              className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)] whitespace-nowrap">↺ reset</button>
          )}
        </div>
      </Field>
      <Field label={`Volume: ${Math.round(clip.volume * 100)}%`}><LiveRange min={0} max={1.5} step={0.05} value={clip.volume} onCommit={(v) => onUpdate({ volume: v })} /></Field>
      <Field label={`BGM duck saat 🎙 voice main: ${Math.round((clip.bgm_duck ?? 0.25) * 100)}%`}>
        <LiveRange min={0} max={1} step={0.05} value={clip.bgm_duck ?? 0.25} onCommit={(v) => onUpdate({ bgm_duck: v })} />
        <div className="text-[9px] text-[var(--muted2)] mt-0.5">Volume BGM otomatis turun ke level ini saat clip yang pakai cloned voice lagi main.</div>
      </Field>
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

// Local-state range slider with optional drag-preview callback.
//
// Default behaviour: track LOCAL state during drag, commit to parent only on
// mouseUp/touchEnd. Drops React re-renders during drag by ~95%.
//
// onDrag (optional): called on EVERY pixel of drag with the current value.
// Use this for previews that don't need to go through React state — e.g.
// trim sliders directly seek the <video> element via ref so user sees the
// frame at each trim point while dragging. The parent should NOT setState
// in onDrag — direct DOM mutation only.
function LiveRange({ value, onCommit, onDrag, min, max, step, className = 'w-full', disabled }) {
  const [local, setLocal] = useState(value)
  const draggingRef = useRef(false)
  // Sync external value changes (e.g. realtime update from another tab)
  // unless user is actively dragging — don't yank slider from under their finger.
  useEffect(() => { if (!draggingRef.current) setLocal(value) }, [value])
  function start() { draggingRef.current = true }
  function commit(v) {
    draggingRef.current = false
    if (v !== value) onCommit(v)
  }
  return (
    <input type="range" min={min} max={max} step={step} value={local} disabled={disabled}
      onMouseDown={start}
      onTouchStart={start}
      onChange={(e) => {
        const v = parseFloat(e.target.value)
        setLocal(v)
        if (onDrag) onDrag(v) // realtime preview — direct DOM mutation in parent
      }}
      onMouseUp={(e) => commit(parseFloat(e.target.value))}
      onTouchEnd={(e) => commit(parseFloat(e.target.value))}
      onKeyUp={(e) => commit(parseFloat(e.target.value))}
      className={className} />
  )
}
