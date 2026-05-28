'use client'
import { useState } from 'react'

// Workspace API keys management. Never displays the actual key values —
// only whether they're set. User types a new value to overwrite, empty to clear.
export default function SettingsClient({ initialStatus }) {
  const [status, setStatus] = useState(initialStatus)
  const [keys, setKeys] = useState({ fal_key: '', gemini_key: '', postiz_url: status.postiz_url || '', postiz_key: '', elevenlabs_key: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  function patch(k, v) { setKeys((p) => ({ ...p, [k]: v })) }

  async function save(only) {
    setBusy(true); setMsg(''); setErr('')
    const body = {}
    const fields = only ? [only] : ['fal_key', 'gemini_key', 'postiz_url', 'postiz_key', 'elevenlabs_key']
    for (const f of fields) {
      // skip fields the user didn't touch this round
      if (keys[f] !== '') body[f] = keys[f]
    }
    if (!Object.keys(body).length) { setErr('Gak ada perubahan'); setBusy(false); return }
    try {
      const r = await fetch('/api/workspace/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'save failed')
      // refresh status booleans
      const fr = await fetch('/api/workspace/settings')
      const fj = await fr.json()
      if (fj.ok) setStatus({
        has_fal: fj.has_fal, has_gemini: fj.has_gemini, has_postiz: fj.has_postiz,
        has_elevenlabs: fj.has_elevenlabs, postiz_url: fj.postiz_url || '', workspace_name: fj.name,
      })
      setKeys({ fal_key: '', gemini_key: '', postiz_url: fj.postiz_url || '', postiz_key: '', elevenlabs_key: '' })
      setMsg('Saved ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  async function clearKey(k) {
    if (!confirm(`Hapus ${k} dari workspace?`)) return
    setBusy(true); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/workspace/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [k]: '' }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      const fr = await fetch('/api/workspace/settings')
      const fj = await fr.json()
      if (fj.ok) setStatus({
        has_fal: fj.has_fal, has_gemini: fj.has_gemini, has_postiz: fj.has_postiz,
        has_elevenlabs: fj.has_elevenlabs, postiz_url: fj.postiz_url || '', workspace_name: fj.name,
      })
      setMsg('Cleared ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">⚙️ Settings</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          Workspace API keys — disimpan di Supabase, dipake oleh API routes server-side. Browser gak pernah liat key-nya.
        </p>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}
      {msg && <div className="text-xs text-green-400 bg-green-900/20 border border-green-900/40 p-3 rounded">✓ {msg}</div>}

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-5 space-y-4">
        <KeyRow label="fal.ai API Key" set={status.has_fal} value={keys.fal_key}
          onChange={(v) => patch('fal_key', v)} onSave={() => save('fal_key')} onClear={() => clearKey('fal_key')}
          placeholder="xxxxxxxx-xxxx-xxxx-..." help="Buat semua image/video gen (Kling, Seedance, Happy Horse, Nano Banana, GPT Image 2)." busy={busy} />

        <KeyRow label="Google Gemini API Key" set={status.has_gemini} value={keys.gemini_key}
          onChange={(v) => patch('gemini_key', v)} onSave={() => save('gemini_key')} onClear={() => clearKey('gemini_key')}
          placeholder="AIza..." help="Buat naskah parsing + caption drafting + transcribe." busy={busy} />

        <KeyRow label={<>🎙 ElevenLabs API Key <span className="text-[9px] text-[var(--accent)] font-bold">VOICE CLONE</span></>}
          set={status.has_elevenlabs} value={keys.elevenlabs_key}
          onChange={(v) => patch('elevenlabs_key', v)} onSave={() => save('elevenlabs_key')} onClear={() => clearKey('elevenlabs_key')}
          placeholder="sk_..." help="Buat clone voice persona + Speech-to-Speech (swap audio video AI ke voice cloned, lip-sync preserved)." busy={busy} />

        <div className="pt-3 border-t border-[var(--border)]">
          <div className="text-xs font-semibold mb-2">📮 Postiz (multi-channel publish)</div>
          <div className="space-y-2">
            <input value={keys.postiz_url} onChange={(e) => patch('postiz_url', e.target.value)}
              placeholder="https://your-postiz-instance.com"
              className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]" />
            <input type="password" value={keys.postiz_key} onChange={(e) => patch('postiz_key', e.target.value)}
              placeholder={status.has_postiz ? '••••••••' : 'Postiz API key'}
              className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]" />
            <div className="flex gap-2">
              <button onClick={() => save()} disabled={busy} className="text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
                Save Postiz
              </button>
              {status.has_postiz && (
                <button onClick={() => clearKey('postiz_key')} disabled={busy} className="text-xs px-3 py-1.5 rounded text-red-400 border border-[var(--border)]">
                  Clear
                </button>
              )}
              <span className="text-xs text-[var(--muted)] self-center">Status: {status.has_postiz ? '✓ Set' : '❌ Not set'}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function KeyRow({ label, set, value, onChange, onSave, onClear, placeholder, help, busy }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-semibold">{label}</label>
        <span className={`text-[10px] font-semibold ${set ? 'text-green-400' : 'text-[var(--muted2)]'}`}>
          {set ? '✓ Set' : '❌ Not set'}
        </span>
      </div>
      <div className="flex gap-2">
        <input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={set ? '•••••••• (re-enter to change)' : placeholder}
          className="flex-1 text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] font-mono" />
        <button onClick={onSave} disabled={busy || !value} className="text-xs px-3 py-2 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
          Save
        </button>
        {set && (
          <button onClick={onClear} disabled={busy} className="text-xs px-3 py-2 rounded text-red-400 border border-[var(--border)]">
            Clear
          </button>
        )}
      </div>
      {help && <div className="text-[10px] text-[var(--muted2)] mt-1">{help}</div>}
    </div>
  )
}
