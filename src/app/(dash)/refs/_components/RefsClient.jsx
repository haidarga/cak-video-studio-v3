'use client'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { uploadFile } from '@/lib/upload-client'

export default function RefsClient({ workspaceId, userId, initialRefs }) {
  const supabase = createClient()
  const [refs, setRefs] = useState(initialRefs)
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    const ch = supabase.channel('refs-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'refs', filter: `workspace_id=eq.${workspaceId}` }, (p) => {
        if (p.eventType === 'INSERT') setRefs((prev) => prev.find((r) => r.id === p.new.id) ? prev : [p.new, ...prev])
        else if (p.eventType === 'UPDATE') setRefs((prev) => prev.map((r) => r.id === p.new.id ? p.new : r))
        else if (p.eventType === 'DELETE') setRefs((prev) => prev.filter((r) => r.id !== p.old.id))
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  async function uploadFiles(files) {
    setBusy(true); setErr('')
    try {
      for (const file of files) {
        const { url } = await uploadFile(file, 'refs')
        await supabase.from('refs').insert({
          workspace_id: workspaceId, fal_url: url, label: '', kind: 'character', created_by: userId,
        })
      }
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  async function updateRef(id, patch) {
    const { error } = await supabase.from('refs').update(patch).eq('id', id)
    if (error) setErr(error.message)
  }
  async function deleteRef(id, label) {
    if (!confirm(`Hapus ref "${label || 'unnamed'}"?`)) return
    const { error } = await supabase.from('refs').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  const shown = refs.filter((r) => filter === 'all' || r.kind === filter)
  const counts = { all: refs.length, character: refs.filter((r) => r.kind === 'character').length, product: refs.filter((r) => r.kind === 'product').length }

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">Library</div>
          <h1 className="text-3xl font-bold mt-1">🖼 References</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Pool foto karakter & produk. Tiap ref bisa punya product knowledge sendiri (teks kemasan, aturan visual).</p>
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { uploadFiles([...e.target.files]); e.target.value = '' }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
          {busy ? '⏳ Uploading...' : '+ Upload References'}
        </button>
      </div>

      {err && <div className="mb-3 text-xs text-red-400">⚠ {err}</div>}

      <div className="flex gap-2 mb-5">
        {[['all', 'Semua'], ['character', '👤 Karakter'], ['product', '📦 Produk']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${filter === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)] hover:text-white'}`}>
            {l} <span className="opacity-60">{counts[v] || 0}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center">
          {refs.length === 0 ? <>Belum ada ref. Klik <strong>+ Upload References</strong> di kanan atas ☝️</> : 'Gak ada ref match filter.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {shown.map((r) => (
            <RefCard key={r.id} refData={r}
              onEdit={() => setEditing(r)}
              onDelete={() => deleteRef(r.id, r.label)}
              onKindChange={(kind) => updateRef(r.id, { kind })} />
          ))}
        </div>
      )}

      {editing && (
        <RefEditor refData={editing} onClose={() => setEditing(null)}
          onSave={async (patch) => { await updateRef(editing.id, patch); setEditing(null) }} />
      )}
    </div>
  )
}

function RefCard({ refData: r, onEdit, onDelete, onKindChange }) {
  const hasKnowledge = !!(r.knowledge || '').trim()
  return (
    <div className={`bg-[var(--surface)] border rounded-lg overflow-hidden ${hasKnowledge ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
      <div className="relative aspect-square bg-[var(--surface2)]">
        <img src={r.fal_url} alt={r.label} className="w-full h-full object-cover" />
        <div className="absolute top-2 right-2 flex gap-1">
          {hasKnowledge && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[var(--accent)] text-white">📋</span>}
        </div>
      </div>
      <div className="p-2">
        <div className="text-xs font-semibold truncate">{r.label || <span className="text-[var(--muted2)] italic">unlabeled</span>}</div>
        <div className="flex items-center justify-between mt-1.5">
          <select value={r.kind} onChange={(e) => onKindChange(e.target.value)}
            className="text-[10px] bg-[var(--surface2)] border border-[var(--border)] rounded px-1 py-0.5">
            <option value="character">👤 Char</option>
            <option value="product">📦 Prod</option>
          </select>
          <div className="flex gap-1">
            <button onClick={onEdit} className="p-1 text-xs hover:bg-[var(--surface2)] rounded">✏️</button>
            <button onClick={onDelete} className="p-1 text-xs hover:bg-[var(--surface2)] rounded text-red-400">🗑</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RefEditor({ refData, onClose, onSave }) {
  const [label, setLabel] = useState(refData.label || '')
  const [knowledge, setKnowledge] = useState(refData.knowledge || '')
  const [kind, setKind] = useState(refData.kind || 'character')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    await onSave({ label: label.trim(), knowledge: knowledge.trim() || null, kind })
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-6 overflow-y-auto" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-2xl bg-[var(--surface)] rounded-xl border border-[var(--border)] my-8">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-lg font-bold">Edit Reference</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-[200px_1fr] gap-5 items-start">
            <img src={refData.fal_url} alt="" className="w-full aspect-square object-cover rounded border border-[var(--border)]" />
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">Label / Nama</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. AceKid / Budi / Sari"
                  className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">Tipe</label>
                <div className="flex gap-2">
                  {[['character', '👤 Karakter'], ['product', '📦 Produk']].map(([v, l]) => (
                    <button key={v} onClick={() => setKind(v)}
                      className={`px-3 py-1.5 rounded text-xs ${kind === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {kind === 'product' && (
            <div>
              <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">📋 Product Knowledge</label>
              <textarea rows={8} value={knowledge} onChange={(e) => setKnowledge(e.target.value)}
                placeholder={'Khusus produk — biar konsisten:\n• TEKS KEMASAN (persis): "AceKid", "Activegro", "3+ Years"\n• WARNA & CIRI: kaleng biru-kuning, tutup biru\n• ATURAN: kaleng tegak, logo hadap kamera, jangan distorsi\n• VARIAN: 130g / 400g'}
                className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
              <div className="text-[10px] text-[var(--muted2)] mt-1">
                Auto-inject ke prompt image gen pas ref ini ke-link ke shot.
              </div>
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-[var(--border)] flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm">Batal</button>
          <button onClick={save} disabled={busy}
            className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '...' : '✓ Simpan'}
          </button>
        </div>
      </div>
    </div>
  )
}
