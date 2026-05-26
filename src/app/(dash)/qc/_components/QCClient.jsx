'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const COLUMNS = [
  { v: 'pending',  l: '⏳ Review',   color: 'border-blue-500/30' },
  { v: 'approved', l: '✅ Approved', color: 'border-green-500/30' },
  { v: 'revise',   l: '🔁 Revisi',   color: 'border-orange-500/30' },
  { v: 'rejected', l: '❌ Rejected', color: 'border-red-500/30' },
]

export default function QCClient({ workspaceId, initialResults }) {
  const supabase = createClient()
  const [results, setResults] = useState(initialResults)
  const [openNote, setOpenNote] = useState(null) // result obj
  const [err, setErr] = useState('')

  useEffect(() => {
    const ch = supabase.channel('qc-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results', filter: `workspace_id=eq.${workspaceId}` }, async (p) => {
        if (p.eventType === 'DELETE') {
          setResults((prev) => prev.filter((r) => r.id !== p.old.id))
        } else {
          // re-fetch with persona join
          const { data } = await supabase.from('results').select('*, personas(id, name, username, avatar_url)').eq('id', p.new.id).single()
          if (data) setResults((prev) => {
            const idx = prev.findIndex((r) => r.id === data.id)
            // only show if qc_status set
            if (!data.qc_status) return prev.filter((r) => r.id !== data.id)
            if (idx === -1) return [data, ...prev]
            const next = [...prev]; next[idx] = data; return next
          })
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  async function setStatus(id, status) {
    const { error } = await supabase.from('results').update({ qc_status: status }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function removeFromQC(id) {
    const { error } = await supabase.from('results').update({ qc_status: null, qc_notes: null }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function saveNote(id, notes) {
    const { error } = await supabase.from('results').update({ qc_notes: notes }).eq('id', id)
    if (error) setErr(error.message)
  }

  const byStatus = useMemo(() => {
    const m = Object.fromEntries(COLUMNS.map((c) => [c.v, []]))
    results.forEach((r) => { if (m[r.qc_status]) m[r.qc_status].push(r) })
    return m
  }, [results])

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">🧪 QC</h1>
          <p className="text-sm text-[var(--muted)]">Review queue. Approved siap di-Schedule ke Postiz.</p>
        </div>
        {byStatus.approved.length > 0 && (
          <a href="/scheduled" className="text-xs text-green-400 underline">
            ✓ {byStatus.approved.length} approved siap upload →
          </a>
        )}
      </div>

      {err && <div className="mb-3 text-xs text-red-400">⚠ {err}</div>}

      {results.length === 0 ? (
        <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center">
          QC queue kosong. Dari tab <a href="/results" className="underline text-[var(--accent)]">Results</a>, klik 🧪 QC pada video buat masukin ke review queue.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {COLUMNS.map((col) => (
            <div key={col.v} className={`bg-[var(--surface)] border ${col.color} rounded-lg`}>
              <div className="px-3 py-2.5 border-b border-[var(--border)] flex items-center justify-between">
                <div className="text-sm font-bold">{col.l}</div>
                <div className="text-xs text-[var(--muted)]">{byStatus[col.v].length}</div>
              </div>
              <div className="p-2 space-y-2 max-h-[70vh] overflow-y-auto">
                {byStatus[col.v].length === 0 ? (
                  <div className="text-[10px] text-[var(--muted2)] text-center p-4">kosong</div>
                ) : byStatus[col.v].map((r) => (
                  <QCCard key={r.id} result={r}
                    onMove={(status) => setStatus(r.id, status)}
                    onRemove={() => removeFromQC(r.id)}
                    onOpenNote={() => setOpenNote(r)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {openNote && (
        <NoteEditor result={openNote} onClose={() => setOpenNote(null)}
          onSave={async (notes) => { await saveNote(openNote.id, notes); setOpenNote(null) }} />
      )}
    </div>
  )
}

function QCCard({ result: r, onMove, onRemove, onOpenNote }) {
  return (
    <div className="bg-[var(--surface2)] border border-[var(--border)] rounded overflow-hidden">
      <div className="relative aspect-[9/16] bg-black">
        {r.type === 'video'
          ? <video src={r.url} muted loop playsInline className="w-full h-full object-cover"
              onMouseEnter={(e) => e.target.play()} onMouseLeave={(e) => e.target.pause()} />
          : <img src={r.url} alt={r.label} className="w-full h-full object-cover" />}
      </div>
      <div className="p-2">
        <div className="text-[11px] font-semibold truncate">{r.label || 'result'}</div>
        {r.personas && <div className="text-[9px] text-[var(--muted)]">@{r.personas.username || r.personas.name}</div>}
        {r.qc_notes && (
          <div className="text-[10px] text-[var(--muted)] mt-1 line-clamp-2 italic">📝 {r.qc_notes}</div>
        )}
        <select value={r.qc_status} onChange={(e) => onMove(e.target.value)}
          className="mt-2 w-full text-[10px] px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)]">
          {COLUMNS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
        </select>
        <div className="flex gap-1 mt-1.5">
          <button onClick={onOpenNote} className="flex-1 text-[10px] px-1.5 py-1 rounded bg-[var(--surface)] hover:bg-[var(--border)]">
            {r.qc_notes ? '📝 Edit note' : '+ Note'}
          </button>
          <button onClick={onRemove} className="text-[10px] px-1.5 py-1 rounded text-red-400 hover:bg-[var(--surface)]" title="Keluarin dari QC">✕</button>
        </div>
      </div>
    </div>
  )
}

function NoteEditor({ result, onClose, onSave }) {
  const [notes, setNotes] = useState(result.qc_notes || '')
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-xl bg-[var(--surface)] rounded-xl border border-[var(--border)]">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-lg font-bold">QC Note — {result.label}</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6">
          <textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Apa yang perlu diperbaiki? Apa yang udah oke?"
            className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
        </div>
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm">Batal</button>
          <button onClick={async () => { setBusy(true); await onSave(notes); setBusy(false) }} disabled={busy}
            className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '...' : '✓ Simpan'}
          </button>
        </div>
      </div>
    </div>
  )
}
