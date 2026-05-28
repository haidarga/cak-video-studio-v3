'use client'
import { useEffect, useState } from 'react'

export default function ThemeToggle() {
  const [theme, setTheme] = useState('dark')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    // Load saved theme or detect system preference
    const saved = localStorage.getItem('cak_theme')
    let initial
    if (saved === 'dark' || saved === 'light') initial = saved
    else initial = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    setTheme(initial)
    document.documentElement.setAttribute('data-theme', initial)
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('cak_theme', next)
  }

  if (!mounted) return null

  return (
    <button onClick={toggle}
      className="w-full text-xs px-3 py-1.5 rounded bg-[var(--surface2)] hover:bg-[var(--surface3)] border border-[var(--border)] flex items-center justify-center gap-2 transition-all"
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
      <span className="text-base">{theme === 'dark' ? '🌙' : '☀️'}</span>
      <span className="font-medium">{theme === 'dark' ? 'Dark' : 'Light'} mode</span>
      <span className="ml-auto text-[var(--muted)] text-[10px]">click</span>
    </button>
  )
}
