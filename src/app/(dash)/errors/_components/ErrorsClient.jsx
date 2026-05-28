'use client'
import { useState, useMemo } from 'react'

// Full error_log viewer. Lists last 200 entries, supports level + source filter,
// shows stack on click. Linked from sidebar and from the dashboard banner.
export default function ErrorsClient({ initial, initialFilters }) {
  const [level, setLevel] = useState(initialFilters.level || 'all')
  const [source, setSource] = useState(initialFilters.source || '')
  const [expanded, setExpanded] = useState(null)
  const [hideOlderThan, setHideOlderThan] = useState('all') // 'all' | '24h' | '7d'

  const errors = initial
  const filtered = useMemo(() => {
    let rows = errors
    if (level !== 'all') rows = rows.filter((e) => e.level === level)
    if (source) rows = rows.filter((e) => (e.source || '').toLowerCase().includes(source.toLowerCase()))
    if (hideOlderThan !== 'all') {
      const cutoff = Date.now() - (hideOlderThan === '24h' ? 24 * 3600e3 : 7 * 86400e3)
      rows = rows.filter((e) => new Date(e.created_at).getTime() >= cutoff)
    }
    return rows
  }, [errors, level, source, hideOlderThan])

  // Group by source for the summary strip
  const bySource = useMemo(() => {
    const acc = {}
    filtered.forEach((e) => { acc[e.source] = (acc[e.source] || 0) + 1 })
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [filtered])

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">🚨 Errors</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Last 200 server-side errors di workspace lu. Auto-logged dari API routes.</p>
        </div>
        <div className="text-xs text-[var(--muted)]">{filtered.length} shown / {errors.length} total</div>
      </div>

      <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 mb-3 flex flex-wrap gap-2 items-center text-xs">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-[var(--muted)]">Level:</span>
          {['all', 'error', 'warn', 'info'].map((l) => (
            <button key={l} onClick={() => setLevel(l)}
              className={`px-2 py-1 rounded text-[10px] font-semibold ${level === l ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-2">
          <span className="text-[10px] text-[var(--muted)]">Recency:</span>
          {[['all', 'all time'], ['24h', '24h'], ['7d', '7d']].map(([v, label]) => (
            <button key={v} onClick={() => setHideOlderThan(v)}
              className={`px-2 py-1 rounded text-[10px] font-semibold ${hideOlderThan === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>
              {label}
            </button>
          ))}
        </div>
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Filter by source (e.g. /api/fal)"
          className="flex-1 min-w-[200px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] text-xs" />
      </div>

      {bySource.length > 0 && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 mb-3">
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] tracking-wider mb-2">Top sources (current filter)</div>
          <div className="flex flex-wrap gap-1.5">
            {bySource.map(([src, count]) => (
              <button key={src} onClick={() => setSource(src)}
                className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--accent)] hover:text-white font-mono">
                {src} <span className="opacity-60">×{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-sm text-green-400 bg-[var(--surface)] border border-[var(--border)] rounded">
            ✓ Gak ada error dengan filter ini. Smooth.
          </div>
        ) : filtered.map((e) => (
          <div key={e.id} className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 text-xs">
            <button onClick={() => setExpanded((s) => s === e.id ? null : e.id)} className="w-full text-left">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono text-[var(--muted2)]">{new Date(e.created_at).toLocaleString()}</span>
                <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                  e.level === 'error' ? 'bg-red-500/20 text-red-400'
                  : e.level === 'warn' ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-blue-500/20 text-blue-400'
                }`}>{e.level}</span>
                <span className="text-[10px] font-mono text-[var(--accent)]">{e.source}</span>
                <span className="ml-auto text-[10px] text-[var(--muted2)]">{expanded === e.id ? '▲' : '▼'}</span>
              </div>
              <div className={`mt-1 break-words ${e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-yellow-300' : 'text-blue-300'}`}>
                {e.message}
              </div>
            </button>
            {expanded === e.id && (
              <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-2">
                {e.stack && (
                  <div>
                    <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-1">Stack trace</div>
                    <pre className="text-[10px] font-mono whitespace-pre-wrap break-all text-[var(--muted)] bg-[var(--surface2)] p-2 rounded max-h-48 overflow-y-auto">{e.stack}</pre>
                  </div>
                )}
                {e.metadata && Object.keys(e.metadata).length > 0 && (
                  <div>
                    <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-1">Metadata</div>
                    <pre className="text-[10px] font-mono whitespace-pre-wrap break-all text-[var(--muted)] bg-[var(--surface2)] p-2 rounded">{JSON.stringify(e.metadata, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
