'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()
  const [mode, setMode] = useState('signin')
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
    <main className="min-h-screen relative flex items-center justify-center p-6 overflow-hidden bg-[var(--bg)]">
      {/* Scoped login animations — pure CSS so the screen stays light. GPU-only
          properties (transform/opacity) to avoid jank on weak machines, and
          fully disabled under prefers-reduced-motion. */}
      <style>{`
        @keyframes loginOrbDrift {
          0%   { transform: translate3d(0,0,0) scale(1); }
          50%  { transform: translate3d(4rem,-3rem,0) scale(1.08); }
          100% { transform: translate3d(-3rem,2rem,0) scale(0.96); }
        }
        @keyframes loginAurora {
          0%   { transform: rotate(0deg) scale(1.4); opacity: .14; }
          50%  { opacity: .22; }
          100% { transform: rotate(360deg) scale(1.4); opacity: .14; }
        }
        @keyframes loginScan {
          0%   { transform: translateY(-110vh); }
          100% { transform: translateY(110vh); }
        }
        .login-orb { animation: loginOrbDrift 16s ease-in-out infinite alternate; will-change: transform; }
        .login-aurora { animation: loginAurora 38s linear infinite; will-change: transform, opacity; }
        .login-scan { animation: loginScan 9s linear infinite; will-change: transform; }
        @media (prefers-reduced-motion: reduce) {
          .login-orb, .login-aurora, .login-scan { animation: none; }
        }
      `}</style>

      {/* Rotating aurora sheet — the "web3" depth layer behind everything */}
      <div className="absolute inset-0 pointer-events-none -z-20 overflow-hidden">
        <div className="login-aurora absolute left-1/2 top-1/2 w-[140vmax] h-[140vmax] -ml-[70vmax] -mt-[70vmax] rounded-full"
             style={{ background: 'conic-gradient(from 0deg, transparent 0%, rgba(168,85,247,0.5) 12%, transparent 28%, rgba(6,182,212,0.35) 46%, transparent 60%, rgba(217,70,239,0.45) 78%, transparent 100%)', filter: 'blur(110px)' }} />
      </div>

      {/* Ambient halo orbs — now drifting slowly for a living background */}
      <div className="absolute inset-0 pointer-events-none -z-10">
        <div className="login-orb absolute top-[-20%] left-[-10%] w-[60rem] h-[60rem] rounded-full opacity-40"
             style={{ background: 'radial-gradient(closest-side, var(--accent-glow) 0%, transparent 70%)', filter: 'blur(80px)' }} />
        <div className="login-orb absolute bottom-[-20%] right-[-10%] w-[55rem] h-[55rem] rounded-full opacity-35"
             style={{ background: 'radial-gradient(closest-side, rgba(217,70,239,0.45) 0%, transparent 70%)', filter: 'blur(90px)', animationDelay: '-6s', animationDuration: '20s' }} />
        <div className="login-orb absolute top-[30%] right-[15%] w-[30rem] h-[30rem] rounded-full opacity-25"
             style={{ background: 'radial-gradient(closest-side, rgba(6,182,212,0.4) 0%, transparent 70%)', filter: 'blur(70px)', animationDelay: '-11s', animationDuration: '13s' }} />
      </div>

      {/* Subtle grid backdrop + scanning light beam sweeping down it */}
      <div className="absolute inset-0 -z-10 opacity-[0.05] pointer-events-none"
           style={{
             backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
             backgroundSize: '40px 40px',
             maskImage: 'radial-gradient(ellipse 90% 70% at 50% 45%, black 30%, transparent 75%)',
             WebkitMaskImage: 'radial-gradient(ellipse 90% 70% at 50% 45%, black 30%, transparent 75%)',
           }} />
      <div className="absolute inset-x-0 -z-10 pointer-events-none overflow-hidden" style={{ top: 0, bottom: 0 }}>
        <div className="login-scan absolute inset-x-0 h-40 opacity-[0.12]"
             style={{ background: 'linear-gradient(180deg, transparent, rgba(217,70,239,0.7) 50%, transparent)' }} />
      </div>

      {/* Left side — brand hero (hidden on mobile) */}
      <div className="hidden lg:flex flex-col gap-5 max-w-md mr-12 select-none">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 self-start text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--accent)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          AI Video Studio · v3
        </div>
        <h1 className="text-5xl xl:text-6xl font-extrabold leading-[1.05] tracking-tight">
          <span className="gradient-text-strong">Build cinematic</span>
          <br />
          <span className="text-[var(--text)]">brand content.</span>
        </h1>
        <p className="text-base text-[var(--muted)] leading-relaxed max-w-sm">
          Conversational AI agent yang bantu lo bikin video iklan dari ide. 18 tools, multi-brand, persona LoRA training, viral campaign generator.
        </p>
        <div className="flex gap-4 mt-2 text-[10px] uppercase tracking-wider font-semibold text-[var(--muted2)]">
          <div className="flex items-center gap-1.5"><span className="text-[var(--accent)]">●</span> Multi-brand workspace</div>
          <div className="flex items-center gap-1.5"><span className="text-[var(--accent)]">●</span> Soul LoRA</div>
          <div className="flex items-center gap-1.5"><span className="text-[var(--accent)]">●</span> God Mode</div>
        </div>
      </div>

      {/* Login card — glassmorphic, gradient ring border */}
      <div className="relative w-full max-w-sm">
        {/* Outer glow */}
        <div className="absolute -inset-0.5 rounded-2xl opacity-50 blur-md"
             style={{ background: 'linear-gradient(135deg, var(--purple), var(--magenta), var(--purple))' }} />
        <form
          onSubmit={submit}
          className="relative w-full space-y-4 rounded-2xl p-8 backdrop-blur-2xl"
          style={{
            background: 'linear-gradient(180deg, rgba(22,15,38,0.85) 0%, rgba(28,21,50,0.75) 100%)',
            border: '1px solid rgba(168,85,247,0.25)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-[0.25em] font-bold text-[var(--accent)] mb-2 lg:hidden">CAK Video Studio</div>
            <h2 className="text-3xl font-extrabold tracking-tight">
              {mode === 'signup' ? (
                <>
                  Bikin <span className="gradient-text-strong">akun</span>
                </>
              ) : (
                <>
                  <span className="gradient-text-strong">Welcome</span> back
                </>
              )}
            </h2>
            <p className="text-xs text-[var(--muted)]">
              {mode === 'signup' ? 'Sign up gratis, akses semua tools langsung.' : 'Sign in ke workspace lo.'}
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--muted)]">Email</label>
              <input
                type="email" required placeholder="you@brand.com"
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[var(--surface2)]/70 border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] focus:bg-[var(--surface2)] focus:shadow-[0_0_0_3px_var(--accent-soft)] transition-all text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--muted)]">Password</label>
              <input
                type="password" required minLength={6} placeholder="min 6 karakter"
                value={pw} onChange={(e) => setPw(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[var(--surface2)]/70 border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] focus:bg-[var(--surface2)] focus:shadow-[0_0_0_3px_var(--accent-soft)] transition-all text-sm"
              />
            </div>
          </div>

          <button
            disabled={busy} type="submit"
            className="w-full py-3 mt-1 rounded-lg font-bold text-sm relative overflow-hidden group transition-all disabled:opacity-50"
            style={{
              background: 'linear-gradient(135deg, var(--purple) 0%, var(--magenta) 100%)',
              boxShadow: '0 8px 24px rgba(217,70,239,0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
              color: '#fff',
            }}
          >
            {busy ? (
              <span className="inline-flex items-center gap-2"><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Loading...</span>
            ) : (
              <>{mode === 'signup' ? '🚀 Sign up' : '→ Sign in'}</>
            )}
          </button>

          {msg && (
            <div className={`text-xs rounded-lg px-3 py-2 ${
              msg.startsWith('✅')
                ? 'bg-green-500/10 border border-green-500/30 text-green-300'
                : 'bg-red-500/10 border border-red-500/30 text-red-300'
            }`}>
              {msg}
            </div>
          )}

          <div className="pt-2 border-t border-[var(--border)] text-center">
            <button
              type="button"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
              className="text-xs text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
            >
              {mode === 'signin' ? (
                <>Belum punya akun? <span className="text-[var(--accent)] font-semibold">Sign up</span></>
              ) : (
                <>Udah punya akun? <span className="text-[var(--accent)] font-semibold">Sign in</span></>
              )}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
