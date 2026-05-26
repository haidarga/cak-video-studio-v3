'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  falRun, buildImgInput, buildVidInput, productDirective,
  IMG_QUALITY, VID_STABILITY, VIDEO_MODELS, IMAGE_MODELS,
} from '@/lib/fal-client'

export default function GenerateClient({ workspaceId, userId, activeBrand, personas, workspaceRefs }) {
  const supabase = createClient()
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [globalConfig, setGlobalConfig] = useState({
    mode: 'shots', ar: '9:16', lang: 'Indonesian',
    imgModel: IMAGE_MODELS[0].v, vidModel: VIDEO_MODELS[0].v,
  })
  const [stateByPersona, setStateByPersona] = useState({})  // { [personaId]: { naskah, refIds, parsed, busy, shots: [{ id, status, image_url, video_url, error, result_id, label }] } }
  const [err, setErr] = useState('')

  function togglePersona(id) {
    setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
    setStateByPersona((st) => {
      if (st[id]) return st
      return { ...st, [id]: { naskah: '', refIds: new Set(), parsed: null, busy: false, shots: [] } }
    })
  }
  function selectAll() {
    setSelectedIds((s) => s.size === personas.length ? new Set() : new Set(personas.map((p) => p.id)))
  }
  function patchPersona(id, patch) {
    setStateByPersona((st) => ({ ...st, [id]: { ...st[id], ...(typeof patch === 'function' ? patch(st[id]) : patch) } }))
  }

  const selectedPersonas = useMemo(() => personas.filter((p) => selectedIds.has(p.id)), [personas, selectedIds])

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold mb-1">⚡ Generate</h1>
        <p className="text-sm text-[var(--muted)]">
          Pilih persona → tiap persona dapet editor sendiri (naskah, refs, parse, generate). Hasil auto-group per persona, langsung bisa rename/Send to QC.
          {activeBrand && <> · Brand aktif: <strong className="text-[var(--accent)]">{activeBrand.name}</strong></>}
        </p>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      {/* Global config */}
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-3">Global Config (berlaku ke semua persona)</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Sel label="Mode" value={globalConfig.mode} onChange={(v) => setGlobalConfig({ ...globalConfig, mode: v })}
            options={[['shots', '🎬 Per-Shot (5-8 cut)'], ['storyboard', '🗂 Storyboard 3×3 (~15s)']]} />
          <Sel label="Aspect Ratio" value={globalConfig.ar} onChange={(v) => setGlobalConfig({ ...globalConfig, ar: v })}
            options={[['9:16', '9:16 vertical'], ['16:9', '16:9 horizontal'], ['1:1', '1:1 square']]} />
          <Sel label="Bahasa Dialog" value={globalConfig.lang} onChange={(v) => setGlobalConfig({ ...globalConfig, lang: v })}
            options={[['Indonesian', 'Indonesian'], ['English', 'English'], ['Javanese', 'Javanese'], ['Sundanese', 'Sundanese'], ['Balinese', 'Balinese']]} />
          <Sel label="Video Model" value={globalConfig.vidModel} onChange={(v) => setGlobalConfig({ ...globalConfig, vidModel: v })}
            options={VIDEO_MODELS.map((m) => [m.v, m.l])} />
          <Sel label="Image Model" value={globalConfig.imgModel} onChange={(v) => setGlobalConfig({ ...globalConfig, imgModel: v })}
            options={IMAGE_MODELS.map((m) => [m.v, m.l])} />
        </div>
      </section>

      {/* Persona picker */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)]">
            Pilih Persona ({selectedIds.size}/{personas.length})
          </h2>
          {personas.length > 0 && (
            <button onClick={selectAll} className="text-[10px] text-[var(--muted)] underline hover:text-white">
              {selectedIds.size === personas.length ? 'Unselect all' : 'Select all'}
            </button>
          )}
        </div>
        {personas.length === 0 ? (
          <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">
            Belum ada persona. <a href="/personas" className="underline text-[var(--accent)]">Bikin persona dulu</a>.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {personas.map((p) => {
              const on = selectedIds.has(p.id)
              return (
                <button key={p.id} onClick={() => togglePersona(p.id)}
                  className={`text-left p-3 rounded-lg border ${on
                    ? 'border-[var(--accent)] bg-[var(--surface)]'
                    : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--muted)]'}`}>
                  <div className="flex items-center gap-2">
                    {p.avatar_url
                      ? <img src={p.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
                      : <div className="w-9 h-9 rounded-full bg-[var(--surface2)] flex items-center justify-center text-sm font-bold">{(p.name || '?').slice(0, 1).toUpperCase()}</div>}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate flex items-center gap-1">
                        {on && <span className="text-[var(--accent)]">✓</span>}{p.name}
                      </div>
                      <div className="text-[10px] text-[var(--muted)] truncate">@{p.username || '—'}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Per-persona editors */}
      {selectedPersonas.map((persona) => (
        <PersonaSection
          key={persona.id}
          persona={persona}
          workspaceRefs={workspaceRefs}
          state={stateByPersona[persona.id] || { naskah: '', refIds: new Set(), parsed: null, busy: false, shots: [] }}
          onPatch={(patch) => patchPersona(persona.id, patch)}
          globalConfig={globalConfig}
          activeBrand={activeBrand}
          workspaceId={workspaceId}
          userId={userId}
          onErr={setErr}
          supabase={supabase}
        />
      ))}

      {selectedPersonas.length === 0 && (
        <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center">
          Pilih persona di atas buat mulai. Tiap persona bakal punya editor sendiri di sini.
        </div>
      )}
    </div>
  )
}

function PersonaSection({ persona, workspaceRefs, state, onPatch, globalConfig, activeBrand, workspaceId, userId, onErr, supabase }) {
  const personaRefs = (persona.persona_refs || []).map((pr) => pr.refs).filter(Boolean)
  const allAvailableRefs = useMemo(() => {
    const map = new Map()
    personaRefs.forEach((r) => map.set(r.id, { ...r, source: 'persona' }))
    workspaceRefs.forEach((r) => { if (!map.has(r.id)) map.set(r.id, { ...r, source: 'workspace' }) })
    return [...map.values()]
  }, [personaRefs, workspaceRefs])

  // Default: all persona refs selected when section first opens
  useEffect(() => {
    if (state.refIds.size === 0 && personaRefs.length > 0) {
      onPatch({ refIds: new Set(personaRefs.map((r) => r.id)) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona.id])

  const selectedRefs = allAvailableRefs.filter((r) => state.refIds.has(r.id))

  async function parseNaskah() {
    if (!state.naskah.trim()) { onErr(`${persona.name}: naskah kosong`); return }
    onPatch({ busy: true }); onErr('')
    try {
      const refLabels = selectedRefs.map((r) => r.label).filter(Boolean)
      const res = await fetch('/api/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          naskah: state.naskah, lang: globalConfig.lang, mode: globalConfig.mode, ar: globalConfig.ar,
          refLabels, brand: activeBrand ? { notes: activeBrand.notes, config: activeBrand.config } : null,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      onPatch({ parsed: data.parsed })
    } catch (e) { onErr(`${persona.name}: ${e.message}`) }
    onPatch({ busy: false })
  }

  async function generateOneShot(shotIdx, shot) {
    const patchShot = (patch) => onPatch((s) => {
      const next = [...s.shots]
      next[shotIdx] = { ...next[shotIdx], ...patch }
      return { shots: next }
    })

    try {
      // 1. Image gen
      patchShot({ status: 'generating image' })
      const productKnowledge = selectedRefs.map((r) => (r.knowledge || '').trim()).filter(Boolean).join('\n')
      const directive = productDirective(productKnowledge || activeBrand?.notes)
      const fullPrompt = `${shot.image_prompt || ''}. ${globalConfig.ar} composition. CONTINUITY: keep characters & product identical to references.${directive} ${IMG_QUALITY}`
      const refUrls = selectedRefs.map((r) => r.fal_url).filter(Boolean)
      const imgInput = buildImgInput(globalConfig.imgModel, { prompt: fullPrompt, refUrls, ar: globalConfig.ar })
      const imgResult = await falRun(globalConfig.imgModel, imgInput, { onProgress: (p) => patchShot({ status: `img: ${p}` }) })
      const imageUrl = imgResult.images?.[0]?.url
      if (!imageUrl) throw new Error('image gen returned no URL')
      patchShot({ image_url: imageUrl, status: 'generating video' })

      // 2. Video gen
      const motion = shot.dialogue
        ? `${shot.video_motion}. The subject speaks in fluent native ${globalConfig.lang}: "${shot.dialogue}". ${VID_STABILITY}`
        : `${shot.video_motion || 'Natural cinematic motion'}. ${VID_STABILITY}`
      const vidInput = buildVidInput(globalConfig.vidModel, { prompt: motion, image_url: imageUrl, reference_urls: refUrls, duration: shot.duration || 5, aspect_ratio: globalConfig.ar })
      const vidResult = await falRun(globalConfig.vidModel, vidInput, { onProgress: (p) => patchShot({ status: `vid: ${p}` }) })
      const videoUrl = vidResult.video?.url || vidResult.video
      if (!videoUrl) throw new Error('video gen returned no URL')

      // 3. Insert into results
      const label = `${persona.name} — Shot ${shot.shot}`
      const { data: row, error } = await supabase.from('results').insert({
        workspace_id: workspaceId, persona_id: persona.id, type: 'video', url: videoUrl, label, ar: globalConfig.ar,
        group_label: persona.name,
        meta: { image_url: imageUrl, shot, source: 'generate' },
        created_by: userId,
      }).select('id').single()
      if (error) throw error
      patchShot({ status: 'done', video_url: videoUrl, result_id: row.id, label })
    } catch (e) {
      patchShot({ status: 'error', error: String(e?.message || e) })
    }
  }

  async function generateAll() {
    if (!state.parsed) { onErr(`${persona.name}: parse dulu`); return }
    const shots = state.parsed.shots || (state.parsed.panels ? [{ /* storyboard single */ shot: 1, duration: 15, image_prompt: 'storyboard', video_motion: 'Continuous sequence' }] : [])
    if (!shots.length) { onErr(`${persona.name}: gak ada shot`); return }
    onPatch({
      busy: true, shots: shots.map((s, i) => ({ id: `${persona.id}-${i}`, shot: s.shot || i + 1, status: 'queued', label: `Shot ${s.shot || i + 1}` })),
    })
    for (let i = 0; i < shots.length; i++) {
      await generateOneShot(i, shots[i])
    }
    onPatch({ busy: false })
  }

  async function renameResult(resultId, newLabel) {
    const { error } = await supabase.from('results').update({ label: newLabel }).eq('id', resultId)
    if (error) onErr(error.message)
  }
  async function sendToQC(resultId) {
    const { error } = await supabase.from('results').update({ qc_status: 'pending' }).eq('id', resultId)
    if (error) onErr(error.message)
    else onErr('')
  }
  async function deleteResult(resultId, shotIdx) {
    if (!confirm('Hapus hasil ini?')) return
    const { error } = await supabase.from('results').delete().eq('id', resultId)
    if (error) onErr(error.message)
    else {
      onPatch((s) => {
        const next = [...s.shots]
        next[shotIdx] = { ...next[shotIdx], status: 'deleted', video_url: null, result_id: null }
        return { shots: next }
      })
    }
  }

  return (
    <section className="bg-[var(--surface)] border-2 border-[var(--accent)]/30 rounded-lg p-4">
      <header className="flex items-center gap-3 mb-4">
        {persona.avatar_url
          ? <img src={persona.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover" />
          : <div className="w-10 h-10 rounded-full bg-[var(--surface2)] flex items-center justify-center text-base font-bold">{(persona.name || '?').slice(0, 1).toUpperCase()}</div>}
        <div className="flex-1">
          <div className="text-lg font-bold">{persona.name}</div>
          <div className="text-xs text-[var(--muted)]">@{persona.username || '—'} · {personaRefs.length} ref{personaRefs.length !== 1 ? 's' : ''}</div>
        </div>
      </header>

      <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">Naskah</label>
          <textarea rows={4} value={state.naskah} onChange={(e) => onPatch({ naskah: e.target.value })}
            placeholder={`Tempel naskah buat ${persona.name}...`}
            className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
        </div>

        <div>
          <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">
            Refs ({state.refIds.size}/{allAvailableRefs.length}) — character + product
          </label>
          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-1">
            {allAvailableRefs.map((r) => {
              const on = state.refIds.has(r.id)
              return (
                <button key={r.id} onClick={() => {
                  const next = new Set(state.refIds)
                  next.has(r.id) ? next.delete(r.id) : next.add(r.id)
                  onPatch({ refIds: next })
                }}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--surface2)] opacity-60 hover:opacity-100'}`}>
                  <img src={r.fal_url} alt="" className="w-7 h-7 rounded object-cover" />
                  <span className="max-w-[80px] truncate">{r.label || 'unlabeled'}</span>
                  {r.kind === 'product' && <span title="product" className="text-[9px]">📦</span>}
                  {r.knowledge && <span title="has knowledge" className="text-[9px]">📋</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={parseNaskah} disabled={state.busy || !state.naskah.trim()}
            className="px-4 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold hover:bg-[var(--border)] disabled:opacity-50">
            {state.busy && !state.shots.length ? '⏳ Parsing...' : '🤖 Parse with Gemini'}
          </button>
          <button onClick={generateAll} disabled={state.busy || !state.parsed}
            className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50">
            {state.busy && state.shots.length ? '⏳ Generating...' : `⚡ Generate (${(state.parsed?.shots || state.parsed?.panels || []).length} shots)`}
          </button>
        </div>

        {state.parsed && (
          <details className="text-xs">
            <summary className="cursor-pointer text-[var(--muted)] hover:text-white">Liat parsed shots ({(state.parsed.shots || state.parsed.panels || []).length})</summary>
            <div className="mt-2 space-y-1.5 max-h-60 overflow-y-auto">
              {(state.parsed.shots || state.parsed.panels || []).map((item, i) => (
                <div key={i} className="bg-[var(--surface2)] rounded p-2">
                  <div className="font-semibold">{state.parsed.shots ? `Shot ${item.shot} · ${item.duration}s` : `Panel ${item.n}: ${item.title}`}</div>
                  {(item.image_prompt || item.visual) && <div className="text-[var(--muted)] mt-0.5">📷 {item.image_prompt || item.visual}</div>}
                  {item.video_motion && <div className="text-[var(--muted)] mt-0.5">🎥 {item.video_motion}</div>}
                  {(item.dialogue || item.dialog) && <div className="text-[#93c5fd] mt-0.5 italic">💬 {item.dialogue || item.dialog}</div>}
                </div>
              ))}
            </div>
          </details>
        )}

        {state.shots.length > 0 && (
          <div className="pt-3 border-t border-[var(--border)]">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)] mb-2">📁 Results — auto-grouped ke "{persona.name}"</div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
              {state.shots.map((sh, i) => (
                <ResultCard key={sh.id} shot={sh}
                  onRename={(label) => { renameResult(sh.result_id, label); onPatch((s) => { const n = [...s.shots]; n[i] = { ...n[i], label }; return { shots: n } }) }}
                  onSendQC={() => sendToQC(sh.result_id)}
                  onDelete={() => deleteResult(sh.result_id, i)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function ResultCard({ shot, onRename, onSendQC, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(shot.label || '')
  return (
    <div className="bg-[var(--surface2)] border border-[var(--border)] rounded overflow-hidden">
      <div className="relative aspect-[9/16] bg-black">
        {shot.video_url
          ? <video src={shot.video_url} controls muted loop playsInline className="w-full h-full object-cover" />
          : shot.image_url
            ? <img src={shot.image_url} alt="" className="w-full h-full object-cover opacity-50" />
            : <div className="w-full h-full flex items-center justify-center text-[10px] text-[var(--muted)] p-2 text-center">{shot.status || 'queued'}</div>}
        {shot.status && shot.status !== 'done' && shot.status !== 'error' && shot.status !== 'deleted' && (
          <div className="absolute bottom-1 left-1 right-1 text-[9px] bg-black/70 text-white px-1.5 py-0.5 rounded truncate">⏳ {shot.status}</div>
        )}
        {shot.status === 'error' && (
          <div className="absolute bottom-1 left-1 right-1 text-[9px] bg-red-900/80 text-white px-1.5 py-0.5 rounded">⚠ {shot.error}</div>
        )}
      </div>
      <div className="p-2">
        {editing ? (
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { setEditing(false); if (label !== shot.label) onRename(label) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
            autoFocus className="w-full text-xs px-1 py-0.5 rounded bg-[var(--surface)] border border-[var(--accent)] focus:outline-none" />
        ) : (
          <div onDoubleClick={() => setEditing(true)} className="text-xs font-semibold truncate cursor-text" title="double-click buat rename">
            {shot.label || 'untitled'}
          </div>
        )}
        {shot.status === 'done' && (
          <div className="flex gap-1 mt-1.5">
            <button onClick={onSendQC} className="flex-1 text-[10px] px-1.5 py-1 rounded bg-[var(--surface)] hover:bg-[var(--border)] font-semibold">🧪 QC</button>
            <button onClick={onDelete} className="text-[10px] px-1.5 py-1 rounded text-red-400 hover:bg-[var(--surface)]">🗑</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Sel({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold mb-1.5">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
}
