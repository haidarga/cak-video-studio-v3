'use client'
import { useEffect, useState } from 'react'

// Workspace API keys management. Never displays the actual key values —
// only whether they're set. User types a new value to overwrite, empty to clear.
export default function SettingsClient({ initialStatus, initialBudget }) {
  const [status, setStatus] = useState(initialStatus)
  const [keys, setKeys] = useState({ fal_key: '', gemini_key: '', postiz_url: status.postiz_url || '', postiz_key: '', elevenlabs_key: '' })
  const [budget, setBudget] = useState(initialBudget || { daily_limit_usd: 50, monthly_limit_usd: 500, alert_at_pct: 80 })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  // Postiz accounts state — N akun per workspace (multi-instance support).
  const [accounts, setAccounts] = useState([])
  const [acctLoading, setAcctLoading] = useState(true)
  const [newAcct, setNewAcct] = useState({ label: '', url: '', api_key: '' })
  const [editingAcct, setEditingAcct] = useState(null) // { id, label, url, api_key }

  async function loadAccounts() {
    setAcctLoading(true)
    try {
      const r = await fetch('/api/workspace/postiz-accounts')
      const j = await r.json()
      if (j.ok) setAccounts(j.accounts || [])
    } catch (e) { setErr('Load accounts: ' + e.message) }
    setAcctLoading(false)
  }
  useEffect(() => { loadAccounts() }, [])

  async function addAccount() {
    if (!newAcct.url.trim() || !newAcct.api_key.trim()) { setErr('URL + API key wajib'); return }
    setBusy(true); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/workspace/postiz-accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAcct),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setNewAcct({ label: '', url: '', api_key: '' })
      await loadAccounts()
      setMsg('Postiz account ditambahin ✓'); setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  async function saveAcctEdit() {
    if (!editingAcct) return
    setBusy(true); setMsg(''); setErr('')
    try {
      const body = { id: editingAcct.id, label: editingAcct.label, url: editingAcct.url }
      if (editingAcct.api_key) body.api_key = editingAcct.api_key
      const r = await fetch('/api/workspace/postiz-accounts', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setEditingAcct(null)
      await loadAccounts()
      setMsg('Updated ✓'); setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  async function deleteAccount(id, label) {
    if (!confirm(`Hapus Postiz account "${label}"? Personas yang ke-link bakal kehilangan channel routing-nya.`)) return
    setBusy(true); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/workspace/postiz-accounts', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      await loadAccounts()
      setMsg('Deleted ✓'); setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  async function saveBudget() {
    setBusy(true); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/workspace/budget', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          daily_limit_usd: Number(budget.daily_limit_usd),
          monthly_limit_usd: Number(budget.monthly_limit_usd),
          alert_at_pct: Number(budget.alert_at_pct),
        }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'budget save failed')
      setMsg('Budget saved ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

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
          <div className="text-xs font-semibold mb-2 flex items-center gap-2">
            🛑 Budget hard-limits
            <span className="text-[9px] font-normal text-[var(--muted2)]">(0 = unlimited)</span>
          </div>
          <div className="text-[10px] text-[var(--muted2)] mb-2">
            API call ke fal.ai / ElevenLabs / Gemini auto-ditolak (HTTP 402) kalau bakal nge-lewat limit. Cek pace di sidebar widget atau /dashboard.
          </div>
          <div className="grid grid-cols-3 gap-2">
            <BudgetField label="Daily ($)" value={budget.daily_limit_usd} onChange={(v) => setBudget((p) => ({ ...p, daily_limit_usd: v }))} />
            <BudgetField label="Monthly ($)" value={budget.monthly_limit_usd} onChange={(v) => setBudget((p) => ({ ...p, monthly_limit_usd: v }))} />
            <BudgetField label="Alert at (%)" value={budget.alert_at_pct} onChange={(v) => setBudget((p) => ({ ...p, alert_at_pct: v }))} max={100} />
          </div>
          <button onClick={saveBudget} disabled={busy} className="mt-2 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
            Save Budget
          </button>
        </div>

        <div className="pt-3 border-t border-[var(--border)]">
          <div className="text-xs font-semibold mb-1 flex items-center gap-2">
            📮 Postiz Accounts
            <span className="text-[9px] font-normal text-[var(--muted2)]">multi-instance (1 workspace bisa nyambung ke N Postiz)</span>
          </div>
          <div className="text-[10px] text-[var(--muted2)] mb-2">
            Tiap Postiz instance = 1 row. Label-in (misal "IG Postiz", "TikTok Postiz") biar pas pilih channel di Mirror tau yang mana. Persona yang lu link ke channel otomatis pakai creds account ini.
          </div>

          {/* Existing accounts list */}
          {acctLoading ? (
            <div className="text-xs text-[var(--muted)] py-2">Loading...</div>
          ) : accounts.length === 0 ? (
            <div className="text-xs text-[var(--muted)] py-3 px-3 border border-dashed border-[var(--border)] rounded">Belum ada Postiz account. Tambahin di bawah ⬇</div>
          ) : (
            <div className="space-y-2 mb-3">
              {accounts.map((a) => editingAcct?.id === a.id ? (
                <div key={a.id} className="p-3 rounded bg-[var(--surface2)] border border-[var(--accent)] space-y-1.5">
                  <input value={editingAcct.label} onChange={(e) => setEditingAcct({ ...editingAcct, label: e.target.value })} placeholder="Label" className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]" />
                  <input value={editingAcct.url} onChange={(e) => setEditingAcct({ ...editingAcct, url: e.target.value })} placeholder="https://..." className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] font-mono" />
                  <input type="password" value={editingAcct.api_key || ''} onChange={(e) => setEditingAcct({ ...editingAcct, api_key: e.target.value })} placeholder="•••••••• (kosongin = keep)" className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] font-mono" />
                  <div className="flex gap-1.5">
                    <button onClick={saveAcctEdit} disabled={busy} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">Save</button>
                    <button onClick={() => setEditingAcct(null)} className="text-[10px] px-2 py-1 rounded text-[var(--muted)] hover:bg-[var(--surface3)]">Cancel</button>
                  </div>
                </div>
              ) : (
                <div key={a.id} className="p-2 rounded bg-[var(--surface2)] border border-[var(--border)] flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold flex items-center gap-1.5">
                      📮 {a.label} <span className="text-[9px] text-green-400">{a.has_key ? '✓ Set' : '⚠ Missing key'}</span>
                    </div>
                    <div className="text-[10px] text-[var(--muted)] font-mono truncate">{a.url}</div>
                  </div>
                  <button onClick={() => setEditingAcct({ id: a.id, label: a.label, url: a.url, api_key: '' })} className="text-[10px] px-2 py-1 rounded bg-[var(--surface3)] hover:bg-[var(--surface)]">Edit</button>
                  <button onClick={() => deleteAccount(a.id, a.label)} className="text-[10px] px-2 py-1 rounded text-red-400 border border-[var(--border)] hover:bg-red-900/20">✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Add form */}
          <div className="p-3 rounded bg-[var(--surface2)]/30 border border-dashed border-[var(--border)] space-y-1.5">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">+ Tambah Postiz account</div>
            <input value={newAcct.label} onChange={(e) => setNewAcct({ ...newAcct, label: e.target.value })}
              placeholder='Label (misal "IG Postiz")'
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]" />
            <input value={newAcct.url} onChange={(e) => setNewAcct({ ...newAcct, url: e.target.value })}
              placeholder="https://your-postiz-or-proxy-url"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] font-mono" />
            <input type="password" value={newAcct.api_key} onChange={(e) => setNewAcct({ ...newAcct, api_key: e.target.value })}
              placeholder="Postiz API key"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] font-mono" />
            <button onClick={addAccount} disabled={busy || !newAcct.url || !newAcct.api_key}
              className="text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-40">
              + Tambah
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function BudgetField({ label, value, onChange, max }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-1">{label}</div>
      <input type="number" min={0} {...(max ? { max } : {})} step={1} value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] font-mono" />
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
