'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

function generateCode() {
  // Easy-to-read code: 8 chars from A-Z + 2-9 (no confusing 0/O/1/I/L)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

export default function TeamClient({ workspaceId, workspaceName, userId, myRole, members, invites: initialInvites }) {
  const supabase = createClient()
  const [invites, setInvites] = useState(initialInvites)
  const [creating, setCreating] = useState(false)
  const [newRole, setNewRole] = useState('editor')
  const [expiresIn, setExpiresIn] = useState('7d')
  const [err, setErr] = useState('')
  const [redeemCode, setRedeemCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemMsg, setRedeemMsg] = useState('')

  async function createInvite() {
    setCreating(true); setErr('')
    const code = generateCode()
    const expiresAt = expiresIn === 'never' ? null
      : new Date(Date.now() + (expiresIn === '1d' ? 1 : expiresIn === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase.from('workspace_invites').insert({
      workspace_id: workspaceId, code, role: newRole,
      expires_at: expiresAt, created_by: userId,
    }).select('*').single()
    if (error) setErr(error.message)
    else setInvites((p) => [data, ...p])
    setCreating(false)
  }

  async function revokeInvite(id) {
    if (!confirm('Revoke invite ini?')) return
    const { error } = await supabase.from('workspace_invites').delete().eq('id', id)
    if (error) setErr(error.message)
    else setInvites((p) => p.filter((i) => i.id !== id))
  }

  async function redeemInvite() {
    setRedeeming(true); setRedeemMsg(''); setErr('')
    try {
      const res = await fetch('/api/invites/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: redeemCode }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      setRedeemMsg(`✓ Joined workspace "${data.workspace?.name}" as ${data.role}!`)
      setRedeemCode('')
      setTimeout(() => location.reload(), 1500)
    } catch (e) { setErr('Redeem: ' + e.message) }
    setRedeeming(false)
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => alert(`Code "${code}" copied to clipboard`))
  }

  const isOwner = myRole === 'owner'

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-1">👥 Team</h1>
        <p className="text-sm text-[var(--muted)]">Workspace <strong>{workspaceName}</strong> · {members.length} member{members.length !== 1 ? 's' : ''}</p>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      {/* Redeem invite code section */}
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-5">
        <h2 className="text-sm font-bold mb-2">🎟 Join Another Workspace</h2>
        <p className="text-xs text-[var(--muted)] mb-3">Punya invite code dari teman? Paste di sini buat join workspace mereka.</p>
        <div className="flex gap-2">
          <input value={redeemCode} onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
            placeholder="ABCD1234"
            className="flex-1 text-sm font-mono px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] tracking-widest" />
          <button onClick={redeemInvite} disabled={redeeming || !redeemCode.trim()}
            className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {redeeming ? '⏳' : 'Redeem'}
          </button>
        </div>
        {redeemMsg && <div className="mt-2 text-xs text-green-400">{redeemMsg}</div>}
      </section>

      {/* Members list */}
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">Current Members ({members.length})</h2>
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.user_id} className="flex items-center gap-3 text-sm">
              <div className="w-8 h-8 rounded-full bg-[var(--surface2)] flex items-center justify-center text-xs font-bold">
                {m.user_id === userId ? '👤' : '👥'}
              </div>
              <div className="flex-1">
                <div className="font-mono text-xs">{m.user_id === userId ? 'You' : m.user_id.slice(0, 8) + '...'}</div>
                <div className="text-[10px] text-[var(--muted)]">Joined {new Date(m.added_at).toLocaleDateString()}</div>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${m.role === 'owner' ? 'bg-amber-500/20 text-amber-400 border-amber-500/40' : m.role === 'editor' ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'bg-gray-500/20 text-gray-400 border-gray-500/40'}`}>
                {m.role}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Invite codes */}
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold">🎟 Invite Codes ({invites.length})</h2>
        </div>

        {/* Create invite form */}
        <div className="flex items-end gap-2 mb-4 p-3 bg-[var(--surface2)]/50 rounded">
          <div className="flex-1">
            <label className="block text-[9px] uppercase text-[var(--muted)] font-semibold mb-1">Role buat invite</label>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
              className="w-full text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">
              <option value="viewer">👁 Viewer (read-only)</option>
              <option value="editor">✏️ Editor (default)</option>
              {isOwner && <option value="owner">👑 Owner (full access)</option>}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-[9px] uppercase text-[var(--muted)] font-semibold mb-1">Expires</label>
            <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}
              className="w-full text-sm px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">
              <option value="1d">1 hari</option>
              <option value="7d">7 hari (default)</option>
              <option value="30d">30 hari</option>
              <option value="never">Never expires</option>
            </select>
          </div>
          <button onClick={createInvite} disabled={creating}
            className="px-4 py-1.5 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {creating ? '⏳' : '+ Generate code'}
          </button>
        </div>

        <div className="space-y-1.5">
          {invites.length === 0 ? (
            <div className="text-xs text-[var(--muted)] p-3">Belum ada invite. Generate code di atas buat ngajak team.</div>
          ) : invites.map((inv) => {
            const isUsed = !!inv.used_by
            const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date()
            return (
              <div key={inv.id} className={`flex items-center gap-2 p-2 rounded text-sm ${isUsed || isExpired ? 'opacity-50' : 'bg-[var(--surface2)]/40'}`}>
                <code className="font-mono font-bold text-base tracking-widest">{inv.code}</code>
                <button onClick={() => copyCode(inv.code)} className="text-[10px] px-2 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--border)]">📋 Copy</button>
                <span className={`text-[10px] px-2 py-0.5 rounded border ${inv.role === 'editor' ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'bg-gray-500/20 text-gray-400 border-gray-500/40'}`}>{inv.role}</span>
                <span className="text-[10px] text-[var(--muted)] ml-auto">
                  {isUsed ? `Used ${new Date(inv.used_at).toLocaleDateString()}` : isExpired ? 'Expired' : inv.expires_at ? `Expires ${new Date(inv.expires_at).toLocaleDateString()}` : 'Never expires'}
                </span>
                {!isUsed && <button onClick={() => revokeInvite(inv.id)} className="text-[10px] text-red-400 hover:underline">Revoke</button>}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
