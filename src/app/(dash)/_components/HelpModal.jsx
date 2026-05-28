'use client'
import { useEffect, useState } from 'react'

const SHORTCUTS = [
  { section: 'Global', items: [
    { keys: ['Ctrl+K', '⌘K'], action: 'Open global search' },
    { keys: ['?'], action: 'Open this help modal' },
    { keys: ['Esc'], action: 'Close modal' },
  ]},
  { section: 'Editor — Playback', items: [
    { keys: ['Space'], action: 'Play / pause' },
    { keys: ['⏮'], action: 'Seek to start of project' },
  ]},
  { section: 'Editor — Clips', items: [
    { keys: ['Delete', 'Backspace'], action: 'Delete selected clip' },
    { keys: ['S'], action: 'Split selected clip at playhead' },
    { keys: ['Drag pill edge'], action: 'Trim clip start/end' },
    { keys: ['Drag pill middle (overlay)'], action: 'Move clip in time' },
    { keys: ['Click clip'], action: 'Select clip' },
    { keys: ['Drag video file → preview'], action: 'Quick-upload from desktop' },
  ]},
  { section: 'Editor — History', items: [
    { keys: ['Ctrl+Z', '⌘Z'], action: 'Undo' },
    { keys: ['Ctrl+Y', '⌘Y', 'Ctrl+Shift+Z'], action: 'Redo' },
  ]},
  { section: 'Navigation', items: [
    { keys: ['/'], action: 'Quick search (alternative)' },
    { keys: ['Click sidebar'], action: 'Navigate pages' },
  ]},
]

const TIPS = [
  '💸 Cost confirmation muncul sebelum gen video — selalu cek estimasi sebelum klik OK',
  '🎬 B-roll overlay = video di atas base. Pas tap "🎬 B-roll" di Media Library, video masuk track terpisah',
  '✂️ Pakai S buat split clip di tengah, terus delete bagian yang gak perlu',
  '✨ Auto-subtitle Gemini cuma transcribe base clip pertama saat ini (multi-clip support coming)',
  '🪞 Mirror upload di /scheduled bisa post 1 video ke banyak channel sekaligus',
  '📚 /personas → Templates buat quick-start dari 8 archetype yang udah disiapin',
  '👥 /team buat invite member via code — share code, mereka redeem',
  '🎯 Drag-drop video file ke preview area editor = quick upload',
]

export default function HelpModal() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault()
        setOpen(true)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6" onClick={() => setOpen(false)}>
      <div className="w-full max-w-3xl bg-[var(--surface)] border border-[var(--border)] rounded-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between sticky top-0 bg-[var(--surface)]">
          <h2 className="text-lg font-bold">⌨ Keyboard Shortcuts & Tips</h2>
          <button onClick={() => setOpen(false)} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {SHORTCUTS.map((sec) => (
            <div key={sec.section}>
              <div className="text-[10px] uppercase font-bold tracking-wider text-[var(--muted)] mb-2">{sec.section}</div>
              <div className="space-y-1.5">
                {sec.items.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <div className="flex gap-1 flex-wrap">
                      {item.keys.map((k) => (
                        <kbd key={k} className="px-1.5 py-0.5 rounded bg-[var(--surface2)] border border-[var(--border)] text-[10px] font-mono">{k}</kbd>
                      ))}
                    </div>
                    <span className="text-[var(--muted)] flex-1">{item.action}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 pb-6">
          <div className="text-[10px] uppercase font-bold tracking-wider text-[var(--muted)] mb-2">💡 Tips</div>
          <ul className="space-y-1 text-xs text-[var(--muted)]">
            {TIPS.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
        <div className="border-t border-[var(--border)] px-6 py-3 text-[10px] text-[var(--muted2)]">
          Press <kbd className="px-1 py-0.5 rounded bg-[var(--surface2)] border border-[var(--border)] font-mono">?</kbd> to reopen this anytime
        </div>
      </div>
    </div>
  )
}
