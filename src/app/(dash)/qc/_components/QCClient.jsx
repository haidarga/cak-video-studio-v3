'use client'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { convertVideoToMp4 } from '@/lib/video-convert'

const STATUSES = [
  { v: 'pending',  l: '⏳ Review',   color: 'bg-blue-500/20 text-blue-400 border-blue-500/40' },
  { v: 'approved', l: '✅ Approved', color: 'bg-green-500/20 text-green-400 border-green-500/40' },
  { v: 'revise',   l: '🔁 Revise',   color: 'bg-orange-500/20 text-orange-400 border-orange-500/40' },
  { v: 'rejected', l: '❌ Rejected', color: 'bg-red-500/20 text-red-400 border-red-500/40' },
]

export default function QCClient({ workspaceId, userId, initialResults, personas }) {
  const supabase = createClient()
  const [results, setResults] = useState(initialResults)
  const [openNote, setOpenNote] = useState(null)
  const [busyUpload, setBusyUpload] = useState(null) // { id, name, sizeMB, stage } while uploading
  const [filter, setFilter] = useState('all') // status filter
  const [err, setErr] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set()) // multi-select untuk batch ops
  const [batchBusy, setBatchBusy] = useState(false)

  function toggleSelect(id) {
    setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAllVisible(visibleIds) {
    setSelectedIds((s) => {
      const allSel = visibleIds.every((id) => s.has(id))
      const n = new Set(s)
      visibleIds.forEach((id) => allSel ? n.delete(id) : n.add(id))
      return n
    })
  }
  async function batchSetStatus(status) {
    if (selectedIds.size === 0) return
    setBatchBusy(true); setErr('')
    const ids = [...selectedIds]
    const { error } = await supabase.from('results').update({ qc_status: status }).in('id', ids)
    if (error) setErr(`Batch ${status}: ${error.message}`)
    setSelectedIds(new Set())
    setBatchBusy(false)
  }
  async function batchDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`Hapus ${selectedIds.size} result?`)) return
    setBatchBusy(true); setErr('')
    const { error } = await supabase.from('results').delete().in('id', [...selectedIds])
    if (error) setErr(`Batch delete: ${error.message}`)
    setSelectedIds(new Set())
    setBatchBusy(false)
  }
  async function batchRemoveFromQC() {
    if (selectedIds.size === 0) return
    setBatchBusy(true); setErr('')
    const { error } = await supabase.from('results').update({ qc_status: null, qc_notes: null }).in('id', [...selectedIds])
    if (error) setErr(`Batch remove: ${error.message}`)
    setSelectedIds(new Set())
    setBatchBusy(false)
  }

  useEffect(() => {
    const ch = supabase.channel('qc-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results', filter: `workspace_id=eq.${workspaceId}` }, async (p) => {
        if (p.eventType === 'DELETE') { setResults((prev) => prev.filter((r) => r.id !== p.old.id)); return }
        const { data } = await supabase.from('results').select('*, personas(id, name, username, avatar_url, postiz_channel_id)').eq('id', p.new.id).single()
        if (!data) return
        setResults((prev) => {
          if (!data.qc_status) return prev.filter((r) => r.id !== data.id)
          const idx = prev.findIndex((r) => r.id === data.id)
          if (idx === -1) return [data, ...prev]
          const next = [...prev]; next[idx] = data; return next
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  async function setStatus(id, status) {
    const { error } = await supabase.from('results').update({ qc_status: status }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function removeFromQC(id) {
    const { error } = await supabase.from('results').update({ qc_status: null, qc_notes: null }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function saveNote(id, notes) {
    const { error } = await supabase.from('results').update({ qc_notes: notes }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function rename(id, label) {
    const { error } = await supabase.from('results').update({ label }).eq('id', id)
    if (error) setErr(error.message)
  }
  async function deletePerma(id) {
    if (!confirm('Hapus permanen dari workspace?')) return
    const { error } = await supabase.from('results').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  // Convert a result's WebM video to MP4 in-place (so Postiz accepts it).
  // Plays the video through canvas + MediaRecorder client-side — no
  // ffmpeg, no external tools. Real-time speed (5s clip ≈ 5s convert).
  // Updates result.url in DB to the new .mp4 path. Old .webm in storage
  // stays around for safety; user can clean up later if they want.
  const [converting, setConverting] = useState(null) // { id, stage }
  async function convertToMp4(r) {
    if (converting) return
    setConverting({ id: r.id, stage: 'Loading video...' })
    setErr('')
    try {
      const { blob } = await convertVideoToMp4(r.url, (stage) => {
        setConverting({ id: r.id, stage })
      })
      setConverting({ id: r.id, stage: `Uploading ${(blob.size / 1024 / 1024).toFixed(1)}MB...` })
      const path = `${workspaceId}/qc-converted-${Date.now()}.mp4`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, blob, { contentType: 'video/mp4', cacheControl: '3600' })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const { error: updErr } = await supabase.from('results').update({ url: publicUrl }).eq('id', r.id)
      if (updErr) throw updErr
      setResults((prev) => prev.map((x) => (x.id === r.id ? { ...x, url: publicUrl } : x)))
      setConverting(null)
    } catch (e) {
      setErr('Convert gagal: ' + (e?.message || e))
      setConverting(null)
    }
  }
  // Show the re-encode button on EVERY video result — not just WebM.
  // Reason: older MP4 results in QC are still 720p / low-bitrate from
  // the pre-1080p pipeline. One click upscales them to 1080p via the
  // same convert function. WebM gets the BIGGEST quality win (also
  // becomes Postiz-compatible); existing MP4 still benefits from the
  // 1080p upscale + higher bitrate re-encode.
  function isWebm(r) { return r.type === 'video' && !!r.url }

  async function uploadExternal(persona, file) {
    setErr('')

    // Pre-flight checks supaya errornya jelas, bukan silent fail.
    const sizeMB = file.size / 1024 / 1024
    if (sizeMB > 200) {
      setErr(`File "${file.name}" terlalu besar (${sizeMB.toFixed(1)}MB). Max 200MB. Compress dulu pake CapCut/Handbrake atau adjust file_size_limit di Supabase Storage bucket 'refs'.`)
      return
    }
    if (!file.type.startsWith('video/') && !file.type.startsWith('image/')) {
      setErr(`File "${file.name}" type "${file.type}" gak didukung. Hanya video/* atau image/*.`)
      return
    }

    setBusyUpload({ id: persona.id, name: file.name, sizeMB: sizeMB.toFixed(1), stage: 'uploading' })
    try {
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase()
      const path = `${workspaceId}/external-${persona.id}-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, file, {
        upsert: false, contentType: file.type, cacheControl: '3600',
      })
      if (upErr) {
        // Surface meaningful storage errors
        const msg = upErr.message || ''
        if (msg.includes('exceeded') || msg.includes('size')) {
          throw new Error(`File terlalu besar buat bucket. Jalanin migration 0004_raise_upload_limit.sql di Supabase SQL Editor dulu. (${msg})`)
        }
        if (msg.includes('mime') || msg.includes('type')) {
          throw new Error(`MIME type ditolak bucket. Migration 0004 set allowed_mime_types=null biar terima semua. (${msg})`)
        }
        throw new Error(`Storage upload gagal: ${msg}`)
      }
      setBusyUpload((s) => ({ ...s, stage: 'inserting' }))
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
      const isVideo = file.type.startsWith('video/')
      const { error: insErr } = await supabase.from('results').insert({
        workspace_id: workspaceId,
        persona_id: persona.id,
        type: isVideo ? 'video' : 'image',
        url: publicUrl,
        label: file.name.replace(/\.[^.]+$/, ''),
        ar: '9:16',
        group_label: persona.name,
        qc_status: 'pending',
        meta: { source: 'external_upload', original_name: file.name, size_bytes: file.size, mime: file.type },
        created_by: userId,
      })
      if (insErr) throw new Error(`Insert ke results gagal: ${insErr.message}`)
    } catch (e) { setErr(`Upload ${persona.name}: ${e.message}`) }
    setBusyUpload(null)
  }

  // Group results by persona id (or "_unassigned" for null persona)
  const byPersona = useMemo(() => {
    const m = new Map()
    personas.forEach((p) => m.set(p.id, { persona: p, items: [] }))
    m.set('_unassigned', { persona: null, items: [] })
    results.forEach((r) => {
      if (filter !== 'all' && r.qc_status !== filter) return
      const key = r.persona_id || '_unassigned'
      if (!m.has(key)) m.set(key, { persona: null, items: [] })
      m.get(key).items.push(r)
    })
    return [...m.values()].filter((g) => g.persona || g.items.length > 0)
  }, [results, personas, filter])

  const totalCounts = useMemo(() => {
    const c = { all: results.length, pending: 0, approved: 0, revise: 0, rejected: 0 }
    results.forEach((r) => { if (c[r.qc_status] !== undefined) c[r.qc_status]++ })
    return c
  }, [results])

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">🧪 QC</h1>
          <p className="text-sm text-[var(--muted)]">Auto-group per persona. Approve → siap upload (Post Now / Schedule). Bisa upload video eksternal yang udah lu edit di luar platform.</p>
        </div>
        {totalCounts.approved > 0 && (
          <a href="/scheduled" className="text-xs text-green-400 underline">
            ✓ {totalCounts.approved} approved siap upload →
          </a>
        )}
      </div>

      {err && <div className="mb-3 text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      <div className="flex gap-2 mb-5 flex-wrap items-center">
        <FilterPill on={filter === 'all'} onClick={() => setFilter('all')} label={`Semua ${totalCounts.all}`} />
        {STATUSES.map((s) => (
          <FilterPill key={s.v} on={filter === s.v} onClick={() => setFilter(s.v)} label={`${s.l} ${totalCounts[s.v]}`} />
        ))}
        {results.length > 0 && (
          <button onClick={() => selectAllVisible(byPersona.flatMap(({ items }) => items.map((r) => r.id)))}
            className="ml-auto text-xs px-3 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">
            {selectedIds.size > 0 ? `Selected ${selectedIds.size} — Unselect all` : 'Select all visible'}
          </button>
        )}
      </div>

      {/* Batch actions toolbar — sticky on top when selection active */}
      {selectedIds.size > 0 && (
        <div className="sticky top-0 z-30 mb-4 bg-[var(--accent)]/15 border border-[var(--accent)]/50 rounded p-2.5 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-[var(--accent)]">⚡ {selectedIds.size} selected</span>
          <button onClick={() => batchSetStatus('approved')} disabled={batchBusy}
            className="text-xs px-3 py-1 rounded bg-green-500 hover:bg-green-600 text-white font-bold disabled:opacity-50">
            ✅ Approve all
          </button>
          <button onClick={() => batchSetStatus('rejected')} disabled={batchBusy}
            className="text-xs px-3 py-1 rounded bg-red-500 hover:bg-red-600 text-white font-bold disabled:opacity-50">
            ❌ Reject all
          </button>
          <button onClick={() => batchSetStatus('revise')} disabled={batchBusy}
            className="text-xs px-3 py-1 rounded bg-orange-500 hover:bg-orange-600 text-white font-bold disabled:opacity-50">
            🔁 Revise all
          </button>
          <button onClick={() => batchSetStatus('pending')} disabled={batchBusy}
            className="text-xs px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white font-bold disabled:opacity-50">
            ⏳ Re-review
          </button>
          <button onClick={batchRemoveFromQC} disabled={batchBusy}
            className="text-xs px-3 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--border)] disabled:opacity-50">
            Remove from QC
          </button>
          <button onClick={batchDelete} disabled={batchBusy}
            className="text-xs px-3 py-1 rounded bg-red-900/40 border border-red-700/60 text-red-300 hover:bg-red-900/60 disabled:opacity-50">
            🗑 Delete perma
          </button>
          <button onClick={() => setSelectedIds(new Set())} disabled={batchBusy}
            className="text-xs px-2 py-1 ml-auto text-[var(--muted)] hover:text-white">
            Cancel
          </button>
        </div>
      )}

      <div className="space-y-6">
        {byPersona.map(({ persona, items }) => (
          <PersonaGroup key={persona?.id || '_unassigned'} persona={persona} items={items}
            busyUpload={busyUpload?.id === persona?.id ? busyUpload : null}
            onUpload={(file) => persona && uploadExternal(persona, file)}
            onSetStatus={setStatus} onRemove={removeFromQC} onOpenNote={setOpenNote}
            onRename={rename} onDeletePerma={deletePerma}
            selectedIds={selectedIds} onToggleSelect={toggleSelect}
            converting={converting} onConvertToMp4={convertToMp4} isWebm={isWebm} />
        ))}

        {byPersona.length === 0 && (
          <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center">
            QC queue kosong. Generate hasil di tab Generate → klik 🧪 QC.
          </div>
        )}
      </div>

      {openNote && (
        <NoteEditor result={openNote} onClose={() => setOpenNote(null)}
          onSave={async (notes) => { await saveNote(openNote.id, notes); setOpenNote(null) }} />
      )}
    </div>
  )
}

function PersonaGroup({ persona, items, busyUpload, onUpload, onSetStatus, onRemove, onOpenNote, onRename, onDeletePerma, selectedIds, onToggleSelect, converting, onConvertToMp4, isWebm }) {
  const fileRef = useRef(null)
  const counts = items.reduce((c, r) => ({ ...c, [r.qc_status]: (c[r.qc_status] || 0) + 1 }), {})

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg">
      <header className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-3 flex-wrap">
        {persona ? (
          <>
            {persona.avatar_url
              ? <img src={persona.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
              : <div className="w-9 h-9 rounded-full bg-[var(--surface2)] flex items-center justify-center text-sm font-bold">{(persona.name || '?').slice(0, 1).toUpperCase()}</div>}
            <div className="flex-1 min-w-0">
              <div className="font-bold truncate">{persona.name}</div>
              <div className="text-[10px] text-[var(--muted)]">@{persona.username || '—'} · {items.length} item</div>
            </div>
          </>
        ) : (
          <>
            <div className="w-9 h-9 rounded-full bg-[var(--surface2)] flex items-center justify-center">?</div>
            <div className="flex-1">
              <div className="font-bold text-[var(--muted)]">Tanpa persona</div>
              <div className="text-[10px] text-[var(--muted2)]">{items.length} item</div>
            </div>
          </>
        )}

        <div className="flex items-center gap-1.5 text-[10px]">
          {counts.pending && <Pill className="bg-blue-500/20 text-blue-400">{counts.pending} review</Pill>}
          {counts.approved && <Pill className="bg-green-500/20 text-green-400">{counts.approved} approved</Pill>}
          {counts.revise && <Pill className="bg-orange-500/20 text-orange-400">{counts.revise} revise</Pill>}
          {counts.rejected && <Pill className="bg-red-500/20 text-red-400">{counts.rejected} rejected</Pill>}
        </div>

        {persona && (
          <>
            <input ref={fileRef} type="file" accept="video/*,image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }} />
            <button onClick={() => fileRef.current?.click()} disabled={!!busyUpload}
              className="ml-auto px-3 py-1.5 rounded text-xs font-semibold bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
              {busyUpload
                ? `⏳ ${busyUpload.stage === 'inserting' ? 'Saving...' : `Uploading ${busyUpload.name} (${busyUpload.sizeMB}MB)`}`
                : '+ Upload External Video'}
            </button>
          </>
        )}
      </header>

      {items.length === 0 ? (
        <div className="p-6 text-center text-xs text-[var(--muted2)]">
          Persona ini gak ada item di QC{persona && '. Upload video editan lu pake tombol di atas.'}
        </div>
      ) : (
        <div className="p-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {items.map((r) => (
            <QCCard key={r.id} result={r}
              selected={selectedIds?.has(r.id)} onToggleSelect={onToggleSelect}
              onSetStatus={onSetStatus} onRemove={onRemove} onOpenNote={onOpenNote}
              onRename={onRename} onDeletePerma={onDeletePerma}
              isWebm={isWebm?.(r)} converting={converting?.id === r.id ? converting : null}
              onConvertToMp4={() => onConvertToMp4?.(r)} />
          ))}
        </div>
      )}
    </section>
  )
}

// Custom comparator — re-render only when the relevant card-visible state
// changes, not when QCClient re-renders for unrelated reasons (e.g. another
// card's selection toggled). The handler props are intentionally ignored
// in the compare because parent re-creates them per render but their effect
// is identical; the card's behaviour is fully driven by `r` + `selected`.
function qcCardEqual(prev, next) {
  if (prev.selected !== next.selected) return false
  if (prev.isWebm !== next.isWebm) return false
  if (!!prev.converting !== !!next.converting) return false
  if (prev.converting?.stage !== next.converting?.stage) return false
  const a = prev.result, b = next.result
  if (a === b) return true
  return a.id === b.id
    && a.url === b.url
    && a.label === b.label
    && a.qc_status === b.qc_status
    && a.qc_notes === b.qc_notes
    && a.type === b.type
    && a.meta?.source === b.meta?.source
}

// memo'd: with 300 cards on the page, toggling one selected state was
// re-rendering all 299 siblings. Now: only the card whose `r` or `selected`
// actually changed re-renders.
const QCCard = memo(function QCCard({ result: r, onSetStatus, onRemove, onOpenNote, onRename, onDeletePerma, selected, onToggleSelect, isWebm, converting, onConvertToMp4 }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(r.label || '')
  const statusCfg = STATUSES.find((s) => s.v === r.qc_status) || STATUSES[0]
  return (
    <div className={`bg-[var(--surface2)] border rounded overflow-hidden ${selected ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/50' : 'border-[var(--border)]'}`}>
      <div className="relative aspect-[9/16] bg-black">
        {r.type === 'video'
          ? <video src={r.url} muted loop playsInline preload="none" className="w-full h-full object-cover"
              onMouseEnter={(e) => { e.target.preload = 'auto'; e.target.play().catch(()=>{}) }}
              onMouseLeave={(e) => e.target.pause()} />
          : <img src={r.url} alt={r.label} loading="lazy" className="w-full h-full object-cover" />}
        {/* Multi-select checkbox top-left, status badge top-right */}
        {onToggleSelect && (
          <label onClick={(e) => e.stopPropagation()} className="absolute top-1.5 left-1.5 cursor-pointer">
            <input type="checkbox" checked={!!selected} onChange={() => onToggleSelect(r.id)}
              className="w-4 h-4 accent-[var(--accent)] cursor-pointer" />
          </label>
        )}
        <span className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold border ${statusCfg.color}`}>
          {r.qc_status}
        </span>
        {r.meta?.source === 'external_upload' && (
          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-purple-500/30 text-purple-200 border border-purple-500/40">📤 EXT</span>
        )}
        {r.meta?.source === 'editor' && (
          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-cyan-500/30 text-cyan-200 border border-cyan-500/40">✂️ EDIT</span>
        )}
        {isWebm && /\.webm($|\?)/i.test(r.url || '') && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-yellow-500/30 text-yellow-200 border border-yellow-500/40" title="WebM tidak diterima Postiz — klik 🔁 re-encode">
            ⚠ WEBM
          </span>
        )}
        {converting && (
          <div className="absolute inset-x-1 bottom-1 text-[9px] bg-purple-600 text-white px-1.5 py-0.5 rounded truncate">
            🔄 {converting.stage}
          </div>
        )}
      </div>
      <div className="p-2">
        {editing ? (
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { setEditing(false); if (label !== r.label) onRename(r.id, label) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
            autoFocus className="w-full text-xs px-1 py-0.5 rounded bg-[var(--surface)] border border-[var(--accent)]" />
        ) : (
          <div className="flex items-center gap-1 group">
            <div onDoubleClick={() => setEditing(true)} className="text-xs font-semibold truncate cursor-text flex-1" title="double-click buat rename">
              {r.label || 'untitled'}
            </div>
            <button onClick={() => setEditing(true)} title="Rename" className="text-[10px] px-1 py-0.5 rounded text-[var(--muted)] hover:text-white hover:bg-[var(--surface)] opacity-0 group-hover:opacity-100 transition-opacity">
              ✏️
            </button>
          </div>
        )}
        {r.qc_notes && (
          <div className="text-[10px] text-[var(--muted)] mt-1 line-clamp-2 italic">📝 {r.qc_notes}</div>
        )}
        <select value={r.qc_status} onChange={(e) => onSetStatus(r.id, e.target.value)}
          className="mt-2 w-full text-[10px] px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)]">
          {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
        <div className="flex gap-1 mt-1.5">
          <button onClick={() => onOpenNote(r)} className="flex-1 text-[10px] px-1.5 py-1 rounded bg-[var(--surface)] hover:bg-[var(--border)]">
            {r.qc_notes ? '📝' : '+ note'}
          </button>
          {r.qc_status === 'approved' && (
            <a href="/scheduled" className="flex-1 text-[10px] px-1.5 py-1 rounded bg-green-500/20 hover:bg-green-500/30 text-green-300 text-center font-semibold">📅</a>
          )}
          {isWebm && (
            <button onClick={onConvertToMp4} disabled={!!converting}
              title="Re-encode video di 1080p — upscale + Postiz-compatible MP4"
              className="text-[10px] px-1.5 py-1 rounded bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-200 border border-yellow-500/40 font-semibold disabled:opacity-50">
              🔁 1080p
            </button>
          )}
          <button onClick={() => onRemove(r.id)} title="Keluarin dari QC" className="text-[10px] px-1.5 py-1 rounded text-[var(--muted)] hover:bg-[var(--surface)]">✕</button>
          <button onClick={() => onDeletePerma(r.id)} title="Hapus permanen" className="text-[10px] px-1.5 py-1 rounded text-red-400 hover:bg-[var(--surface)]">🗑</button>
        </div>
      </div>
    </div>
  )
}, qcCardEqual)

function NoteEditor({ result, onClose, onSave }) {
  const [notes, setNotes] = useState(result.qc_notes || '')
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-xl bg-[var(--surface)] rounded-xl border border-[var(--border)]">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-lg font-bold">QC Note — {result.label}</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6">
          <textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Apa yang perlu diperbaiki? Apa yang udah oke?"
            className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
        </div>
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm">Batal</button>
          <button onClick={async () => { setBusy(true); await onSave(notes); setBusy(false) }} disabled={busy}
            className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '...' : '✓ Simpan'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FilterPill({ on, onClick, label }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold ${on ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)] hover:text-white'}`}>
      {label}
    </button>
  )
}

function Pill({ className, children }) {
  return <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${className}`}>{children}</span>
}
