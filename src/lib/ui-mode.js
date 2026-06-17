'use client'
// Global UI density mode: 'simple' (new-user friendly — primary flow only,
// advanced controls hidden) vs 'pro' (everything visible, today's behavior).
// Persisted per browser; synced across components + tabs via a custom event.
import { useState, useEffect, useCallback } from 'react'

const KEY = 'cak_ui_mode'
const EVT = 'cak-ui-mode-change'

export function getUiMode() {
  if (typeof window === 'undefined') return 'simple'
  return localStorage.getItem(KEY) === 'pro' ? 'pro' : 'simple'
}

export function useUiMode() {
  const [mode, setMode] = useState('simple')
  useEffect(() => {
    setMode(getUiMode())
    const onChange = () => setMode(getUiMode())
    window.addEventListener(EVT, onChange)
    window.addEventListener('storage', onChange) // cross-tab
    return () => {
      window.removeEventListener(EVT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  const set = useCallback((m) => {
    const next = m === 'pro' ? 'pro' : 'simple'
    localStorage.setItem(KEY, next)
    window.dispatchEvent(new Event(EVT))
  }, [])
  return [mode, set]
}
