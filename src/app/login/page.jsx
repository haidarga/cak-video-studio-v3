'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setMsg('')
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password: pw })
        if (error) throw error
        setMsg('✅ Akun dibuat. Kalau email confirmation off, langsung sign in. Kalau on, cek inbox.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw })
        if (error) throw error
        router.push('/dashboard')
        router.refresh()
      }
    } catch (e) {
      setMsg('❌ ' + e.message)
    }
    setBusy(false)
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 bg-[var(--surface)] p-7 rounded-xl border border-[var(--border)]">
        <div>
          <h1 className="text-2xl font-bold">CAK Video Studio</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {mode === 'signup' ? 'Bikin akun buat platform tim creator' : 'Sign in ke workspace lu'}
          </p>
        </div>
        <input
          type="email" required placeholder="email"
          value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
        />
        <input
          type="password" required minLength={6} placeholder="password (min 6)"
          value={pw} onChange={(e) => setPw(e.target.value)}
          className="w-full px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
        />
        <button
          disabled={busy} type="submit"
          className="w-full py-2 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50"
        >
          {busy ? '...' : mode === 'signup' ? 'Sign up' : 'Sign in'}
        </button>
        {msg && <div className="text-xs text-[var(--muted)]">{msg}</div>}
        <button
          type="button"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
          className="text-xs text-[var(--muted)] underline w-full"
        >
          {mode === 'signin' ? 'Belum punya akun? Sign up' : 'Udah punya? Sign in'}
        </button>
      </form>
    </main>
  )
}
