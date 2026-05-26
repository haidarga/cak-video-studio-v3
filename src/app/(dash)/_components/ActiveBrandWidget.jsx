'use client'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function ActiveBrandWidget({ workspaceId, activeBrandId, brands: initialBrands }) {
  const supabase = createClient()
  const [brands, setBrands] = useState(initialBrands || [])
  const [activeId, setActiveId] = useState(activeBrandId)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const ch = supabase.channel('sb-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brands', filter: `workspace_id=eq.${workspaceId}` }, async () => {
        const { data } = await supabase.from('brands').select('id, name').eq('workspace_id', workspaceId).order('created_at')
        if (data) setBrands(data)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workspaces', filter: `id=eq.${workspaceId}` }, (p) => {
        setActiveId(p.new.active_brand_id)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  async function pick(id) {
    setOpen(false)
    const { error } = await supabase.from('workspaces').update({ active_brand_id: id }).eq('id', workspaceId)
    if (!error) setActiveId(id)
  }

  const active = brands.find((b) => b.id === activeId)

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors">
        <div className="text-[9px] uppercase text-[var(--muted2)] tracking-wider font-semibold">Brand aktif</div>
        <div className="flex items-center justify-between gap-2">
          <div className={`text-sm font-bold truncate ${active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}>
            {active ? `🏷 ${active.name}` : 'Pilih brand'}
          </div>
          <div className="text-[var(--muted)] text-xs">▼</div>
        </div>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded shadow-xl max-h-72 overflow-y-auto">
          <button onClick={() => pick(null)}
            className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface2)] ${!activeId ? 'text-[var(--accent)] font-semibold' : 'text-[var(--muted)]'}`}>
            ⊘ Tanpa brand
          </button>
          {brands.length === 0 ? (
            <div className="px-3 py-3 text-[10px] text-[var(--muted2)]">
              Belum ada brand. <a href="/brands" className="underline text-[var(--accent)]" onClick={() => setOpen(false)}>Bikin di tab Brands</a>
            </div>
          ) : (
            brands.map((b) => (
              <button key={b.id} onClick={() => pick(b.id)}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface2)] ${b.id === activeId ? 'text-[var(--accent)] font-semibold bg-[var(--surface2)]' : ''}`}>
                {b.id === activeId && '✓ '}{b.name}
              </button>
            ))
          )}
          <a href="/brands" onClick={() => setOpen(false)}
            className="block px-3 py-2 text-[10px] text-[var(--muted)] hover:bg-[var(--surface2)] border-t border-[var(--border)]">
            + Manage brands
          </a>
        </div>
      )}
    </div>
  )
}
