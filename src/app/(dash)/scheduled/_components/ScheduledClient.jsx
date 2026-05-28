'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

function platformIcon(p) {
  const x = (p || '').toLowerCase()
  if (x.includes('tiktok')) return '🎵'
  if (x.includes('instagram')) return '📷'
  if (x.includes('youtube')) return '▶️'
  if (x.includes('facebook') || x === 'fb') return '👤'
  if (x === 'x' || x.includes('twitter')) return '𝕏'
  if (x.includes('linkedin')) return '💼'
  if (x.includes('thread')) return '🧵'
  return '🌐'
}

const STATUS_COLORS = {
  pending:   'text-blue-300 border-blue-500/40 bg-blue-500/10',
  scheduled: 'text-blue-400 border-blue-500/40 bg-blue-500/10',
  posting:   'text-orange-400 border-orange-500/40 bg-orange-500/10',
  posted:    'text-green-400 border-green-500/40 bg-green-500/10',
  failed:    'text-red-400 border-red-500/40 bg-red-500/10',
  cancelled: 'text-[var(--muted)] border-[var(--border)] bg-[var(--surface2)]',
}

export default function ScheduledClient({ workspaceId, userId, initialScheduled, approvedResults }) {
  const supabase = createClient()
  const [scheduled, setScheduled] = useState(initialScheduled)
  const [picking, setPicking] = useState(null) // approved result -> picking schedule time
  const [err, setErr] = useState('')
  const [channels, setChannels] = useState(null)
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [view, setView] = useState('list') // 'list' | 'calendar'

  // Fetch Postiz channels sekali untuk mirror picker. Cached at component level.
  useEffect(() => {
    let alive = true
    setChannelsLoading(true)
    fetch('/api/postiz/channels').then((r) => r.json()).then((d) => {
      if (alive && d.ok) setChannels(d.channels)
      else if (alive) setErr(`Sync channels: ${d.error}`)
    }).catch((e) => { if (alive) setErr(`Sync channels: ${e.message}`) })
      .finally(() => { if (alive) setChannelsLoading(false) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const ch = supabase.channel('sched-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scheduled_posts', filter: `workspace_id=eq.${workspaceId}` }, async (p) => {
        if (p.eventType === 'DELETE') setScheduled((prev) => prev.filter((s) => s.id !== p.old.id))
        else {
          const { data } = await supabase.from('scheduled_posts')
            .select('*, results(id, type, url, label, ar), personas(id, name, username, avatar_url, postiz_channel_id, postiz_platform)')
            .eq('id', p.new.id).single()
          if (data) setScheduled((prev) => {
            const idx = prev.findIndex((s) => s.id === data.id)
            if (idx === -1) return [data, ...prev]
            const next = [...prev]; next[idx] = data; return next
          })
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  // Mirror upload: schedule a result ke N target channels sekaligus.
  // targets = [{ id, platform, name }] -- list of channels to post to.
  async function schedule(result, scheduledFor, caption, targets) {
    setErr('')
    if (!targets || targets.length === 0) {
      setErr('Pilih minimal 1 channel buat di-post')
      return
    }
    setPicking(null)

    // Insert N rows + fire N concurrent Postiz pushes
    for (const target of targets) {
      const { data: sp, error } = await supabase.from('scheduled_posts').insert({
        workspace_id: workspaceId,
        result_id: result.id,
        persona_id: result.personas?.id || null,
        scheduled_for: scheduledFor || null,
        status: 'posting',
        caption: caption || null,
        created_by: userId,
        target_channel_id: String(target.id),
        target_platform: target.platform || null,
      }).select('id').single()
      if (error) { setErr(`Insert (${target.name || target.id}): ${error.message}`); continue }

      // Fire-and-forget push; status di-update via realtime sub
      fetch('/api/postiz/post', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_post_id: sp.id }),
      }).then(async (res) => {
        const data = await res.json()
        if (!data.ok) console.error('Postiz push gagal:', data.error)
      }).catch((e) => console.error('Postiz push error:', e))
    }
  }

  async function retryPostiz(scheduledPostId) {
    setErr('')
    try {
      const res = await fetch('/api/postiz/post', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_post_id: scheduledPostId }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
    } catch (e) {
      setErr(`Retry gagal: ${e.message}`)
    }
  }

  async function cancel(id) {
    if (!confirm('Cancel scheduled post?')) return
    const { error } = await supabase.from('scheduled_posts').update({ status: 'cancelled' }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function remove(id) {
    if (!confirm('Hapus dari schedule?')) return
    const { error } = await supabase.from('scheduled_posts').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  const grouped = useMemo(() => {
    const map = { upcoming: [], posted: [], failed: [], cancelled: [] }
    scheduled.forEach((s) => {
      if (s.status === 'failed') map.failed.push(s)
      else if (s.status === 'posted') map.posted.push(s)
      else if (s.status === 'failed') map.failed.push(s)
      else if (s.status === 'cancelled') map.cancelled.push(s)
      else map.upcoming.push(s)
    })
    return map
  }, [scheduled])

  // Approved results that haven't been scheduled yet
  const scheduledResultIds = new Set(scheduled.map((s) => s.result_id))
  const readyToSchedule = approvedResults.filter((r) => !scheduledResultIds.has(r.id))

  return (
    <div>
      <h1 className="text-3xl font-bold mb-1">📅 Scheduled</h1>
      <p className="text-sm text-[var(--muted)] mb-6">Approved → Post Now atau jadwalin. Status sync realtime dari Postiz.</p>

      {err && <div className="mb-3 text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      {readyToSchedule.length > 0 && (
        <section className="mb-7">
          <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-3">
            ✓ Siap di-jadwalin ({readyToSchedule.length} approved, belum ke-schedule)
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {readyToSchedule.map((r) => (
              <button key={r.id} onClick={() => setPicking(r)}
                className="text-left bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)] rounded overflow-hidden">
                <div className="aspect-[9/16] bg-black">
                  {r.type === 'video'
                    ? <video src={r.url} muted loop className="w-full h-full object-cover" />
                    : <img src={r.url} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="p-1.5">
                  <div className="text-[10px] font-semibold truncate">{r.label}</div>
                  <div className="text-[9px] text-[var(--muted)] truncate">@{r.personas?.username || '—'}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)]">Upcoming & Recent ({scheduled.length})</h2>
          <div className="flex gap-1">
            <button onClick={() => setView('list')}
              className={`text-xs px-3 py-1 rounded ${view === 'list' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>
              📋 List
            </button>
            <button onClick={() => setView('calendar')}
              className={`text-xs px-3 py-1 rounded ${view === 'calendar' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>
              📅 Calendar
            </button>
          </div>
        </div>
        {scheduled.length === 0 ? (
          <div className="text-sm text-[var(--muted)] p-10 border border-dashed border-[var(--border)] rounded-lg text-center">
            Belum ada scheduled post. Approved di QC, terus jadwalin di sini.
          </div>
        ) : view === 'calendar' ? (
          <CalendarView scheduled={scheduled} onClickItem={(sp) => setPicking(null)} />
        ) : (
          <div className="space-y-2">
            {[...grouped.upcoming, ...grouped.posted, ...grouped.failed, ...grouped.cancelled].map((s) => (
              <ScheduleRow key={s.id} sp={s}
                onCancel={() => cancel(s.id)} onDelete={() => remove(s.id)}
                onRetry={() => retryPostiz(s.id)} />
            ))}
          </div>
        )}
      </section>

      {picking && (
        <ScheduleModal result={picking} onClose={() => setPicking(null)}
          channels={channels} channelsLoading={channelsLoading}
          onSubmit={(t, c, targets) => schedule(picking, t, c, targets)} />
      )}
    </div>
  )
}

// Calendar grid view: shows posts grouped by day for the next 14 days + past 7
function CalendarView({ scheduled, onClickItem }) {
  // Build 21-day window: 7 past, today, 13 future
  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d }, [])
  const days = useMemo(() => {
    const arr = []
    for (let i = -7; i < 14; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i)
      arr.push(d)
    }
    return arr
  }, [today])

  const byDay = useMemo(() => {
    const m = new Map()
    days.forEach((d) => m.set(d.toDateString(), []))
    scheduled.forEach((sp) => {
      const dt = sp.scheduled_for ? new Date(sp.scheduled_for) : new Date(sp.created_at)
      const key = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).toDateString()
      if (m.has(key)) m.get(key).push(sp)
    })
    return m
  }, [days, scheduled])

  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className="border border-[var(--border)] rounded overflow-hidden bg-[var(--surface)]">
      <div className="grid grid-cols-7 border-b border-[var(--border)]">
        {labels.map((l) => (
          <div key={l} className="text-[10px] uppercase font-bold text-center py-2 text-[var(--muted)]">{l}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const items = byDay.get(d.toDateString()) || []
          const isToday = d.toDateString() === today.toDateString()
          const isPast = d < today
          return (
            <div key={i} className={`min-h-24 border-r border-b border-[var(--border)] p-1.5 ${isToday ? 'bg-[var(--accent)]/10' : ''} ${isPast ? 'opacity-60' : ''}`}>
              <div className={`text-[10px] font-bold mb-1 ${isToday ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}>
                {d.getDate()}{isToday && ' · today'}
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 4).map((sp) => {
                  const plat = (sp.target_platform || '').toLowerCase()
                  const emoji = plat.includes('tiktok') ? '🎵' : plat.includes('instagram') ? '📷' : plat.includes('youtube') ? '▶️' : plat.includes('facebook') ? '👤' : '🌐'
                  const color = sp.status === 'posted' ? 'bg-green-500/40 text-green-200'
                    : sp.status === 'failed' ? 'bg-red-500/40 text-red-200'
                    : sp.status === 'scheduled' ? 'bg-blue-500/40 text-blue-200'
                    : sp.status === 'posting' ? 'bg-orange-500/40 text-orange-200'
                    : 'bg-[var(--surface2)] text-[var(--muted)]'
                  const time = sp.scheduled_for ? new Date(sp.scheduled_for).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'
                  return (
                    <div key={sp.id} className={`px-1 py-0.5 rounded text-[9px] truncate ${color}`} title={`${sp.results?.label || ''} → ${sp.personas?.name || ''}`}>
                      {emoji} {time} · {(sp.results?.label || '').slice(0, 12)}
                    </div>
                  )
                })}
                {items.length > 4 && (
                  <div className="text-[9px] text-[var(--muted2)]">+{items.length - 4} more</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ScheduleRow({ sp, onCancel, onDelete, onRetry }) {
  const r = sp.results
  const p = sp.personas
  const [showRaw, setShowRaw] = useState(false)

  // For mirror posts, target_platform di-set per-row. Fallback ke persona default.
  const platformLower = (sp.target_platform || p?.postiz_platform || '').toLowerCase()
  const mismatch =
    (platformLower.includes('tiktok') && r?.type === 'image') ||
    (platformLower.includes('youtube') && r?.type === 'image')

  // Try to extract post URL from Postiz response so user can verify langsung
  const responseUrl =
    sp.external_response?.url
    || sp.external_response?.posts?.[0]?.releaseURL
    || sp.external_response?.[0]?.releaseURL
    || sp.external_response?.releaseURL
    || null

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 flex items-start gap-3">
      <div className="w-14 aspect-[9/16] rounded overflow-hidden bg-black flex-shrink-0">
        {r?.type === 'video'
          ? <video src={r.url} muted className="w-full h-full object-cover" />
          : r?.url && <img src={r.url} alt="" className="w-full h-full object-cover" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate flex items-center gap-2">
          {r?.label || 'result'}
          {platformLower && (
            <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
              {platformIcon(platformLower)} {platformLower.split('-')[0]}
            </span>
          )}
        </div>
        <div className="text-xs text-[var(--muted)] flex items-center gap-2">
          {p?.name && <>→ <strong>{p.name}</strong> {p.username && <>@{p.username}</>}</>}
          {sp.target_channel_id && <span className="text-[9px] text-[var(--muted2)]">· ch {sp.target_channel_id.slice(0, 8)}…</span>}
        </div>
        {sp.caption && <div className="text-[10px] text-[var(--muted)] mt-1 line-clamp-1">📝 {sp.caption}</div>}

        {mismatch && (
          <div className="text-[10px] text-yellow-400 mt-1 bg-yellow-900/20 border border-yellow-700/40 px-2 py-1 rounded">
            ⚠ Mismatch: lu kirim <strong>{r.type}</strong> ke <strong>{p.postiz_platform}</strong> yang cuma terima video. Postiz queue diterima tapi platform bakal reject silent. Generate VIDEO dari grid dulu di /generate.
          </div>
        )}

        {sp.status === 'failed' && sp.error && (
          <div className="text-[10px] text-red-400 mt-1 bg-red-900/20 border border-red-900/40 px-2 py-1 rounded whitespace-pre-wrap">
            ⚠ {sp.error}
          </div>
        )}
        {sp.status === 'posted' && sp.posted_at && (
          <div className="text-[10px] text-green-400 mt-1">
            ✓ Submitted ke Postiz {new Date(sp.posted_at).toLocaleString()}
            {responseUrl && <> · <a href={responseUrl} target="_blank" rel="noreferrer" className="underline">Liat post →</a></>}
          </div>
        )}

        {/* Raw Postiz response — buat debug kalau status posted tapi platform gak nongol */}
        {sp.external_response && (
          <div className="mt-1">
            <button onClick={() => setShowRaw((s) => !s)} className="text-[9px] text-[var(--muted)] underline hover:text-white">
              {showRaw ? '▼ Hide' : '▶ Postiz response (debug)'}
            </button>
            {showRaw && (
              <pre className="text-[9px] text-[var(--muted)] mt-1 bg-[var(--surface2)] border border-[var(--border)] p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(sp.external_response, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
      <div className="text-xs text-right flex-shrink-0">
        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${STATUS_COLORS[sp.status] || ''}`}>
          {sp.status}
        </span>
        <div className="text-[10px] text-[var(--muted)] mt-1">
          {sp.scheduled_for ? new Date(sp.scheduled_for).toLocaleString() : 'now'}
        </div>
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0">
        {sp.status === 'failed' && <button onClick={onRetry} className="text-[10px] text-orange-400 hover:underline font-semibold">↻ Retry</button>}
        {sp.status === 'scheduled' && <button onClick={onCancel} className="text-[10px] text-orange-400 hover:underline">Cancel</button>}
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
    </div>
  )
}

function ScheduleModal({ result, onClose, onSubmit, channels, channelsLoading }) {
  const [drafting, setDrafting] = useState(false)
  const [draftErr, setDraftErr] = useState('')

  // Selected target channels (default = persona's primary channel kalau ada)
  const [selectedIds, setSelectedIds] = useState(() => {
    const init = new Set()
    if (result.personas?.postiz_channel_id) init.add(String(result.personas.postiz_channel_id))
    return init
  })
  function toggleChannel(id) {
    setSelectedIds((s) => {
      const n = new Set(s)
      n.has(String(id)) ? n.delete(String(id)) : n.add(String(id))
      return n
    })
  }
  function toggleGroup(platformChannels) {
    const allSelected = platformChannels.every((c) => selectedIds.has(String(c.id)))
    setSelectedIds((s) => {
      const n = new Set(s)
      platformChannels.forEach((c) => { allSelected ? n.delete(String(c.id)) : n.add(String(c.id)) })
      return n
    })
  }

  // Group channels by platform
  const grouped = useMemo(() => {
    if (!channels) return {}
    const m = {}
    channels.forEach((c) => {
      const key = (c.platform || 'unknown').toUpperCase()
      if (!m[key]) m[key] = []
      m[key].push(c)
    })
    return m
  }, [channels])
  const platformOrder = ['TIKTOK', 'INSTAGRAM', 'INSTAGRAM-STANDALONE', 'YOUTUBE', 'YOUTUBE-STANDALONE', 'FACEBOOK', 'X', 'LINKEDIN', 'THREADS', 'UNKNOWN']
  const platformKeys = Object.keys(grouped).sort((a, b) => {
    const ai = platformOrder.indexOf(a); const bi = platformOrder.indexOf(b)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })

  // Mismatch warning per selected channel (image -> video-only platform)
  const mismatchedSelections = useMemo(() => {
    if (!channels) return []
    return channels.filter((c) => {
      if (!selectedIds.has(String(c.id))) return false
      const p = (c.platform || '').toLowerCase()
      return result.type === 'image' && (p.includes('tiktok') || p.includes('youtube'))
    })
  }, [channels, selectedIds, result.type])

  async function aiDraftCaption() {
    setDrafting(true); setDraftErr('')
    try {
      const res = await fetch('/api/draft/caption', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: result.id }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      setCaption(data.caption)
    } catch (e) { setDraftErr(e.message) }
    setDrafting(false)
  }

  const [when, setWhen] = useState('now') // 'now' | 'later'
  const [datetime, setDatetime] = useState(() => {
    const d = new Date(Date.now() + 3600000) // +1 hour default
    d.setSeconds(0, 0)
    return d.toISOString().slice(0, 16)
  })
  const [caption, setCaption] = useState(result.label || '')
  const [busy, setBusy] = useState(false)
  const canSubmit = selectedIds.size > 0

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-2xl bg-[var(--surface)] rounded-xl border border-[var(--border)] max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-bold">🪞 Mirror Post — sekali upload, banyak channel</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          <div className="flex gap-3">
            <div className="w-24 aspect-[9/16] rounded overflow-hidden bg-black">
              {result.type === 'video'
                ? <video src={result.url} muted controls className="w-full h-full object-cover" />
                : <img src={result.url} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold">{result.label}</div>
              <div className="text-xs text-[var(--muted)]">Source persona: <strong>{result.personas?.name || '—'}</strong> {result.personas?.username && <>@{result.personas.username}</>}</div>
              <div className="text-[10px] text-[var(--muted2)] mt-1">Tipe media: {result.type === 'video' ? '🎬 video' : '🖼 image'}</div>
            </div>
          </div>

          {/* MIRROR CHANNELS */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] uppercase text-[var(--muted)] font-semibold">
                🪞 Mirror to channels ({selectedIds.size} selected)
              </label>
              {channels && channels.length > 0 && (
                <button onClick={() => setSelectedIds(new Set(channels.map((c) => String(c.id))))} type="button"
                  className="text-[10px] text-[var(--muted)] underline hover:text-white">
                  Select all
                </button>
              )}
            </div>
            {channelsLoading ? (
              <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">⏳ Loading Postiz channels...</div>
            ) : !channels || channels.length === 0 ? (
              <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">
                Belum ada channel. Buka <a href="/posting" className="underline text-[var(--accent)]">/posting</a> → 🔄 Sync Channels dulu.
              </div>
            ) : (
              <div className="border border-[var(--border)] rounded bg-[var(--surface2)]/30 p-2 space-y-3 max-h-72 overflow-auto">
                {platformKeys.map((plat) => {
                  const chs = grouped[plat]
                  const allSelected = chs.every((c) => selectedIds.has(String(c.id)))
                  return (
                    <div key={plat}>
                      <div className="flex items-center justify-between text-[10px] uppercase font-bold tracking-wider text-[var(--muted)] mb-1.5">
                        <span>{plat} ({chs.length})</span>
                        <button onClick={() => toggleGroup(chs)} type="button"
                          className="text-[9px] underline hover:text-white">
                          {allSelected ? 'Unselect all' : `Select all ${plat.toLowerCase()}`}
                        </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                        {chs.map((c) => {
                          const on = selectedIds.has(String(c.id))
                          return (
                            <label key={c.id} className={`flex items-center gap-2 p-1.5 rounded cursor-pointer text-xs ${on ? 'bg-[var(--accent)]/20 border border-[var(--accent)]/50' : 'bg-[var(--surface)] border border-transparent hover:border-[var(--border)]'}`}>
                              <input type="checkbox" checked={on} onChange={() => toggleChannel(c.id)} className="flex-shrink-0" />
                              {c.avatar
                                ? <img src={c.avatar} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                                : <div className="w-6 h-6 rounded-full bg-[var(--surface2)] flex-shrink-0" />}
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold truncate">{c.name}</div>
                                {c.username && <div className="text-[9px] text-[var(--muted)] truncate">@{c.username}</div>}
                              </div>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {mismatchedSelections.length > 0 && (
              <div className="text-[10px] text-yellow-400 mt-2 bg-yellow-900/20 border border-yellow-700/40 px-2 py-1.5 rounded">
                ⚠ <strong>{mismatchedSelections.length} channel mismatch:</strong> lu kirim <code>image</code> ke platform yang cuma terima video ({mismatchedSelections.map((c) => c.platform).filter((v, i, a) => a.indexOf(v) === i).join(', ')}). Postiz queue tapi platform bakal reject silent. Generate VIDEO dulu di /generate.
              </div>
            )}
          </div>

          <div>
            <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-2">Waktu publish</label>
            <div className="flex gap-2 mb-3">
              {[['now', '🚀 Post Now'], ['later', '📅 Schedule']].map(([v, l]) => (
                <button key={v} onClick={() => setWhen(v)}
                  className={`flex-1 px-3 py-2 rounded text-sm font-semibold ${when === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>{l}</button>
              ))}
            </div>
            {when === 'later' && (
              <input type="datetime-local" value={datetime} onChange={(e) => setDatetime(e.target.value)}
                className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold">Caption (optional)</label>
              <button onClick={aiDraftCaption} disabled={drafting} type="button"
                className="px-2.5 py-1 rounded text-[10px] font-bold bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:opacity-90 disabled:opacity-50">
                {drafting ? '⏳ Drafting...' : '✨ AI Caption'}
              </button>
            </div>
            <textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)}
              placeholder="Caption + hashtag... atau klik ✨ AI Caption biar Gemini draft otomatis pakai context brand + persona + video."
              className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
            {draftErr && <div className="text-[10px] text-red-400 mt-1">⚠ {draftErr}</div>}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-3 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm">Batal</button>
          <button disabled={busy || !canSubmit} onClick={async () => {
            setBusy(true)
            const targets = channels?.filter((c) => selectedIds.has(String(c.id))).map((c) => ({
              id: c.id, platform: c.platform, name: c.name,
            })) || []
            await onSubmit(when === 'later' ? new Date(datetime).toISOString() : null, caption.trim() || null, targets)
            setBusy(false)
          }} className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '...' : (when === 'now' ? `🚀 Post Now ke ${selectedIds.size} channel` : `📅 Schedule ke ${selectedIds.size} channel`)}
          </button>
        </div>
      </div>
    </div>
  )
}
