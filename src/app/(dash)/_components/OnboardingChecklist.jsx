'use client'
import { useEffect, useState } from 'react'

const STEPS = [
  { id: 'persona', label: 'Bikin persona', emoji: '🎭', href: '/personas', hint: 'Klik 📚 Templates buat quick-start' },
  { id: 'generate', label: 'Generate video', emoji: '⚡', href: '/generate', hint: 'Pilih persona → naskah → Parse → Gen Images → Approve → Gen Videos' },
  { id: 'qc', label: 'Approve di QC', emoji: '🧪', href: '/qc', hint: 'Centang batch + Approve All' },
  { id: 'editor', label: 'Edit (optional)', emoji: '✂️', href: '/editor', hint: 'Trim + add music + subtitle' },
  { id: 'schedule', label: 'Schedule/Post', emoji: '📅', href: '/scheduled', hint: 'Mirror ke banyak channel' },
]

export default function OnboardingChecklist() {
  const [completed, setCompleted] = useState(new Set())
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(true) // start dismissed, opt-in via local check

  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem('cak_onboarding') || '{"completed":[],"dismissed":false}')
    setCompleted(new Set(saved.completed || []))
    setDismissed(saved.dismissed || false)
  }, [])

  function toggle(stepId) {
    setCompleted((s) => {
      const n = new Set(s)
      n.has(stepId) ? n.delete(stepId) : n.add(stepId)
      const next = [...n]
      localStorage.setItem('cak_onboarding', JSON.stringify({ completed: next, dismissed }))
      return n
    })
  }

  function dismiss() {
    setDismissed(true)
    localStorage.setItem('cak_onboarding', JSON.stringify({ completed: [...completed], dismissed: true }))
  }

  if (dismissed) return null
  const allDone = STEPS.every((s) => completed.has(s.id))

  return (
    <div className="bg-gradient-to-br from-purple-500/10 to-pink-500/10 border border-purple-500/30 rounded-lg p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setCollapsed(!collapsed)} className="text-[10px] uppercase font-bold tracking-wider text-purple-300 flex items-center gap-1">
          {collapsed ? '▶' : '▼'} {allDone ? '🎉 All done!' : `Getting started (${completed.size}/${STEPS.length})`}
        </button>
        <button onClick={dismiss} className="text-[9px] text-[var(--muted)] hover:text-white" title="Dismiss forever">✕</button>
      </div>
      {!collapsed && (
        <div className="space-y-1">
          {STEPS.map((s) => {
            const done = completed.has(s.id)
            return (
              <div key={s.id} className={`flex items-start gap-1.5 ${done ? 'opacity-50' : ''}`}>
                <button onClick={() => toggle(s.id)} className="mt-0.5 w-3.5 h-3.5 rounded border border-[var(--border)] flex-shrink-0 flex items-center justify-center hover:border-[var(--accent)]">
                  {done && <span className="text-[10px] text-green-400">✓</span>}
                </button>
                <a href={s.href} className="flex-1 group">
                  <div className={`text-[11px] font-semibold ${done ? 'line-through' : 'group-hover:text-purple-300'}`}>
                    {s.emoji} {s.label}
                  </div>
                  {!done && <div className="text-[9px] text-[var(--muted)] mt-0.5">{s.hint}</div>}
                </a>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
