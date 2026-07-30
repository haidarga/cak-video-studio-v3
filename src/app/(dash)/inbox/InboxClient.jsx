'use client'

import { useState, useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import Link from 'next/link'

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

function JobCard({ job, personaMap, expanded, onToggle }) {
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
    <div className="glass rounded-2xl border border-[var(--border)] overflow-hidden transition-all hover:border-[var(--accent)]/40 hover:shadow-lg hover:shadow-[var(--accent-glow)]">
      {/* Card header */}
      <button
        onClick={onToggle}
        className="w-full text-left px-5 py-4 flex items-start gap-4 transition-colors hover:bg-[var(--glass-hover)]"
      >
        {/* Left: persona avatar placeholder */}
        <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--purple)] to-[var(--magenta)] flex items-center justify-center text-white text-lg font-bold shadow-md shadow-[var(--accent-glow)]">
          {sourcePersonaName.charAt(0).toUpperCase()}
        </div>

        {/* Middle: info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-bold text-[var(--fg)] truncate">🎬 {job.title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
            <span>Source: <span className="text-[var(--fg)] font-semibold capitalize">{job.source}</span>
              {job.brand_name && <> · <span className="text-[var(--accent)]">{job.brand_name}</span></>}
            </span>
            <span>Shots: <span className="font-mono text-[var(--fg)]">{shotCount}</span> · ~{duration}s · {ar} · {platform}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[11px]">
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

        {/* Right: status + time */}
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={job.status} />
          <span className="text-[10px] text-[var(--muted)]">
            {new Date(job.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
          </span>
        </div>
      </button>

      {/* Expanded: preview + actions */}
      {expanded && (
        <div className="border-t border-[var(--border)] bg-[rgba(0,0,0,0.15)] px-5 py-4">
          {/* Brief context */}
          {Object.keys(job.brief_context || {}).length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-bold mb-1">Brief Context</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(job.brief_context).map(([k, v]) => (
                  <span key={k} className="text-[11px] text-[var(--fg)] bg-[var(--glass)] px-2 py-0.5 rounded-md border border-[var(--border)]">
                    <span className="text-[var(--muted)]">{k}:</span> {String(v).slice(0, 80)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Naskah text preview */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-bold mb-1">Naskah</div>
            <div className="glass rounded-xl p-3 max-h-40 overflow-y-auto text-xs text-[var(--fg)] whitespace-pre-wrap leading-relaxed border border-[var(--border)]">
              {job.naskah_text}
            </div>
          </div>

          {/* Parsed shots */}
          {shotCount > 0 && (
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-bold mb-1">
                Parsed Shots ({shotCount})
              </div>
              <ShotPreview shots={job.parsed_shots} />
            </div>
          )}

          {/* Error message */}
          {job.error && (
            <div className="mb-3 p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
              {job.error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2.5 mt-1">
            {isActionable && persona.studio_persona_id && (
              <Link
                href={`/generate?studio_job=${job.id}`}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[var(--purple)] to-[var(--magenta)] px-4 py-2 text-xs font-bold text-white shadow-md shadow-[var(--accent-glow)] hover:scale-[1.03] transition-transform"
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
                className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--glass)] border border-[var(--border)] px-4 py-2 text-xs font-semibold text-[var(--fg)] hover:bg-[var(--glass-hover)] transition-colors"
              >
                📁 View Results ({job.result_ids.length})
              </Link>
            )}
            {isActionable && (
              <button
                onClick={() => {/* TODO: dismiss/cancel job */}}
                className="text-xs text-[var(--muted)] hover:text-red-400 transition-colors ml-auto"
              >
                ✕ Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function InboxClient({ jobs: initialJobs, personaMap, workspaceId }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [expandedId, setExpandedId] = useState(null)
  const [filter, setFilter] = useState('all') // 'all' | 'pending' | 'done'

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

  const filteredJobs = filter === 'all'
    ? jobs
    : jobs.filter(j =>
        filter === 'pending' ? ['pending', 'parsed', 'in_progress'].includes(j.status)
        : filter === 'done' ? ['done', 'error', 'cancelled'].includes(j.status)
        : true
      )

  const pendingCount = jobs.filter(j => ['pending', 'parsed'].includes(j.status)).length
  const doneCount = jobs.filter(j => j.status === 'done').length

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-[var(--fg)] flex items-center gap-2">
            📥 Studio Inbox
            {pendingCount > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-amber-500/20 border border-amber-500/30 px-2 py-0.5 text-xs font-bold text-amber-400 tabular-nums">
                {pendingCount} pending
              </span>
            )}
          </h1>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Naskah pushed from Caketing — ready for video production
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
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
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
            Push approved naskah from Caketing to see them here. Each naskah becomes a production job you can open in Generate.
          </p>
        </div>
      )}

      {/* Job cards */}
      <div className="space-y-3">
        {filteredJobs.map(job => (
          <JobCard
            key={job.id}
            job={job}
            personaMap={personaMap}
            expanded={expandedId === job.id}
            onToggle={() => setExpandedId(expandedId === job.id ? null : job.id)}
          />
        ))}
      </div>
    </div>
  )
}
