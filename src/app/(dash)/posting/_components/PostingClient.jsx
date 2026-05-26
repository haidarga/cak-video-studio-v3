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

  useEffect(() => {
    const ch = supabase.channel('posting-personas-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'personas', filter: `workspace_id=eq.${workspaceId}` }, async () => {
        const { data } = await supabase
          .from('personas')
          .select('id, name, username, role_label, avatar_url, postiz_channel_id, postiz_channel_label, postiz_platform')
          .eq('workspace_id', workspaceId).order('created_at', { ascending: false })
        if (data) setPersonas(data)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
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

  // Match each persona's postiz_channel_id to a synced channel
  const personaList = useMemo(() => {
    return personas.map((p) => {
      const matched = channels?.find((c) => String(c.id) === String(p.postiz_channel_id))
      return { ...p, matchedChannel: matched, isConnected: !!matched || !!p.postiz_channel_id }
    })
  }, [personas, channels])

  // Channel IDs already taken by other personas (so we don't double-assign)
  const takenChannelIds = useMemo(() => {
    return new Set(personas.map((p) => p.postiz_channel_id).filter(Boolean).map(String))
  }, [personas])

  // Link / unlink a Postiz channel to a persona inline (no need to open /personas)
  async function assignChannel(persona, channel) {
    setErr('')
    const patch = channel ? {
      postiz_channel_id: String(channel.id),
      postiz_channel_label: channel.name,
      postiz_platform: channel.platform,
    } : {
      postiz_channel_id: null,
      postiz_channel_label: null,
      postiz_platform: null,
    }
    const { error } = await supabase.from('personas').update(patch).eq('id', persona.id)
    if (error) setErr(error.message)
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
                onAssign={(ch) => assignChannel(p, ch)} />
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

function PersonaRow({ persona: p, channels, takenChannelIds, onAssign }) {
  return (
    <div className="grid grid-cols-[2fr_1fr_1fr_2fr_auto] gap-3 px-5 py-3 items-center text-sm">
      <div className="flex items-center gap-3 min-w-0">
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
      <div className="text-xs text-[#93c5fd] truncate">@{p.username || '—'}</div>
      <div>
        {p.isConnected && p.matchedChannel ? (
          <span className="text-[10px] font-semibold text-green-400 border border-green-500/40 px-2 py-0.5 rounded">✓ Terhubung</span>
        ) : p.postiz_channel_id ? (
          <span className="text-[10px] font-semibold text-orange-400 border border-orange-500/40 px-2 py-0.5 rounded" title="ID tersimpan, channel gak match di Postiz sync">⚠ Drift</span>
        ) : (
          <span className="text-[10px] font-semibold text-red-400 border border-red-500/40 px-2 py-0.5 rounded">⊘ Belum</span>
        )}
      </div>
      <div className="text-xs min-w-0">
        {p.matchedChannel ? (
          <div className="flex items-center gap-2">
            <PlatformIcon platform={p.matchedChannel.platform || p.postiz_platform} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{p.matchedChannel.name}</div>
              <div className="text-[9px] text-[var(--muted)] flex items-center gap-1">
                @{p.matchedChannel.username || '—'}
                {!p.matchedChannel.platform && (
                  <PlatformOverride personaId={p.id} current={p.postiz_platform} onSet={(plat) => onAssign({ ...p.matchedChannel, platform: plat, _platformOverride: true })} />
                )}
              </div>
            </div>
            <button onClick={() => onAssign(null)} className="text-[10px] text-red-400 hover:underline" title="Unlink">unlink</button>
          </div>
        ) : !channels ? (
          <span className="text-[var(--muted2)] text-[10px]">Klik <strong>🔄 Sync Channels</strong> di atas ☝️</span>
        ) : channels.length === 0 ? (
          <span className="text-[var(--muted2)] text-[10px]">Sync kosong — gak ada channel di Postiz</span>
        ) : (
          <select onChange={(e) => {
              const ch = channels.find((c) => String(c.id) === e.target.value)
              if (!ch) return
              // Confirm before saving — bantu user verify platform yg bener
              const ok = confirm(`Link "${p.name}" ke channel ini?\n\n${ch.name} (@${ch.username || '—'})\nPlatform: ${(ch.platform || '?').toUpperCase()}\n\nID: ${ch.id}`)
              if (ok) onAssign(ch)
              e.target.value = ''
            }}
            defaultValue=""
            className="text-xs w-full px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]">
            <option value="">{p.postiz_channel_id ? '⚠ ID lama — pilih ulang' : '— pilih channel —'}</option>
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
                        {c.name} (@{c.username || '—'}){taken ? ' [taken]' : ''}
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
