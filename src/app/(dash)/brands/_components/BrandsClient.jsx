'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function BrandsClient({ workspaceId, userId, initialBrands }) {
  const supabase = createClient()
  const [brands, setBrands] = useState(initialBrands)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState(null) // { id, notes }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Realtime: any insert/update/delete to brands in this workspace syncs here.
  useEffect(() => {
    const channel = supabase
      .channel('brands-' + workspaceId)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'brands', filter: `workspace_id=eq.${workspaceId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setBrands((p) => (p.find((b) => b.id === payload.new.id) ? p : [payload.new, ...p]))
          } else if (payload.eventType === 'UPDATE') {
            setBrands((p) => p.map((b) => (b.id === payload.new.id ? payload.new : b)))
          } else if (payload.eventType === 'DELETE') {
            setBrands((p) => p.filter((b) => b.id !== payload.old.id))
          }
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [supabase, workspaceId])

  async function createBrand(e) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true); setErr('')
    const { error } = await supabase
      .from('brands')
      .insert({ workspace_id: workspaceId, name: name.trim(), created_by: userId })
    if (error) setErr(error.message)
    else setName('')
    setBusy(false)
  }

  async function saveNotes() {
    if (!editing) return
    setBusy(true); setErr('')
    const { error } = await supabase
      .from('brands')
      .update({ notes: editing.notes })
      .eq('id', editing.id)
    if (error) setErr(error.message)
    else setEditing(null)
    setBusy(false)
  }

  async function removeBrand(id, brandName) {
    if (!confirm(`Hapus brand "${brandName}"?`)) return
    const { error } = await supabase.from('brands').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">🏷 Brands</h1>
      <p className="text-sm text-[var(--muted)] mb-6">
        Product knowledge per brand. Disinkronkan <strong>real-time</strong> ke semua member workspace —
        open 2 tab, edit di satu, langsung muncul di tab lain.
      </p>

      <form onSubmit={createBrand} className="flex gap-2 mb-6 max-w-md">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Nama brand (mis. AceKid)"
          className="flex-1 px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--accent)]"
        />
        <button type="submit" disabled={busy || !name.trim()}
          className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
          + Bikin
        </button>
      </form>

      {err && <div className="mb-4 text-xs text-red-400">⚠ {err}</div>}

      <div className="space-y-3 max-w-3xl">
        {brands.length === 0 ? (
          <div className="text-sm text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded-lg text-center">
            Belum ada brand. Bikin satu di atas ☝️
          </div>
        ) : brands.map((b) => (
          <div key={b.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">{b.name}</div>
              <div className="flex gap-3 text-xs">
                {editing?.id !== b.id && (
                  <button onClick={() => setEditing({ id: b.id, notes: b.notes || '' })}
                    className="text-[var(--muted)] hover:text-white underline">✏️ Edit notes</button>
                )}
                <button onClick={() => removeBrand(b.id, b.name)}
                  className="text-red-400 hover:text-red-300 underline">🗑 Hapus</button>
              </div>
            </div>

            {editing?.id === b.id ? (
              <div className="space-y-2">
                <textarea rows={7} value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  placeholder={'Isi product knowledge:\n• NAMA & VARIAN: AceKid Activegro - kaleng 130g & 400g\n• TEKS KEMASAN (persis): "AceKid", "Activegro", "3+ Years"\n• WARNA & CIRI: kaleng biru-kuning, tutup biru\n• ATURAN VISUAL: kaleng tegak, logo hadap kamera, jangan distorsi\n• TARGET & TONE: ibu muda, hangat & relatable'}
                  className="w-full text-xs px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
                />
                <div className="flex gap-2">
                  <button onClick={saveNotes} disabled={busy}
                    className="px-3 py-1.5 rounded bg-[var(--accent)] text-white text-xs font-semibold disabled:opacity-50">
                    💾 Save
                  </button>
                  <button onClick={() => setEditing(null)}
                    className="px-3 py-1.5 rounded bg-[var(--surface2)] text-xs">Cancel</button>
                </div>
              </div>
            ) : b.notes ? (
              <div className="text-xs text-[var(--muted)] whitespace-pre-wrap line-clamp-4">{b.notes}</div>
            ) : (
              <div className="text-xs text-[var(--muted2)] italic">
                Belum ada knowledge — klik ✏️ Edit notes buat tambah info produk
              </div>
            )}

            <div className="text-[10px] text-[var(--muted2)] mt-3 pt-2 border-t border-[var(--border)]">
              {new Date(b.created_at).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
