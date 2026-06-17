'use client'
import { useState } from 'react'

// Collapsible disclosure for advanced/secondary controls. Keeps the primary
// flow clean while keeping every feature one click away (progressive disclosure).
export default function AdvancedPanel({ children, label = 'Opsi lanjutan', defaultOpen = false, className = '' }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`rounded-xl border border-[var(--border)] ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-semibold text-[var(--muted)] hover:text-[var(--text)] transition-colors"
      >
        <span>⚙️ {label}</span>
        <span className="text-[10px]">{open ? '▲ tutup' : '▼ buka'}</span>
      </button>
      {open && <div className="border-t border-[var(--border)] p-3 flex flex-col gap-3">{children}</div>}
    </div>
  )
}
