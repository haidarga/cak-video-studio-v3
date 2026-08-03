'use client'

import { useState, useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import Link from 'next/link'
import { GEN_CONSTRAINTS, defaultConstraints, serializeConstraints } from '@/lib/gen-constraints'

const STATUS_STYLES = {
  pending:    { label: '⏳ Pending',    bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
  in_progress:{ label: '🔄 In Progress',bg: 'bg-blue-500/10', border: 'border-blue-500/30',  text: 'text-blue-400' },
  parsed:     { label: '📋 Parsed',     bg: 'bg-indigo-500/10',border: 'border-indigo-500/30',text: 'text-indigo-400' },
  generating: { label: '⚙️ Generating', bg: 'bg-purple-500/10',border: 'border-purple-500/30',text: 'text-purple-400' },
  done:       { label: '✅ Done',       bg: 'bg-emerald-500/10',border: 'border-emerald-500/30',text: 'text-emerald-400' },
  error:      { label: '❌ Error',      bg: 'bg-red-500/10',   border: 'border-red-500/30',  text: 'text-red-400' },
  cancelled:  { label: '🚫 Cancelled', bg: 'bg-neutral-500/10',border: 'border-neutral-500/30',text: 'text-neutral-400' },
}

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${s.bg} ${s.border} ${s.text}`}>
      {s.label}
    </span>
  )
}

function ShotPreview({ shots }) {
  if (!shots || shots.length === 0) return <span className="text-[var(--muted)] text-xs">No parsed shots</span>

  return (
    <div className="space-y-2 mt-3">
      {shots.map((shot, i) => (
        <div key={i} className="glass rounded-xl p-3 border border-[var(--border)]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-bold text-[var(--fg)]">
              Shot {shot.shot || i + 1}
              {shot.section_key && <span className="ml-1.5 text-[var(--muted)] font-medium">({shot.section_key})</span>}
            </span>
            <span className="text-[10px] text-[var(--muted)] font-mono">{shot.duration || shot.seconds || 5}s</span>
          </div>
          {(shot.dialogue || shot.dialog) && (
            <div className="text-xs text-[var(--fg)] mb-1">
              <span className="text-[var(--muted)] mr-1">🎙</span>
              {shot.speaker && <span className="font-semibold text-[var(--accent)]">{shot.speaker}: </span>}
              {shot.dialogue || shot.dialog}
            </div>
          )}
          {(shot.visual_note || shot.image_prompt) && (
            <div className="text-[11px] text-[var(--muted)]">
              <span className="mr-1">📷</span>{shot.visual_note || shot.image_prompt}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function JobCard({ job, personaMap, expanded, onToggle, onDelete }) {
  const persona = job.persona_mapping || {}
  const studioPersonaName = persona.studio_persona_id
    ? personaMap[persona.studio_persona_id] || 'Unknown'
    : null
  const sourcePersonaName = persona.source_persona_name || 'Unknown'
  const matchType = persona.match_type || 'unmapped'

  const shotCount = job.parsed_shots?.length || 0
  const fmeta = job.format_meta || {}
  const platform = fmeta.platform || 'tiktok'
  const duration = fmeta.target_duration_s || '?'
  const ar = fmeta.aspect_ratio || '9:16'

  const isActionable = ['pending', 'parsed'].includes(job.status)

  return (
    <div className="glass rounded-xl border border-[var(--border)] overflow-hidden transition-all hover:border-[var(--accent)]/40">
      {/* Card header */}
      <div className="w-full text-left px-4 py-3 flex items-start gap-3 transition-colors hover:bg-[var(--glass-hover)]">
        <button onClick={onToggle} className="flex-1 min-w-0 text-left flex items-start gap-3 cursor-pointer">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center text-white text-sm font-bold shadow-sm">
            {sourcePersonaName.charAt(0).toUpperCase()}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-bold text-[var(--fg)] truncate">🎬 {job.title}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)]">
              <span>Source: <span className="text-[var(--fg)] font-semibold capitalize">{job.source}</span>
                {job.brand_name && <> · <span className="text-[var(--accent)]">{job.brand_name}</span></>}
              </span>
              <span>Shots: <span className="font-mono text-[var(--fg)]">{shotCount}</span> · ~{duration}s · {ar} · {platform}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-[11px]">
              <span className="text-[var(--muted)]">Persona:</span>
              <span className="font-semibold text-[var(--fg)]">{sourcePersonaName}</span>
              <span className="text-[var(--muted)]">→</span>
              {matchType === 'auto' ? (
                <span className="text-emerald-400 font-semibold">{studioPersonaName} ✅</span>
              ) : (
                <span className="text-amber-400 font-semibold">⚠️ Unmapped</span>
              )}
            </div>
          </div>
        </button>

        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={job.status} />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-[var(--muted)]">
              {new Date(job.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(job.id) }}
              title="Delete this naskah"
              className="text-[11px] text-[var(--muted)] hover:text-red-400 transition-colors p-1 cursor-pointer"
            >
              🗑 Hapus
            </button>
          </div>
        </div>
      </div>

      {/* Expanded: preview + actions */}
      {expanded && (
        <div className="border-t border-[var(--border)] bg-[rgba(0,0,0,0.15)] px-4 py-3 space-y-3">
          {Object.keys(job.brief_context || {}).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-bold mb-1">Brief Context</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(job.brief_context).map(([k, v]) => (
                  <span key={k} className="text-[11px] text-[var(--fg)] bg-[var(--glass)] px-2 py-0.5 rounded-md border border-[var(--border)]">
                    <span className="text-[var(--muted)]">{k}:</span> {String(v).slice(0, 80)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-bold mb-1">Naskah</div>
            <div className="glass rounded-xl p-3 max-h-40 overflow-y-auto text-xs text-[var(--fg)] whitespace-pre-wrap leading-relaxed border border-[var(--border)]">
              {job.naskah_text}
            </div>
          </div>

          {shotCount > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-bold mb-1">
                Parsed Shots ({shotCount})
              </div>
              <ShotPreview shots={job.parsed_shots} />
            </div>
          )}

          {job.error && (
            <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
              {job.error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            {isActionable && persona.studio_persona_id && (
              <Link
                href={`/generate?studio_job=${job.id}`}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-md hover:scale-[1.02] transition-transform"
              >
                🚀 Open in Generate
              </Link>
            )}
            {isActionable && !persona.studio_persona_id && (
              <span className="text-xs text-amber-400 font-medium">
                ⚠️ Map persona in Settings first
              </span>
            )}
            {job.status === 'done' && job.result_ids?.length > 0 && (
              <Link
                href="/results"
                className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--glass)] border border-[var(--border)] px-3.5 py-1.5 text-xs font-semibold text-[var(--fg)] hover:bg-[var(--glass-hover)] transition-colors"
              >
                📁 View Results ({job.result_ids.length})
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function BatchCard({ batch, personaMap, onDeleteBatch, onDeleteJob, onOpenExecutionModal }) {
  const [expanded, setExpanded] = useState(false)
  const [expandedJobId, setExpandedJobId] = useState(null)

  const { batchId, title, jobs } = batch
  const jobCount = jobs.length
  const personas = [...new Set(jobs.map(j => j.persona_mapping?.source_persona_name || 'Subject'))]
  const pendingJobs = jobs.filter(j => ['pending', 'parsed'].includes(j.status))
  const doneJobs = jobs.filter(j => j.status === 'done')
  const totalShots = jobs.reduce((acc, j) => acc + (j.parsed_shots?.length || 0), 0)

  const isBatchActionable = pendingJobs.length > 0

  return (
    <div className="glass rounded-2xl border border-purple-500/30 overflow-hidden shadow-lg shadow-purple-500/5 transition-all hover:border-purple-500/60">
      {/* Batch Header */}
      <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-purple-900/20 via-background to-pink-900/10 border-b border-[var(--border)]">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center text-white text-xl font-extrabold shadow-md shadow-purple-500/20">
            📦
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-extrabold text-[var(--fg)]">{title}</h3>
              <span className="rounded-full bg-purple-500/20 border border-purple-500/40 px-2.5 py-0.5 text-[11px] font-bold text-purple-300">
                {jobCount} Naskah
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)] mt-1">
              <span>🎯 Personas: <strong className="text-purple-300">{personas.join(', ')}</strong></span>
              <span>·</span>
              <span>🎬 {totalShots} Shots Total</span>
              {pendingJobs.length > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-400 font-semibold">⏳ {pendingJobs.length} Pending</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Batch Action Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--glass)] text-xs font-semibold text-[var(--fg)] hover:bg-[var(--glass-hover)] transition-colors cursor-pointer"
          >
            {expanded ? '▲ Sembunyikan' : `👁 Lihat (${jobCount})`}
          </button>

          {isBatchActionable && (
            <button
              type="button"
              onClick={() => onOpenExecutionModal(batch)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 px-4 py-1.5 text-xs font-bold text-white shadow-md shadow-purple-500/30 hover:scale-[1.02] transition-transform whitespace-nowrap cursor-pointer"
            >
              🚀 Eksekusi All Batch
            </button>
          )}

          <button
            onClick={() => onDeleteBatch(batch)}
            className="px-2.5 py-1.5 rounded-xl border border-red-500/30 bg-red-500/10 text-xs font-semibold text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
            title="Hapus seluruh batch ini"
          >
            🗑 Hapus Batch
          </button>
        </div>
      </div>

      {/* Expanded Jobs List */}
      {expanded && (
        <div className="p-4 space-y-3 bg-[rgba(0,0,0,0.2)]">
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              personaMap={personaMap}
              expanded={expandedJobId === job.id}
              onToggle={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
              onDelete={onDeleteJob}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const STYLE_OPTIONS = [
  { id: 'samsung_a13_candid', label: '📱 Samsung A13 candid (UGC)', desc: 'TikTok UGC, candid handheld phone feel' },
  { id: 'iphone_15_clean', label: '📱 iPhone 15 clean', desc: 'Clean smartphone 4k video, crisp details' },
  { id: 'studio_tvc', label: '🎬 Studio Commercial (TVC)', desc: 'Pro studio softbox lighting, brand commercial' },
  { id: 'cinematic_anamorphic', label: '🎞 Cinematic Anamorphic', desc: '2.39:1 widescreen, film lens flare, dramatic' },
  { id: 'candid_nightlife_flash', label: '🌃 Nightlife On-Camera Flash', desc: 'Harsh frontal flash in dark room/bar setting' },
  { id: 'gopro_hero12_action', label: '🏄 GoPro Action POV', desc: 'Wide-angle action camera, immersive movement' },
]

export default function InboxClient({ jobs: initialJobs, personaMap, workspaceId, hiddenByBrand = 0, activeBrandName = null }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [filter, setFilter] = useState('all') // 'all' | 'pending' | 'done'
  const [activeModalBatch, setActiveModalBatch] = useState(null)
  const [userCameraPresets, setUserCameraPresets] = useState([])

  // Fetch workspace custom camera presets (e.g. AceKid, Pixar-style 3D, Gagagibah, etc.)
  useEffect(() => {
    fetch('/api/workspace/camera-presets')
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setUserCameraPresets(j.presets || [])
      })
      .catch(() => {})
  }, [])

  // Subscribe to realtime updates on studio_jobs
  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )

    const channel = supabase
      .channel('studio_jobs_inbox')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'studio_jobs',
        filter: `workspace_id=eq.${workspaceId}`,
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setJobs(prev => [payload.new, ...prev])
        } else if (payload.eventType === 'UPDATE') {
          setJobs(prev => prev.map(j => j.id === payload.new.id ? { ...j, ...payload.new } : j))
        } else if (payload.eventType === 'DELETE') {
          setJobs(prev => prev.filter(j => j.id !== payload.old.id))
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [workspaceId])

  async function handleDeleteJob(jobId) {
    if (!window.confirm('Yakin mau hapus naskah ini dari Inbox?')) return
    try {
      const res = await fetch('/api/studio-jobs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      })
      const data = await res.json()
      if (data.ok) {
        setJobs(prev => prev.filter(j => j.id !== jobId))
      }
    } catch {
      alert('Gagal menghapus job')
    }
  }

  async function handleDeleteBatch(batchObj) {
    const { title, jobs: batchJobs } = batchObj
    if (!window.confirm(`Yakin mau hapus batch "${title}" (${batchJobs.length} naskah) dari Inbox?`)) return
    const jobIds = batchJobs.map(j => j.id)
    try {
      const res = await fetch('/api/studio-jobs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: jobIds }),
      })
      const data = await res.json()
      if (data.ok) {
        setJobs(prev => prev.filter(j => !jobIds.includes(j.id)))
      }
    } catch {
      alert('Gagal menghapus batch')
    }
  }

  const filteredJobs = filter === 'all'
    ? jobs
    : jobs.filter(j =>
        filter === 'pending' ? ['pending', 'parsed', 'in_progress'].includes(j.status)
        : filter === 'done' ? ['done', 'error', 'cancelled'].includes(j.status)
        : true
      )

  const pendingCount = jobs.filter(j => ['pending', 'parsed'].includes(j.status)).length
  const doneCount = jobs.filter(j => j.status === 'done').length

  // Group filteredJobs into Batches (1 push event = 1 batch card)
  const batchesMap = new Map()
  for (const job of filteredJobs) {
    const raw = job.title || ''
    const parts = raw.split(/\s*[-·]\s*/)
    const topicFromTitle = parts.length > 1 && parts[0].trim() ? parts[0].trim() : raw.trim()
    const topicTitle = topicFromTitle || 'Content Plan'

    const pushBatchId = job.source_ref?.push_batch_id || job.source_ref?.batch_id
    const createdTime = job.created_at ? new Date(job.created_at).getTime() : Date.now()
    // 3-minute bucket groups jobs pushed in the same request together, but keeps separate pushes apart
    const timeBucket = Math.floor(createdTime / (3 * 60 * 1000))

    const batchId = pushBatchId && !pushBatchId.startsWith('topic_')
      ? pushBatchId
      : `${topicTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${timeBucket}`

    if (!batchesMap.has(batchId)) {
      batchesMap.set(batchId, {
        batchId,
        title: topicTitle,
        jobs: [],
      })
    }
    batchesMap.get(batchId).jobs.push(job)
  }

  const batchList = Array.from(batchesMap.values())

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-[var(--fg)] flex items-center gap-2">
            📥 Studio Inbox
            {pendingCount > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-amber-500/20 border border-amber-500/30 px-2.5 py-0.5 text-xs font-bold text-amber-400 tabular-nums">
                {pendingCount} pending
              </span>
            )}
          </h1>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Naskah pushed from Caketing — grouped by push batch & ready for production
            {activeBrandName && <> · difilter buat brand <span className="text-[var(--accent)] font-semibold">{activeBrandName}</span></>}
            {hiddenByBrand > 0 && (
              <> · <span className="text-amber-400">{hiddenByBrand} job brand lain disembunyiin</span></>
            )}
          </p>
        </div>
        {/* Filters */}
        <div className="flex items-center gap-1.5">
          {[
            { key: 'all', label: 'All', count: jobs.length },
            { key: 'pending', label: 'Pending', count: pendingCount },
            { key: 'done', label: 'Done', count: doneCount },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                filter === f.key
                  ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent-glow)]'
                  : 'glass text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--glass-hover)]'
              }`}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {filteredJobs.length === 0 && (
        <div className="glass rounded-2xl flex flex-col items-center justify-center py-16 text-center border border-dashed border-[var(--border)]">
          <div className="text-4xl mb-3">📥</div>
          <h3 className="text-sm font-bold text-[var(--fg)] mb-1">No jobs yet</h3>
          <p className="text-xs text-[var(--muted)] max-w-xs">
            Push approved naskah from Caketing to see them here. Each push creates a grouped Batch ready for generation.
          </p>
        </div>
      )}

      {/* Batch Cards */}
      <div className="space-y-4">
        {batchList.map(batch => (
          <BatchCard
            key={batch.batchId}
            batch={batch}
            personaMap={personaMap}
            onDeleteBatch={handleDeleteBatch}
            onDeleteJob={handleDeleteJob}
            onOpenExecutionModal={(b) => setActiveModalBatch({ batch: b, selectedStyle: 'samsung_a13_candid', selectedModel: 'openai/gpt-image-2/edit', constraints: defaultConstraints() })}
          />
        ))}
      </div>

      {/* Batch Execution Modal */}
      {activeModalBatch && (
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex flex-col items-center justify-center p-4">
          <div className="bg-[var(--surface1,#16161e)] border border-purple-500/40 rounded-2xl p-6 max-w-lg w-full shadow-2xl space-y-5 animate-in fade-in zoom-in duration-200">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-[var(--border)] pb-3">
              <div>
                <h2 className="text-base font-extrabold text-white flex items-center gap-2">
                  🚀 Eksekusi Batch: <span className="text-purple-300">{activeModalBatch.batch.title}</span>
                </h2>
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  {activeModalBatch.batch.jobs.length} Naskah · {activeModalBatch.batch.jobs.reduce((a, b) => a + (b.parsed_shots?.length || 0), 0)} Shots Total
                </p>
              </div>
              <button 
                onClick={() => setActiveModalBatch(null)}
                className="text-gray-400 hover:text-white text-base font-bold p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Visual Style Selection */}
            <div className="space-y-4 text-left">
              <div>
                <label className="block text-xs font-bold text-gray-200 mb-1.5 flex items-center justify-between">
                  <span>📸 Pilih Camera / Visual Style untuk Batch Ini:</span>
                  <span className="text-[10px] text-purple-400 font-normal">
                    {userCameraPresets.length > 0 ? `+${userCameraPresets.length} Custom presets` : ''}
                  </span>
                </label>
                <select
                  value={activeModalBatch.selectedStyle || 'samsung_a13_candid'}
                  onChange={(e) => setActiveModalBatch({ ...activeModalBatch, selectedStyle: e.target.value })}
                  className="w-full rounded-xl border border-purple-500/40 bg-[var(--surface2,#121217)] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-purple-400 cursor-pointer shadow-inner"
                >
                  <optgroup label="📱 PHONE (4)">
                    <option value="samsung_a13_candid">⚙ Samsung A13 candid (UGC) — TikTok UGC, real-person testimonial, handheld</option>
                    <option value="iphone_15_clean">⚙ iPhone 15 clean — Polished UGC, founder talking head, podcast clip</option>
                    <option value="iphone_15_candid">⚙ iPhone 15 UGC Candid — Real-person candid point-and-shoot, raw iPhone snapshot</option>
                    <option value="raw_ugc_candid">⚙ Raw UGC Candid — Authentic no-filter look</option>
                  </optgroup>

                  <optgroup label="🎬 CINEMA (4)">
                    <option value="studio_tvc">⚙ Studio TVC — Premium brand spot, controlled lighting, locked-off</option>
                    <option value="cinematic_anamorphic">⚙ Cinematic anamorphic — Hero brand film, narrative ad, festival look</option>
                    <option value="product_macro">⚙ Product macro — Product hero shot, e-commerce key visual</option>
                    <option value="documentary_handheld">⚙ Documentary handheld — Real-world story, observational style</option>
                  </optgroup>

                  <optgroup label="🎨 ANIMATION (2)">
                    <option value="animation_2d">⚙ 2D animation — Animated explainer, mascot ad, kid-friendly</option>
                    <option value="pixar_3d">⚙ Pixar-style 3D — Family / mascot 3D ad, character-driven CG</option>
                  </optgroup>

                  {userCameraPresets.length > 0 && (
                    <optgroup label={`👤 CUSTOM WORKSPACE STYLES (${userCameraPresets.length})`}>
                      {userCameraPresets.map((p) => (
                        <option key={p.id} value={p.id}>
                          👤 {p.label} — {p.use_case || p.desc || 'Custom workspace style'}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-200 mb-1.5">
                  🤖 Model AI Image:
                </label>
                <select
                  value={activeModalBatch.selectedModel || 'openai/gpt-image-2/edit'}
                  onChange={(e) => setActiveModalBatch({ ...activeModalBatch, selectedModel: e.target.value })}
                  className="w-full rounded-xl border border-purple-500/40 bg-[var(--surface2,#121217)] px-3 py-2 text-xs font-semibold text-white outline-none focus:border-purple-400"
                >
                  <option value="openai/gpt-image-2/edit">🆕 GPT Image 2 Edit (Pixel-lock identity - Default)</option>
                  <option value="openai/gpt-image-2">🆕 GPT Image 2 (Text-to-Image mode)</option>
                  <option value="fal-ai/nano-banana-2/edit">⚡ Nano Banana 2 (Fast multi-ref)</option>
                  <option value="xai/grok-imagine-image/edit">🔥 Grok Imagine Edit</option>
                </select>
              </div>
            </div>

            {/* Constraints — these drive the WHOLE batch. Launching without
                showing them meant a 21-shot run could come out with dialogue or
                burned-in text nobody wanted, and the only way to find out was
                after paying for it. */}
            <div className="mt-4">
              <label className="block text-xs font-bold text-gray-200 mb-1.5">
                🎛 Constraints <span className="font-normal text-[var(--muted)]">— berlaku buat semua shot di batch ini</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {GEN_CONSTRAINTS.map((c) => {
                  const on = !!(activeModalBatch.constraints || {})[c.key]
                  return (
                    <button
                      key={c.key}
                      type="button"
                      title={c.hint}
                      onClick={() => setActiveModalBatch({
                        ...activeModalBatch,
                        constraints: { ...(activeModalBatch.constraints || defaultConstraints()), [c.key]: !on },
                      })}
                      className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-colors ${
                        on
                          ? 'border-purple-400 bg-purple-500/20 text-purple-200'
                          : 'border-[var(--border)] text-[var(--muted)] hover:text-gray-200 hover:border-gray-500'
                      }`}
                    >
                      {on ? '✓ ' : '○ '}{c.label}
                    </button>
                  )
                })}
              </div>
              {activeModalBatch.constraints?.autoVoiceSwap && (
                <p className="mt-1.5 text-[10px] text-[var(--muted2)]">
                  🎙 Auto voice swap nyala — ~$0.30 per video yang ada dialognya. Shot tanpa dialog dilewatin otomatis.
                </p>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => setActiveModalBatch(null)}
                className="px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-gray-300 hover:bg-gray-800 cursor-pointer"
              >
                Batal
              </button>
              <Link
                href={`/generate?studio_job=${activeModalBatch.batch.jobs.map(j => j.id).join(',')}&camera_preset=${activeModalBatch.selectedStyle || 'samsung_a13_candid'}&img_model=${encodeURIComponent(activeModalBatch.selectedModel || 'openai/gpt-image-2/edit')}&constraints=${encodeURIComponent(serializeConstraints(activeModalBatch.constraints || defaultConstraints()))}`}
                onClick={() => setActiveModalBatch(null)}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-purple-500/30 hover:scale-[1.02] transition-transform"
              >
                🚀 Start Auto-Generation
              </Link>
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
