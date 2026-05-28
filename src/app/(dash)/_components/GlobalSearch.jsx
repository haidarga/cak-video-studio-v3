'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Cmd+K / Ctrl+K opens modal. Search across results, projects, personas, brands.
export default function GlobalSearch({ workspaceId }) {
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState({ results: [], projects: [], personas: [], brands: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    function onKey(e) {
      const isMac = navigator.platform.includes('Mac')
      const cmd = isMac ? e.metaKey : e.ctrlKey
      if (cmd && e.key === 'k') {
        e.preventDefault()
        setOpen(true)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open || !workspaceId) return
    setLoading(true)
    Promise.all([
      supabase.from('results').select('id, type, label, qc_status, url').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50),
      supabase.from('editor_projects').select('id, name, updated_at').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(20),
      supabase.from('personas').select('id, name, username, avatar_url').eq('workspace_id', workspaceId).limit(50),
      supabase.from('brands').select('id, name').eq('workspace_id', workspaceId).limit(30),
    ]).then(([r, p, pe, b]) => {
      setData({ results: r.data || [], projects: p.data || [], personas: pe.data || [], brands: b.data || [] })
    }).finally(() => setLoading(false))
  }, [open, workspaceId, supabase])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return { ...data, results: data.results.slice(0, 8), projects: data.projects.slice(0, 5), personas: data.personas.slice(0, 5), brands: data.brands.slice(0, 5) }
    return {
      results: data.results.filter((r) => (r.label || '').toLowerCase().includes(q)).slice(0, 8),
      projects: data.projects.filter((p) => (p.name || '').toLowerCase().includes(q)).slice(0, 5),
      personas: data.personas.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q)).slice(0, 5),
      brands: data.brands.filter((b) => (b.name || '').toLowerCase().includes(q)).slice(0, 5),
    }
  }, [data, q])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-start justify-center pt-20 px-4" onClick={() => setOpen(false)}>
      <div className="w-full max-w-2xl bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-[var(--border)] p-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
            placeholder="Cari results, projects, personas, brands..."
            className="w-full bg-transparent text-sm focus:outline-none" />
        </div>
        <div className="max-h-96 overflow-auto p-2 text-sm">
          {loading && <div className="p-3 text-[var(--muted)] text-xs">Loading...</div>}
          {!loading && Object.values(filtered).every((arr) => arr.length === 0) && (
            <div className="p-3 text-[var(--muted)] text-xs">Gak ada hasil.</div>
          )}

          {filtered.results.length > 0 && (
            <Section label="🧪 Results">
              {filtered.results.map((r) => (
                <a key={r.id} href={`/qc`} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface2)]">
                  <div className="w-8 aspect-[9/16] bg-black rounded overflow-hidden flex-shrink-0">
                    {r.url && (r.type === 'video'
                      ? <video src={r.url} muted className="w-full h-full object-cover" />
                      : <img src={r.url} alt="" className="w-full h-full object-cover" />)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{r.label}</div>
                    <div className="text-[10px] text-[var(--muted)]">{r.type} · {r.qc_status || 'no QC'}</div>
                  </div>
                </a>
              ))}
            </Section>
          )}

          {filtered.projects.length > 0 && (
            <Section label="✂️ Editor projects">
              {filtered.projects.map((p) => (
                <a key={p.id} href={`/editor`} className="block px-2 py-1.5 rounded hover:bg-[var(--surface2)]">
                  <div className="text-xs font-semibold">{p.name}</div>
                  <div className="text-[10px] text-[var(--muted)]">{new Date(p.updated_at).toLocaleString()}</div>
                </a>
              ))}
            </Section>
          )}

          {filtered.personas.length > 0 && (
            <Section label="🎭 Personas">
              {filtered.personas.map((p) => (
                <a key={p.id} href={`/personas`} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface2)]">
                  {p.avatar_url
                    ? <img src={p.avatar_url} className="w-7 h-7 rounded-full" alt="" />
                    : <div className="w-7 h-7 rounded-full bg-[var(--surface2)]" />}
                  <div className="flex-1">
                    <div className="text-xs font-semibold">{p.name}</div>
                    <div className="text-[10px] text-[var(--muted)]">@{p.username}</div>
                  </div>
                </a>
              ))}
            </Section>
          )}

          {filtered.brands.length > 0 && (
            <Section label="🏷 Brands">
              {filtered.brands.map((b) => (
                <a key={b.id} href={`/brands`} className="block px-2 py-1.5 rounded hover:bg-[var(--surface2)]">
                  <div className="text-xs font-semibold">{b.name}</div>
                </a>
              ))}
            </Section>
          )}
        </div>
        <div className="border-t border-[var(--border)] px-3 py-2 text-[10px] text-[var(--muted)] flex gap-3">
          <span>⏎ open</span>
          <span>esc close</span>
          <span className="ml-auto">⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  )
}
function Section({ label, children }) {
  return (
    <div className="mb-2">
      <div className="text-[9px] uppercase font-bold text-[var(--muted)] tracking-wider px-2 py-1">{label}</div>
      {children}
    </div>
  )
}
