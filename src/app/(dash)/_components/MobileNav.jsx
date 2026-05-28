'use client'
import { useState, useEffect } from 'react'

// Mobile hamburger toggle for sidebar. Only renders on small screens.
export default function MobileNav({ children }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Close when route changes (link clicked)
    function onClick(e) {
      if (e.target.tagName === 'A') setOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center"
        aria-label="Open menu">
        ☰
      </button>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setOpen(false)}>
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-[var(--surface)] border-r border-[var(--border)] p-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} className="absolute top-2 right-2 w-8 h-8 rounded text-[var(--muted)] hover:text-white">✕</button>
            {children}
          </aside>
        </div>
      )}
    </>
  )
}
