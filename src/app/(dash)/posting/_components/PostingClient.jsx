'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function PostingClient({ workspaceId, initialPersonas }) {
  const supabase = createClient()
  const [personas, setPersonas] = useState(initialPersonas)
  const [channels, setChannels] = useState(null) // null = not synced yet
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState(null)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all') // all | connected | unconnected

  async function reloadPersonas() {
    const { data } = await supabase
      .from('personas')
      .select(`
        id, name, username, role_label, avatar_url,
        postiz_channel_id, postiz_channel_label, postiz_platform, postiz_account_id,
        persona_channels(id, channel_id, channel_label, platform, username, is_default, postiz_account_id)
      `)
      .eq('workspace_id', workspaceId).order('created_at', { ascending: false })
    if (data) setPersonas(data)
  }

  useEffect(() => {
    const ch = supabase.channel('posting-personas-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'personas', filter: `workspace_id=eq.${workspaceId}` }, reloadPersonas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'persona_channels' }, reloadPersonas)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, workspaceId])

  async function syncChannels() {
    setSyncing(true); setErr('')
    try {
      const res = await fetch('/api/postiz/channels', { cache: 'no-store' })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Sync gagal')
      setChannels(data.channels)
      setLastSync(new Date())
    } catch (e) { setErr(e.message) }
    setSyncing(false)
  }

  // Each persona can have N linked channels via persona_channels.
  const personaList = useMemo(() => {
    return personas.map((p) => {
      const links = (p.persona_channels || []).map((pc) => ({
        ...pc,
        // Match synced channel info (avatar, latest name) when available
        synced: channels?.find((c) => String(c.id) === String(pc.channel_id)),
      }))
      return { ...p, channelLinks: links, isConnected: links.length > 0 }
    })
  }, [personas, channels])

  // Channel IDs already linked to ANY persona — used to disable in dropdown
  // (still allow re-use if user wants, just visual hint).
  const takenChannelIds = useMemo(() => {
    const s = new Set()
    personas.forEach((p) => (p.persona_channels || []).forEach((pc) => s.add(String(pc.channel_id))))
    return s
  }, [personas])

  // Add a new channel link to a persona.
  async function addChannelLink(persona, channel) {
    setErr('')
    if (!channel?.id) return
    const { error } = await supabase.from('persona_channels').insert({
      persona_id: persona.id,
      postiz_account_id: channel.account_id || null,
      channel_id: String(channel.id),
      channel_label: channel.name,
      platform: channel.platform,
      username: channel.username,
      is_default: persona.channelLinks.length === 0, // first link auto-default
    })
    if (error) setErr(error.message)
  }

  // Remove a single channel link.
  async function removeChannelLink(linkId) {
    setErr('')
    const { error } = await supabase.from('persona_channels').delete().eq('id', linkId)
    if (error) setErr(error.message)
  }

  // Set one channel as default (unsets others for the same persona).
  async function setDefaultChannel(persona, linkId) {
    setErr('')
    const personaLinkIds = (persona.channelLinks || []).map((l) => l.id)
    // Unset all then set the chosen one
    if (personaLinkIds.length > 0) {
      const { error: e1 } = await supabase.from('persona_channels')
        .update({ is_default: false }).in('id', personaLinkIds)
      if (e1) { setErr(e1.message); return }
    }
    const { error: e2 } = await supabase.from('persona_channels')
      .update({ is_default: true }).eq('id', linkId)
    if (e2) setErr(e2.message)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return personaList.filter((p) => {
      if (filter === 'connected' && !p.isConnected) return false
      if (filter === 'unconnected' && p.isConnected) return false
      if (!q) return true
      return (
        p.name?.toLowerCase().includes(q)
        || p.username?.toLowerCase().includes(q)
        || p.matchedChannel?.name?.toLowerCase().includes(q)
      )
    })
  }, [personaList, filter, search])

  const stats = useMemo(() => {
    const connected = personaList.filter((p) => p.isConnected).length
    return { total: personaList.length, connected, unconnected: personaList.length - connected }
  }, [personaList])

  return (
    <div>
      <h1 className="text-3xl font-bold mb-1">Posting Dashboard</h1>
      <p className="text-sm text-[var(--muted)] mb-6">Monitor status Postiz channels — sinkron data akun yang ter-link ke pipeline posting.</p>

      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 mb-4 flex items-center gap-4">
        <div className="w-10 h-10 rounded-full bg-[var(--surface2)] flex items-center justify-center text-lg">📮</div>
        <div className="flex-1">
          <div className="text-sm">
            <span className="text-[var(--muted)]">Postiz:</span>{' '}
            {channels === null ? (
              <span className="text-[var(--muted)]">Belum sync</span>
            ) : (
              <span className="text-green-400 font-semibold">Terhubung · {channels.length} channel</span>
            )}
            {lastSync && (
              <span className="text-[10px] text-[var(--muted2)] ml-2">
                Terakhir sync {lastSync.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
        <button onClick={syncChannels} disabled={syncing}
          className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
          {syncing ? '⏳ Sync...' : '🔄 Sync Channels'}
        </button>
      </div>

      {err && <div className="mb-4 text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard icon="👥" label="Total Persona" count={stats.total} sub="di workspace" color="orange" />
        <StatCard icon="🔗" label="Terhubung" count={stats.connected} sub="persona → integration mapped" color="green" />
        <StatCard icon="⊘" label="Belum Terhubung" count={stats.unconnected} sub="butuh link Postiz Integration ID" color="red" />
      </div>

      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg">
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-bold">Status Integrasi Akun</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari persona / username / channel..."
            className="w-72 text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
        </div>

        <div className="px-5 py-3 border-b border-[var(--border)] flex gap-2">
          <FilterPill on={filter === 'all'} onClick={() => setFilter('all')} label={`Semua ${stats.total}`} />
          <FilterPill on={filter === 'connected'} onClick={() => setFilter('connected')} label={`Terhubung ${stats.connected}`} />
          <FilterPill on={filter === 'unconnected'} onClick={() => setFilter('unconnected')} label={`Belum Terhubung ${stats.unconnected}`} />
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-[var(--muted)]">
            {personas.length === 0 ? 'Belum ada persona. Bikin di tab Personas dulu.' : 'Gak ada yang match filter.'}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            <div className="grid grid-cols-[2fr_1fr_1fr_2fr_auto] gap-3 px-5 py-2 text-[10px] uppercase text-[var(--muted)] font-semibold tracking-wider">
              <div>Persona</div><div>Username</div><div>Status</div><div>Postiz Channel</div><div>Edit</div>
            </div>
            {filtered.map((p) => (
              <PersonaRow key={p.id} persona={p}
                channels={channels} takenChannelIds={takenChannelIds}
                onAddChannel={(ch) => addChannelLink(p, ch)}
                onRemoveChannel={(linkId) => removeChannelLink(linkId)}
                onSetDefault={(linkId) => setDefaultChannel(p, linkId)} />
            ))}
          </div>
        )}
      </div>

      {channels && channels.length > 0 && (
        <div className="mt-6 text-xs text-[var(--muted)]">
          <details>
            <summary className="cursor-pointer">Liat semua channel yang ke-sync dari Postiz ({channels.length})</summary>
            <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2">
              {channels.map((c) => (
                <details key={c.id} className="bg-[var(--surface2)] border border-[var(--border)] rounded">
                  <summary className="p-2 cursor-pointer">
                    <span className="font-semibold text-[var(--text)]">{c.name}</span>
                    <div className="text-[10px]">
                      @{c.username || '—'}{c.platform && <> · <span className="uppercase">{c.platform}</span></>}
                      {c.account_label && <> · <span className="text-[var(--accent)]">📮 {c.account_label}</span></>}
                    </div>
                    <code className="text-[9px] text-[var(--muted2)] break-all">{c.id}</code>
                  </summary>
                  <pre className="text-[9px] p-2 border-t border-[var(--border)] bg-black/30 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                    {JSON.stringify(c.raw, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
            <div className="text-[10px] text-[var(--muted2)] mt-2">
              ℹ️ Klik kartu buat liat raw response dari Postiz. Kalau platform/username kosong, Postiz API gak return field itu — gua mungkin perlu adjust mapping. Kirim raw JSON ke gua kalau perlu.
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon, label, count, sub, color }) {
  const colors = {
    orange: 'border-orange-500/30 bg-orange-500/5 text-orange-400',
    green:  'border-green-500/30 bg-green-500/5 text-green-400',
    red:    'border-red-500/30 bg-red-500/5 text-red-400',
  }
  return (
    <div className={`rounded-lg border p-5 ${colors[color] || ''}`}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-semibold opacity-90">
        <span>{icon}</span><span>{label}</span>
      </div>
      <div className="text-4xl font-bold mt-2 text-[var(--text)]">{count}</div>
      <div className="text-xs text-[var(--muted)] mt-1">{sub}</div>
    </div>
  )
}

function FilterPill({ on, onClick, label }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold ${on
        ? 'bg-[var(--accent)] text-white'
        : 'bg-[var(--surface2)] text-[var(--muted)] hover:text-white'}`}>
      {label}
    </button>
  )
}

function platformEmoji(platform) {
  const p = (platform || '').toLowerCase()
  if (p.includes('tiktok')) return '🎵'
  if (p.includes('instagram')) return '📷'
  if (p.includes('youtube')) return '▶️'
  if (p.includes('facebook') || p === 'fb') return '👤'
  if (p === 'x' || p.includes('twitter')) return '𝕏'
  if (p.includes('linkedin')) return '💼'
  if (p.includes('thread')) return '🧵'
  return '🌐'
}

function PlatformIcon({ platform }) {
  const p = (platform || '').toLowerCase()
  const emoji = platformEmoji(p)
  const colors = {
    tiktok: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
    instagram: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
    youtube: 'bg-red-500/20 text-red-300 border-red-500/40',
    facebook: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  }
  const colorKey = Object.keys(colors).find((k) => p.includes(k)) || ''
  return (
    <div className={`flex flex-col items-center justify-center w-9 h-9 rounded border flex-shrink-0 ${colors[colorKey] || 'bg-[var(--surface2)] border-[var(--border)]'}`}>
      <span className="text-base leading-none">{emoji}</span>
      <span className="text-[7px] uppercase font-bold tracking-tighter mt-0.5">{(p.split('-')[0] || '?').slice(0, 6)}</span>
    </div>
  )
}

function PlatformOverride({ personaId, current, onSet }) {
  return (
    <select
      value={current || ''}
      onChange={(e) => { if (e.target.value) onSet(e.target.value) }}
      onClick={(e) => e.stopPropagation()}
      className="text-[9px] px-1 py-0.5 rounded bg-[var(--surface)] border border-orange-500/40 text-orange-300"
      title="Set manual karena Postiz gak balikin platform">
      <option value="">set platform</option>
      <option value="tiktok">🎵 TikTok</option>
      <option value="instagram">📷 Instagram</option>
      <option value="youtube">▶️ YouTube</option>
      <option value="facebook">👤 Facebook</option>
      <option value="x">𝕏 X/Twitter</option>
      <option value="linkedin">💼 LinkedIn</option>
      <option value="threads">🧵 Threads</option>
    </select>
  )
}

function PersonaRow({ persona: p, channels, takenChannelIds, onAddChannel, onRemoveChannel, onSetDefault }) {
  const links = p.channelLinks || []
  return (
    <div className="grid grid-cols-[2fr_1fr_1fr_3fr] gap-3 px-5 py-3 items-start text-sm border-b border-[var(--border)]">
      <div className="flex items-center gap-3 min-w-0 pt-1">
        {p.avatar_url ? (
          <img src={p.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-9 h-9 rounded-full bg-[var(--surface2)] flex items-center justify-center text-xs font-bold flex-shrink-0">
            {(p.name || '?').slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <div className="font-semibold truncate">{p.name}</div>
          <div className="text-[10px] text-[var(--muted)] truncate">{p.role_label || '—'}</div>
        </div>
      </div>
      <div className="text-xs text-[#93c5fd] truncate pt-2">@{p.username || '—'}</div>
      <div className="pt-1.5">
        {links.length > 0 ? (
          <span className="text-[10px] font-semibold text-green-400 border border-green-500/40 px-2 py-0.5 rounded">
            ✓ {links.length} channel{links.length > 1 ? 's' : ''}
          </span>
        ) : (
          <span className="text-[10px] font-semibold text-red-400 border border-red-500/40 px-2 py-0.5 rounded">⊘ Belum</span>
        )}
      </div>
      <div className="text-xs min-w-0 space-y-1.5">
        {/* List of linked channels */}
        {links.map((link) => {
          const synced = link.synced
          const platform = link.platform || synced?.platform
          const accountLabel = synced?.account_label
          return (
            <div key={link.id} className="flex items-center gap-2 p-1.5 rounded bg-[var(--surface2)]/50 border border-[var(--border)]">
              <PlatformIcon platform={platform} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate text-xs flex items-center gap-1.5">
                  {link.channel_label || synced?.name || '?'}
                  {link.is_default && <span className="text-[8px] uppercase font-bold text-[var(--accent)] bg-[var(--accent)]/15 px-1 py-0.5 rounded">DEFAULT</span>}
                  {!synced && link.channel_id && (
                    <span className="text-[8px] uppercase font-bold text-orange-400 bg-orange-500/15 px-1 py-0.5 rounded" title="Channel ID gak match di Postiz sync (sync ulang?)">⚠ DRIFT</span>
                  )}
                </div>
                <div className="text-[9px] text-[var(--muted)] truncate">
                  @{link.username || synced?.username || '—'}
                  {accountLabel && <span className="text-[var(--accent)]"> · 📮 {accountLabel}</span>}
                </div>
              </div>
              {!link.is_default && links.length > 1 && (
                <button onClick={() => onSetDefault(link.id)} className="text-[10px] text-[var(--muted)] hover:text-[var(--accent)]" title="Set as default">★</button>
              )}
              <button onClick={() => onRemoveChannel(link.id)} className="text-[10px] text-red-400 hover:underline" title="Unlink">✕</button>
            </div>
          )
        })}

        {/* Add channel dropdown */}
        {!channels ? (
          <span className="text-[var(--muted2)] text-[10px]">Klik <strong>🔄 Sync Channels</strong> di atas ☝️</span>
        ) : channels.length === 0 ? (
          <span className="text-[var(--muted2)] text-[10px]">Sync kosong — gak ada channel di Postiz</span>
        ) : (
          <select onChange={(e) => {
              const ch = channels.find((c) => String(c.id) === e.target.value)
              if (!ch) return
              const ok = confirm(`Link "${p.name}" ke channel ini?\n\n${ch.name} (@${ch.username || '—'})\nPlatform: ${(ch.platform || '?').toUpperCase()}${ch.account_label ? `\nPostiz: ${ch.account_label}` : ''}\n\nID: ${ch.id}`)
              if (ok) onAddChannel(ch)
              e.target.value = ''
            }}
            defaultValue=""
            className="text-xs w-full px-2 py-1 rounded bg-[var(--surface2)] border border-dashed border-[var(--border)] focus:outline-none focus:border-[var(--accent)]">
            <option value="">{links.length > 0 ? '+ Link channel lain' : '— pilih channel —'}</option>
            {(() => {
              // Group by platform with optgroup buat kurangin salah pilih.
              const groups = {}
              channels.forEach((c) => {
                const key = (c.platform || 'unknown').toUpperCase()
                if (!groups[key]) groups[key] = []
                groups[key].push(c)
              })
              const platformOrder = ['TIKTOK', 'INSTAGRAM', 'INSTAGRAM-STANDALONE', 'YOUTUBE', 'YOUTUBE-STANDALONE', 'FACEBOOK', 'X', 'LINKEDIN', 'THREADS', 'UNKNOWN']
              const sorted = Object.keys(groups).sort((a, b) => {
                const ai = platformOrder.indexOf(a); const bi = platformOrder.indexOf(b)
                return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
              })
              return sorted.map((plat) => (
                <optgroup key={plat} label={`${platformEmoji(plat)}  ${plat} (${groups[plat].length})`}>
                  {groups[plat].map((c) => {
                    const taken = takenChannelIds.has(String(c.id))
                    return (
                      <option key={c.id} value={String(c.id)} disabled={taken}>
                        {c.name} (@{c.username || '—'}){c.account_label ? ` · ${c.account_label}` : ''}{taken ? ' [taken]' : ''}
                      </option>
                    )
                  })}
                </optgroup>
              ))
            })()}
          </select>
        )}
      </div>
      <a href="/personas" className="text-xs text-[var(--muted)] hover:text-white" title="Edit lengkap di Personas">✎</a>
    </div>
  )
}
