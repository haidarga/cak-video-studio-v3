'use client'
import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function ActiveBrandWidget({ workspaceId, activeBrandId, brands: initialBrands }) {
  const router = useRouter()
  const supabase = createClient()
  const [brands, setBrands] = useState(initialBrands || [])
  const [activeId, setActiveId] = useState(activeBrandId)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  // Mirrors activeId for use inside event handlers, so the realtime callback
  // doesn't need a stale-closure-prone dependency on state.
  const activeIdRef = useRef(activeBrandId)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    const ch = supabase.channel('sb-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brands', filter: `workspace_id=eq.${workspaceId}` }, async () => {
        const { data } = await supabase.from('brands').select('id, name').eq('workspace_id', workspaceId).order('created_at')
        if (data) setBrands(data)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workspaces', filter: `id=eq.${workspaceId}` }, (p) => {
        const next = p.new.active_brand_id
        // Compare against a ref, not inside a setState updater. router.refresh()
        // is a side effect, and React StrictMode double-invokes updaters — so
        // the previous version fired the refresh twice in dev.
        if (next === activeIdRef.current) return
        activeIdRef.current = next
        setActiveId(next)
        // Server-rendered pages (/generate, /qc, /personas) filter their content
        // by active_brand_id at FETCH time, so a switch made in another tab or
        // device has to re-run those queries — otherwise the sidebar shows the
        // new brand while the page still renders the old brand's personas.
        startTransition(() => router.refresh())
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId, router])

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  async function pick(id) {
    setOpen(false)
    if (id === activeIdRef.current) return // already active — don't re-fetch the world
    // OPTIMISTIC. The label used to wait for the DB round-trip before changing,
    // so every brand switch felt laggy before anything visibly happened. Flip it
    // immediately and roll back if the write fails.
    const previous = activeIdRef.current
    activeIdRef.current = id
    setActiveId(id)

    const { error } = await supabase.from('workspaces').update({ active_brand_id: id }).eq('id', workspaceId)
    if (error) {
      activeIdRef.current = previous
      setActiveId(previous)
      return
    }
    // Inside a transition so the page stays interactive while the server
    // components re-fetch, instead of freezing. `pending` drives the indicator.
    startTransition(() => router.refresh())
  }

  const active = brands.find((b) => b.id === activeId)

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors">
        <div className="text-[9px] uppercase text-[var(--muted2)] tracking-wider font-semibold">Brand aktif</div>
        <div className="flex items-center justify-between gap-2">
          <div className={`text-sm font-bold truncate transition-opacity ${pending ? 'opacity-60' : ''} ${active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}>
            {active ? `🏷 ${active.name}` : 'Pilih brand'}
          </div>
          {/* The name already switched (optimistic); this only signals that the
              page content behind it is still catching up. */}
          <div className="text-[var(--muted)] text-xs">{pending ? '⟳' : '▼'}</div>
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
              Belum ada brand. <Link href="/brands" className="underline text-[var(--accent)]" onClick={() => setOpen(false)}>Bikin di tab Brands</Link>
            </div>
          ) : (
            brands.map((b) => (
              <button key={b.id} onClick={() => pick(b.id)}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface2)] ${b.id === activeId ? 'text-[var(--accent)] font-semibold bg-[var(--surface2)]' : ''}`}>
                {b.id === activeId && '✓ '}{b.name}
              </button>
            ))
          )}
          {/* <Link>, not <a> — a bare anchor triggers a FULL document reload
              (fresh JS bundle, fresh RSC payload, lost client state), which is a
              large part of why moving around felt slow. */}
          <Link href="/brands" onClick={() => setOpen(false)}
            className="block px-3 py-2 text-[10px] text-[var(--muted)] hover:bg-[var(--surface2)] border-t border-[var(--border)]">
            + Manage brands
          </Link>
        </div>
      )}
    </div>
  )
}
