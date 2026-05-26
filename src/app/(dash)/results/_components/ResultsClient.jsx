'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function ResultsClient({ workspaceId, initialResults, personas }) {
  const supabase = createClient()
  const [results, setResults] = useState(initialResults)
  const [filterType, setFilterType] = useState('all')   // all | image | video
  const [filterPersona, setFilterPersona] = useState('all')
  const [search, setSearch] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    const ch = supabase.channel('results-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results', filter: `workspace_id=eq.${workspaceId}` }, async (p) => {
        if (p.eventType === 'INSERT' || p.eventType === 'UPDATE') {
          const { data } = await supabase.from('results').select('*, personas(id, name, username, avatar_url)').eq('id', p.new.id).single()
          if (data) setResults((prev) => {
            const idx = prev.findIndex((r) => r.id === data.id)
            if (idx === -1) return [data, ...prev]
            const next = [...prev]; next[idx] = data; return next
          })
        } else if (p.eventType === 'DELETE') {
          setResults((prev) => prev.filter((r) => r.id !== p.old.id))
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return results.filter((r) => {
      if (filterType !== 'all' && r.type !== filterType) return false
      if (filterPersona !== 'all') {
        if (filterPersona === 'none' && r.persona_id) return false
        if (filterPersona !== 'none' && r.persona_id !== filterPersona) return false
      }
      if (q && !(r.label || '').toLowerCase().includes(q) && !(r.group_label || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [results, filterType, filterPersona, search])

  const grouped = useMemo(() => {
    const m = new Map()
    shown.forEach((r) => {
      const key = r.personas?.name || r.group_label || '— Tanpa persona —'
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(r)
    })
    return [...m.entries()]
  }, [shown])

  async function sendToQC(id) {
    const { error } = await supabase.from('results').update({ qc_status: 'pending' }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function remove(id) {
    if (!confirm('Hapus result ini?')) return
    const { error } = await supabase.from('results').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  const counts = {
    all: results.length,
    image: results.filter((r) => r.type === 'image').length,
    video: results.filter((r) => r.type === 'video').length,
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-1">📁 Results</h1>
      <p className="text-sm text-[var(--muted)] mb-5">Hasil generate, auto-grouped per persona. Approved → bisa di-Schedule.</p>

      {err && <div className="mb-3 text-xs text-red-400">⚠ {err}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-5">
        {[['all', 'Semua'], ['video', '🎬 Video'], ['image', '🖼 Image']].map(([v, l]) => (
          <button key={v} onClick={() => setFilterType(v)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${filterType === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)] hover:text-white'}`}>
            {l} <span className="opacity-60">{counts[v]}</span>
          </button>
        ))}
        <select value={filterPersona} onChange={(e) => setFilterPersona(e.target.value)}
          className="ml-2 text-xs px-3 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
          <option value="all">Semua persona</option>
          <option value="none">Tanpa persona</option>
          {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari label..."
          className="ml-auto w-64 text-xs px-3 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
      </div>

      {shown.length === 0 ? (
        <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center">
          {results.length === 0 ? 'Belum ada result. Generate dulu di tab Generate.' : 'Gak ada result match filter.'}
        </div>
      ) : (
        grouped.map(([groupName, items]) => (
          <section key={groupName} className="mb-7">
            <div className="text-sm font-bold mb-3 text-[var(--muted)]">{groupName} <span className="font-normal text-[var(--muted2)]">· {items.length}</span></div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {items.map((r) => (
                <ResultCard key={r.id} result={r} onQC={() => sendToQC(r.id)} onDelete={() => remove(r.id)} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function ResultCard({ result: r, onQC, onDelete }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="relative aspect-[9/16] bg-[var(--surface2)]">
        {r.type === 'video'
          ? <video src={r.url} controls muted loop playsInline className="w-full h-full object-cover" />
          : <img src={r.url} alt={r.label} className="w-full h-full object-cover" />}
        {r.qc_status && (
          <span className={`absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-bold ${
            r.qc_status === 'approved' ? 'bg-green-500 text-white'
            : r.qc_status === 'revise' ? 'bg-orange-500 text-white'
            : r.qc_status === 'rejected' ? 'bg-red-500 text-white'
            : 'bg-blue-500 text-white'
          }`}>
            {r.qc_status}
          </span>
        )}
      </div>
      <div className="p-2">
        <div className="text-xs font-semibold truncate">{r.label || 'result'}</div>
        <div className="text-[10px] text-[var(--muted)]">{r.ar || ''} · {new Date(r.created_at).toLocaleDateString()}</div>
        <div className="flex gap-1 mt-2">
          {!r.qc_status && (
            <button onClick={onQC} className="flex-1 px-2 py-1 rounded text-[10px] bg-[var(--surface2)] hover:bg-[var(--border)] font-semibold">
              🧪 QC
            </button>
          )}
          <a href={r.url} download className="flex-1 px-2 py-1 rounded text-[10px] bg-[var(--surface2)] hover:bg-[var(--border)] text-center font-semibold">⬇️</a>
          <button onClick={onDelete} className="px-2 py-1 rounded text-[10px] text-red-400 hover:bg-[var(--surface2)]">🗑</button>
        </div>
      </div>
    </div>
  )
}
