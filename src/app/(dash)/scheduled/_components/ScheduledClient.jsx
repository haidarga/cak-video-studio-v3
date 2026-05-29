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
  const [picking, setPicking] = useState(null) // approved result -> single-result modal
  const [bulkSelected, setBulkSelected] = useState(new Set()) // result.id -> for bulk mirror
  const [bulkOpen, setBulkOpen] = useState(false) // bulk mirror modal
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
  // targets = [{ id, platform, name, caption? }] -- list of channels to post to.
  async function schedule(result, scheduledFor, caption, targets) {
    setErr('')
    if (!targets || targets.length === 0) {
      setErr('Pilih minimal 1 channel buat di-post')
      return
    }
    setPicking(null)
    await insertAndFire(result, scheduledFor, caption, targets)
  }

  // Bulk variant: M results × N channels with per-result scheduled_for.
  // plan = [{ result, scheduledFor, caption }] -- one entry per selected result.
  // Used to ngakalin rate limit by drip-scheduling across hours.
  async function bulkSchedule(plan, targets, sharedCaption, autoRoute) {
    setErr('')
    if (!plan || plan.length === 0) { setErr('Gak ada result yang dipilih'); return }
    // autoRoute mode: each plan item has its own embedded `target` (persona's
    // linked channel). targets arg is unused / null. 1 plan item → 1 post.
    if (autoRoute) {
      const valid = plan.filter((p) => p.target)
      if (valid.length === 0) { setErr('Gak ada result yang punya persona-channel terlink'); return }
      setBulkOpen(false)
      setBulkSelected(new Set())
      for (const item of valid) {
        const caption = item.caption || sharedCaption || null
        await insertAndFire(item.result, item.scheduledFor, caption, [item.target])
      }
      return
    }
    // Manual mirror mode: cross-product results × targets.
    if (!targets || targets.length === 0) { setErr('Pilih minimal 1 channel'); return }
    setBulkOpen(false)
    setBulkSelected(new Set())
    for (const item of plan) {
      const caption = item.caption || sharedCaption || null
      await insertAndFire(item.result, item.scheduledFor, caption, targets)
    }
  }

  // Shared between single + bulk: insert N scheduled_posts rows + fire pushes.
  async function insertAndFire(result, scheduledFor, caption, targets) {
    for (const target of targets) {
      // status: 'posting' if now, 'scheduled' if future. The /api/postiz/post
      // call still happens immediately, but Postiz itself honors scheduled_for.
      const isFuture = scheduledFor && new Date(scheduledFor) > new Date(Date.now() + 30_000)
      const { data: sp, error } = await supabase.from('scheduled_posts').insert({
        workspace_id: workspaceId,
        result_id: result.id,
        persona_id: result.personas?.id || null,
        scheduled_for: scheduledFor || null,
        status: isFuture ? 'scheduled' : 'posting',
        caption: target.caption || caption || null,
        created_by: userId,
        target_channel_id: String(target.id),
        target_platform: target.platform || null,
        target_postiz_account_id: target.account_id || null,
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

  function toggleBulkSelect(id) {
    setBulkSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function clearBulkSelect() { setBulkSelected(new Set()) }
  function selectAllReady() { setBulkSelected(new Set(readyToSchedule.map((r) => r.id))) }

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
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)]">
              ✓ Siap di-jadwalin ({readyToSchedule.length} approved, belum ke-schedule)
            </h2>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[var(--muted)]">{bulkSelected.size}/{readyToSchedule.length} dipilih</span>
              <button onClick={selectAllReady} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--surface3)]">Pilih semua</button>
              {bulkSelected.size > 0 && (
                <button onClick={clearBulkSelect} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--surface3)]">Clear</button>
              )}
              <button onClick={() => setBulkOpen(true)} disabled={bulkSelected.size === 0}
                className="text-xs px-3 py-1.5 rounded font-semibold bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed">
                🚀 Bulk Schedule ({bulkSelected.size})
              </button>
            </div>
          </div>
          <div className="text-[10px] text-[var(--muted2)] mb-2">
            💡 Pilih beberapa result terus klik <b>Bulk Schedule</b> buat drip-post antar waktu (ngakalin rate limit per channel).
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {readyToSchedule.map((r) => {
              const on = bulkSelected.has(r.id)
              return (
                <div key={r.id}
                  className={`relative text-left bg-[var(--surface)] border rounded overflow-hidden ${on ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/50' : 'border-[var(--border)] hover:border-[var(--accent)]'}`}>
                  {/* Bulk-select checkbox — stops propagation so clicking it doesn't open single-mirror modal */}
                  <label onClick={(e) => e.stopPropagation()} className="absolute top-1.5 left-1.5 z-10 cursor-pointer bg-black/60 rounded p-1">
                    <input type="checkbox" checked={on} onChange={() => toggleBulkSelect(r.id)}
                      className="w-4 h-4 accent-[var(--accent)] cursor-pointer block" />
                  </label>
                  <button onClick={() => setPicking(r)} className="w-full text-left">
                    <div className="aspect-[9/16] bg-black">
                      {r.type === 'video'
                        ? <video src={r.url} muted loop preload="none" className="w-full h-full object-cover" />
                        : <img src={r.url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                    </div>
                    <div className="p-1.5">
                      <div className="text-[10px] font-semibold truncate">{r.label}</div>
                      <div className="text-[9px] text-[var(--muted)] truncate">@{r.personas?.username || '—'}</div>
                    </div>
                  </button>
                </div>
              )
            })}
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

      {bulkOpen && (
        <BulkScheduleModal
          results={readyToSchedule.filter((r) => bulkSelected.has(r.id))}
          channels={channels} channelsLoading={channelsLoading}
          onClose={() => setBulkOpen(false)}
          onSubmit={(plan, targets, sharedCaption, autoRoute) => bulkSchedule(plan, targets, sharedCaption, autoRoute)} />
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
  // Per-channel caption override map: { channelId: customCaption }
  const [captionOverrides, setCaptionOverrides] = useState({})
  const [overrideOpenFor, setOverrideOpenFor] = useState(null)
  function setOverride(chId, text) {
    setCaptionOverrides((s) => {
      const n = { ...s }
      if (text) n[String(chId)] = text
      else delete n[String(chId)]
      return n
    })
  }
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
                          const hasOverride = !!captionOverrides[String(c.id)]
                          return (
                            <div key={c.id} className={`p-1.5 rounded text-xs ${on ? 'bg-[var(--accent)]/20 border border-[var(--accent)]/50' : 'bg-[var(--surface)] border border-transparent hover:border-[var(--border)]'}`}>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={on} onChange={() => toggleChannel(c.id)} className="flex-shrink-0" />
                                {c.avatar
                                  ? <img src={c.avatar} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                                  : <div className="w-6 h-6 rounded-full bg-[var(--surface2)] flex-shrink-0" />}
                                <div className="min-w-0 flex-1">
                                  <div className="font-semibold truncate">{c.name}</div>
                                  {c.username && <div className="text-[9px] text-[var(--muted)] truncate">@{c.username}</div>}
                                </div>
                                {on && (
                                  <button onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOverrideOpenFor(overrideOpenFor === c.id ? null : c.id) }} type="button"
                                    title={hasOverride ? 'Custom caption set' : 'Set custom caption for this channel'}
                                    className={`text-[10px] px-1.5 py-0.5 rounded ${hasOverride ? 'bg-yellow-500/40 text-yellow-200' : 'bg-[var(--surface2)] text-[var(--muted)] hover:text-white'}`}>
                                    {hasOverride ? '✓ caption' : '✎ caption'}
                                  </button>
                                )}
                              </label>
                              {overrideOpenFor === c.id && (
                                <div className="mt-1.5 pl-7">
                                  <textarea value={captionOverrides[String(c.id)] || ''} onChange={(e) => setOverride(c.id, e.target.value)} rows={2}
                                    placeholder={`Override caption khusus ${c.platform || 'channel'} ini (kosongin buat pakai caption umum)`}
                                    className="w-full text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
                                  <div className="text-[9px] text-[var(--muted2)] mt-0.5">Hashtag TikTok vs IG vs LinkedIn beda — pakai ini buat tweak.</div>
                                </div>
                              )}
                            </div>
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
              account_id: c.account_id || null,
              // Per-channel caption override if user customized via captionOverrides state
              caption: captionOverrides[String(c.id)] || null,
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

// Bulk mirror modal — M results × N channels with per-result scheduled_for.
// Timing modes (the whole point — buat ngakalin rate limit per channel):
//   - all_now      : semua post sekarang. Risk: kena daily limit kalau >5
//   - all_at       : semua di jam tertentu (jarang berguna, sama aja nabrak limit)
//   - drip         : first at <startAt> (default now), each next +<gap> minutes
//   - custom       : manual edit per result
function BulkScheduleModal({ results, channels, channelsLoading, onClose, onSubmit }) {
  // Auto-route: 1 result → 1 channel based on the result's persona linkage.
  // Default ON because that's what users almost always want when bulk-
  // scheduling 5 results from 5 different personas. Was previously doing
  // results × selectedChannels cross-product, which forced the user to pick
  // every channel manually and produced N×M posts.
  const [autoRoute, setAutoRoute] = useState(true)
  const [selectedChannelIds, setSelectedChannelIds] = useState(new Set())
  const [sharedCaption, setSharedCaption] = useState('')
  const [mode, setMode] = useState('drip') // 'all_now' | 'drip' | 'custom'
  const [dripStartNow, setDripStartNow] = useState(true)
  const [dripStartAt, setDripStartAt] = useState(() => {
    const d = new Date(Date.now() + 600_000); d.setSeconds(0, 0)
    return d.toISOString().slice(0, 16)
  })
  const [dripGapMin, setDripGapMin] = useState(90)
  const [customTimes, setCustomTimes] = useState({}) // result.id -> ISO datetime-local
  const [busy, setBusy] = useState(false)

  // Group channels by platform — same UI as single ScheduleModal.
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

  function toggleChannel(id) {
    setSelectedChannelIds((s) => { const n = new Set(s); n.has(String(id)) ? n.delete(String(id)) : n.add(String(id)); return n })
  }
  function toggleGroup(platformChannels) {
    const allOn = platformChannels.every((c) => selectedChannelIds.has(String(c.id)))
    setSelectedChannelIds((s) => {
      const n = new Set(s)
      platformChannels.forEach((c) => allOn ? n.delete(String(c.id)) : n.add(String(c.id)))
      return n
    })
  }

  // Compute final plan: each result -> scheduledFor string (ISO).
  // Returns [{ result, scheduledFor }] in result order.
  const plan = useMemo(() => {
    if (mode === 'all_now') {
      return results.map((r) => ({ result: r, scheduledFor: null }))
    }
    if (mode === 'drip') {
      const startMs = dripStartNow ? Date.now() + 5_000 : new Date(dripStartAt).getTime()
      const gapMs = Math.max(0, dripGapMin) * 60_000
      return results.map((r, i) => ({
        result: r,
        scheduledFor: new Date(startMs + i * gapMs).toISOString(),
      }))
    }
    if (mode === 'custom') {
      return results.map((r) => {
        const v = customTimes[r.id]
        return { result: r, scheduledFor: v ? new Date(v).toISOString() : null }
      })
    }
    return []
  }, [mode, results, dripStartNow, dripStartAt, dripGapMin, customTimes])

  const targets = useMemo(() => {
    if (!channels) return []
    return channels.filter((c) => selectedChannelIds.has(String(c.id))).map((c) => ({
      id: c.id, platform: c.platform, name: c.name, account_id: c.account_id || null,
    }))
  }, [channels, selectedChannelIds])

  // Auto-route: per-result target lookup using result.personas.postiz_channel_id.
  // Returns array aligned with `results` — index i = target for results[i], or
  // null if that result's persona has no linked channel (we surface that to the
  // user as a warning so they know which clip to fix).
  const perResultTargets = useMemo(() => {
    if (!autoRoute || !channels) return null
    return results.map((r) => {
      const personaChId = r.personas?.postiz_channel_id
      if (!personaChId) return null
      const ch = channels.find((c) => String(c.id) === String(personaChId))
      if (!ch) return null
      return { id: ch.id, platform: ch.platform, name: ch.name, account_id: ch.account_id || null }
    })
  }, [autoRoute, results, channels])
  const missingRoute = autoRoute ? (perResultTargets || []).map((t, i) => t ? null : results[i]).filter(Boolean) : []
  const autoRouteCount = autoRoute ? (perResultTargets || []).filter(Boolean).length : 0

  const totalPosts = autoRoute ? autoRouteCount : plan.length * targets.length
  const canSubmit = autoRoute
    ? plan.length > 0 && autoRouteCount > 0 && !busy
    : plan.length > 0 && targets.length > 0 && !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    if (autoRoute) {
      // Build a "per-result targets" plan: each item is plan[i] paired with
      // its own single target. Pass through onSubmit as a flat list — parent
      // detects the autoRoute shape via the targets arg being an Array of
      // {result_id → target} entries (we use plan.map with embedded target).
      const routedPlan = plan.map((item, i) => ({ ...item, target: perResultTargets[i] })).filter((p) => p.target)
      await onSubmit(routedPlan, null, sharedCaption || null, true)
    } else {
      await onSubmit(plan, targets, sharedCaption || null, false)
    }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-3xl bg-[var(--surface)] rounded-xl border border-[var(--border)] max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold">
              🚀 Bulk Schedule — {autoRoute ? `${autoRouteCount} post (auto-routed)` : `${results.length} result × ${targets.length || '?'} channel`}
            </h2>
            <p className="text-[10px] text-[var(--muted)]">{autoRoute ? 'Tiap result auto-route ke channel persona-nya' : 'Drip-post antar waktu buat ngakalin rate limit per channel'}</p>
          </div>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* SELECTED RESULTS preview */}
          <div>
            <div className="text-[10px] uppercase text-[var(--muted)] font-semibold mb-2">📦 Selected results ({results.length})</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {results.map((r) => (
                <div key={r.id} className="flex-shrink-0 w-16 aspect-[9/16] rounded overflow-hidden bg-black border border-[var(--border)]">
                  {r.type === 'video'
                    ? <video src={r.url} muted preload="none" className="w-full h-full object-cover" />
                    : <img src={r.url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                </div>
              ))}
            </div>
          </div>

          {/* TIMING MODE */}
          <div>
            <div className="text-[10px] uppercase text-[var(--muted)] font-semibold mb-2">⏰ Timing strategy</div>
            <div className="flex gap-1.5 mb-3 flex-wrap">
              <ModeButton on={mode === 'all_now'} onClick={() => setMode('all_now')}>🚀 All now</ModeButton>
              <ModeButton on={mode === 'drip'} onClick={() => setMode('drip')}>💧 Drip (interval)</ModeButton>
              <ModeButton on={mode === 'custom'} onClick={() => setMode('custom')}>🎯 Custom per result</ModeButton>
            </div>

            {mode === 'all_now' && (
              <div className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 p-2 rounded">
                ⚠ Semua {totalPosts} post bakal fire bareng. Hati-hati kena rate limit (TikTok ~5/hari, IG ~10/hari).
              </div>
            )}

            {mode === 'drip' && (
              <div className="bg-[var(--surface2)]/40 border border-[var(--border)] rounded p-3 space-y-2.5">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="checkbox" checked={dripStartNow} onChange={(e) => setDripStartNow(e.target.checked)} />
                  <span>Mulai sekarang (post #1 langsung fire)</span>
                </label>
                {!dripStartNow && (
                  <div>
                    <div className="text-[10px] text-[var(--muted)] mb-1">Post #1 di:</div>
                    <input type="datetime-local" value={dripStartAt} onChange={(e) => setDripStartAt(e.target.value)}
                      className="text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]" />
                  </div>
                )}
                <div>
                  <div className="text-[10px] text-[var(--muted)] mb-1">Gap antar post (menit):</div>
                  <div className="flex items-center gap-2">
                    <input type="number" min={0} step={5} value={dripGapMin} onChange={(e) => setDripGapMin(Math.max(0, parseInt(e.target.value || '0')))}
                      className="w-24 text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]" />
                    <div className="flex gap-1">
                      {[30, 60, 90, 180, 360].map((g) => (
                        <button key={g} onClick={() => setDripGapMin(g)} type="button"
                          className={`text-[10px] px-1.5 py-1 rounded ${dripGapMin === g ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] hover:bg-[var(--surface3)]'}`}>
                          {g}m
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="text-[10px] text-[var(--muted2)]">
                  Hasil: {plan.length} post tersebar dari {plan[0]?.scheduledFor ? new Date(plan[0].scheduledFor).toLocaleString() : '—'} sampai {plan[plan.length - 1]?.scheduledFor ? new Date(plan[plan.length - 1].scheduledFor).toLocaleString() : '—'} (×{targets.length} channel masing-masing).
                </div>
              </div>
            )}

            {mode === 'custom' && (
              <div className="bg-[var(--surface2)]/40 border border-[var(--border)] rounded p-3 space-y-1.5 max-h-48 overflow-y-auto">
                {results.map((r, i) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs">
                    <div className="w-8 aspect-[9/16] rounded overflow-hidden bg-black flex-shrink-0">
                      {r.type === 'video'
                        ? <video src={r.url} muted preload="none" className="w-full h-full object-cover" />
                        : <img src={r.url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-semibold truncate">#{i + 1} {r.label}</div>
                    </div>
                    <input type="datetime-local" value={customTimes[r.id] || ''}
                      onChange={(e) => setCustomTimes((p) => ({ ...p, [r.id]: e.target.value }))}
                      placeholder="now"
                      className="text-[10px] px-2 py-1 rounded bg-[var(--surface)] border border-[var(--border)]" />
                  </div>
                ))}
                <div className="text-[10px] text-[var(--muted2)] pt-1">Kosongin = post now untuk result tersebut.</div>
              </div>
            )}
          </div>

          {/* CAPTION */}
          <div>
            <div className="text-[10px] uppercase text-[var(--muted)] font-semibold mb-2">📝 Caption (shared)</div>
            <textarea value={sharedCaption} onChange={(e) => setSharedCaption(e.target.value)} rows={2}
              placeholder="Caption yang dipakai semua post (per-channel override gak available di bulk mode)"
              className="w-full text-xs px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </div>

          {/* ROUTING MODE — auto vs manual mirror */}
          <div className="bg-[var(--surface2)]/40 border border-[var(--border)] rounded p-3 space-y-2">
            <div className="text-[10px] uppercase text-[var(--muted)] font-semibold">🧭 Routing</div>
            <label className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-[var(--surface3)]/30">
              <input type="radio" checked={autoRoute} onChange={() => setAutoRoute(true)} className="mt-0.5" />
              <div className="flex-1">
                <div className="text-xs font-semibold">✨ Auto-route per persona (recommended)</div>
                <div className="text-[10px] text-[var(--muted2)]">Tiap result post ke channel persona-nya sendiri. 5 result = 5 post total.</div>
                {autoRoute && (
                  <div className="mt-2 space-y-0.5 max-h-32 overflow-auto bg-[var(--surface)] rounded p-2">
                    {results.map((r, i) => {
                      const t = perResultTargets?.[i]
                      return (
                        <div key={r.id} className="flex items-center justify-between text-[10px]">
                          <span className="truncate flex-1">
                            <span className="text-[var(--muted)]">#{i + 1}</span>{' '}
                            <span className="font-semibold">{r.personas?.name || r.label}</span>
                            {r.personas?.username && <span className="text-[var(--muted2)]"> @{r.personas.username}</span>}
                          </span>
                          {t ? (
                            <span className="text-green-300 font-semibold">→ {t.platform} · {t.name}</span>
                          ) : (
                            <span className="text-red-400">⚠ gak ada channel</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {autoRoute && missingRoute.length > 0 && (
                  <div className="mt-2 text-[10px] text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 p-2 rounded">
                    ⚠ {missingRoute.length} result gak punya channel terlink ke persona-nya. Result itu di-skip. Link persona ke channel di <a href="/posting" className="underline">/posting</a>.
                  </div>
                )}
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-[var(--surface3)]/30">
              <input type="radio" checked={!autoRoute} onChange={() => setAutoRoute(false)} className="mt-0.5" />
              <div className="flex-1">
                <div className="text-xs font-semibold">🪞 Mirror to specific channels (manual)</div>
                <div className="text-[10px] text-[var(--muted2)]">Pilih channel sendiri. Semua result post ke SEMUA channel terpilih (cross-product).</div>
              </div>
            </label>
          </div>

          {/* CHANNELS — only visible in manual mirror mode */}
          {!autoRoute && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase text-[var(--muted)] font-semibold">🪞 Mirror to channels ({targets.length} selected)</div>
              {channels && channels.length > 0 && (
                <button onClick={() => setSelectedChannelIds(new Set(channels.map((c) => String(c.id))))} type="button"
                  className="text-[10px] text-[var(--muted)] underline hover:text-white">
                  Select all channels
                </button>
              )}
            </div>
            {channelsLoading ? (
              <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">⏳ Loading channels...</div>
            ) : !channels || channels.length === 0 ? (
              <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">
                Belum ada channel. Buka <a href="/posting" className="underline text-[var(--accent)]">/posting</a> → Sync Channels.
              </div>
            ) : (
              <div className="border border-[var(--border)] rounded bg-[var(--surface2)]/30 p-2 space-y-3 max-h-60 overflow-auto">
                {platformKeys.map((plat) => {
                  const chs = grouped[plat]
                  const allSelected = chs.every((c) => selectedChannelIds.has(String(c.id)))
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
                          const on = selectedChannelIds.has(String(c.id))
                          return (
                            <label key={c.id} className={`p-1.5 rounded text-xs cursor-pointer flex items-center gap-2 ${on ? 'bg-[var(--accent)]/20 border border-[var(--accent)]/50' : 'bg-[var(--surface)] border border-transparent hover:border-[var(--border)]'}`}>
                              <input type="checkbox" checked={on} onChange={() => toggleChannel(c.id)} className="flex-shrink-0" />
                              {c.avatar
                                ? <img src={c.avatar} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                                : <div className="w-6 h-6 rounded-full bg-[var(--surface2)] flex-shrink-0" />}
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold truncate">{c.name}</div>
                                <div className="text-[9px] text-[var(--muted)] truncate flex items-center gap-1">
                                  {c.username && <>@{c.username}</>}
                                  {c.account_label && <span className="text-[var(--accent)]">· 📮 {c.account_label}</span>}
                                </div>
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
          </div>
          )}

          {/* SUMMARY */}
          <div className="bg-[var(--surface2)]/60 border border-[var(--border)] rounded p-3 text-xs">
            <div className="font-bold text-sm mb-1">📊 Summary</div>
            <div className="text-[var(--muted)]">
              {autoRoute
                ? <>{autoRouteCount} post (auto-routed) = <b className="text-[var(--text)]">{totalPosts} total post</b></>
                : <>{results.length} result × {targets.length} channel = <b className="text-[var(--text)]">{totalPosts} total post</b></>}
              {mode === 'drip' && plan.length > 1 && (
                <> · tersebar selama <b className="text-[var(--text)]">{Math.round((plan.length - 1) * dripGapMin / 60 * 10) / 10}h</b></>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} className="text-xs px-4 py-2 rounded text-[var(--muted)] hover:bg-[var(--surface2)]">Cancel</button>
          <button onClick={submit} disabled={!canSubmit}
            className="text-xs px-4 py-2 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? '⏳ Submitting...' : `🚀 Submit ${totalPosts} post`}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModeButton({ on, onClick, children }) {
  return (
    <button onClick={onClick} type="button"
      className={`text-xs px-3 py-1.5 rounded font-semibold ${on ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)] hover:bg-[var(--surface3)]'}`}>
      {children}
    </button>
  )
}
