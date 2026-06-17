'use client'
import { useUiMode } from '@/lib/ui-mode'

// Simple ↔ Pro switch. Simple = new-user friendly (primary flow only); Pro =
// every control visible (today's behavior). Persisted + synced globally.
export default function ModeToggle({ className = '' }) {
  const [mode, setMode] = useUiMode()
  return (
    <div
      role="group"
      aria-label="Tampilan Simple atau Pro"
      className={`inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] p-0.5 text-[11px] font-semibold ${className}`}
    >
      {[['simple', '✨ Simple'], ['pro', '⚙️ Pro']].map(([m, label]) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          className={`rounded-full px-3 py-1 transition-colors ${
            mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
