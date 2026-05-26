'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

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

  async function schedule(result, scheduledFor, caption) {
    if (!result.personas?.postiz_channel_id) {
      setErr(`${result.personas?.name || 'Persona'} belum konek ke Postiz channel — set di /posting`)
      return
    }
    // 1. Insert DB row with pending status.
    const { data: sp, error } = await supabase.from('scheduled_posts').insert({
      workspace_id: workspaceId,
      result_id: result.id,
      persona_id: result.personas.id,
      scheduled_for: scheduledFor || null,
      status: 'pending',
      caption: caption || null,
      created_by: userId,
    }).select('id').single()
    if (error) { setErr(error.message); return }
    setPicking(null)

    // 2. Push to Postiz (now OR scheduled — Postiz handles its own scheduling)
    try {
      const res = await fetch('/api/postiz/post', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_post_id: sp.id }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
    } catch (e) {
      setErr(`Push ke Postiz gagal: ${e.message}. Row tersimpan sbg 'failed' — bisa retry di list.`)
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
        <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-3">Upcoming & Recent</h2>
        {scheduled.length === 0 ? (
          <div className="text-sm text-[var(--muted)] p-10 border border-dashed border-[var(--border)] rounded-lg text-center">
            Belum ada scheduled post. Approved di QC, terus jadwalin di sini.
          </div>
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
          onSubmit={(t, c) => schedule(picking, t, c)} />
      )}
    </div>
  )
}

function ScheduleRow({ sp, onCancel, onDelete, onRetry }) {
  const r = sp.results
  const p = sp.personas
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 flex items-start gap-3">
      <div className="w-14 aspect-[9/16] rounded overflow-hidden bg-black flex-shrink-0">
        {r?.type === 'video'
          ? <video src={r.url} muted className="w-full h-full object-cover" />
          : r?.url && <img src={r.url} alt="" className="w-full h-full object-cover" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">{r?.label || 'result'}</div>
        <div className="text-xs text-[var(--muted)] flex items-center gap-2">
          {p?.name && <>→ <strong>{p.name}</strong> @{p.username} {p.postiz_platform && <span className="uppercase text-[9px]">· {p.postiz_platform}</span>}</>}
        </div>
        {sp.caption && <div className="text-[10px] text-[var(--muted)] mt-1 line-clamp-1">📝 {sp.caption}</div>}
        {sp.status === 'failed' && sp.error && (
          <div className="text-[10px] text-red-400 mt-1 bg-red-900/20 border border-red-900/40 px-2 py-1 rounded">
            ⚠ {sp.error}
          </div>
        )}
        {sp.status === 'posted' && sp.posted_at && (
          <div className="text-[10px] text-green-400 mt-1">✓ Posted {new Date(sp.posted_at).toLocaleString()}</div>
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
        {(sp.status === 'scheduled' || sp.status === 'pending') && <button onClick={onCancel} className="text-[10px] text-orange-400 hover:underline">Cancel</button>}
        <button onClick={onDelete} className="text-[10px] text-red-400 hover:underline">Hapus</button>
      </div>
    </div>
  )
}

function ScheduleModal({ result, onClose, onSubmit }) {
  const [drafting, setDrafting] = useState(false)
  const [draftErr, setDraftErr] = useState('')

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
  const channelOK = !!result.personas?.postiz_channel_id

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-lg bg-[var(--surface)] rounded-xl border border-[var(--border)]">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-lg font-bold">📅 Schedule Post</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex gap-3">
            <div className="w-24 aspect-[9/16] rounded overflow-hidden bg-black">
              {result.type === 'video'
                ? <video src={result.url} muted controls className="w-full h-full object-cover" />
                : <img src={result.url} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold">{result.label}</div>
              <div className="text-xs text-[var(--muted)]">→ <strong>{result.personas?.name}</strong> @{result.personas?.username}</div>
              {!channelOK && (
                <div className="text-xs text-red-400 mt-2">⚠ Persona ini belum konek Postiz channel. Set Postiz Integration ID di /personas dulu.</div>
              )}
            </div>
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
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm">Batal</button>
          <button disabled={busy || !channelOK} onClick={async () => {
            setBusy(true)
            await onSubmit(when === 'later' ? new Date(datetime).toISOString() : null, caption.trim() || null)
            setBusy(false)
          }} className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '...' : (when === 'now' ? '🚀 Post Now' : '📅 Schedule')}
          </button>
        </div>
      </div>
    </div>
  )
}
