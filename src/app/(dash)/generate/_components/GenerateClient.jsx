'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const VIDEO_MODELS = [
  { v: 'fal-ai/kling-video/v3/standard/image-to-video', l: 'Kling v3 — ~$0.08/dtk 💰' },
  { v: 'fal-ai/kling-video/o3/standard/image-to-video', l: 'Kling O3 — ~$0.11/dtk (audio)' },
  { v: 'alibaba/happy-horse/image-to-video', l: 'Happy Horse 1.0 — ~$0.14/dtk' },
  { v: 'bytedance/seedance-2.0/fast/image-to-video', l: 'Seedance 2 Fast — ~$0.24/dtk' },
]
const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — fast' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — best text' },
]

export default function GenerateClient({ workspaceId, userId, activeBrand, initialPersonas, initialJobs }) {
  const supabase = createClient()
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [naskahByPersona, setNaskahByPersona] = useState({})
  const [config, setConfig] = useState({
    vidModel: VIDEO_MODELS[0].v,
    imgModel: IMAGE_MODELS[0].v,
    ar: '9:16',
    mode: 'shots',
    lang: 'Indonesian',
  })
  const [parsing, setParsing] = useState({})
  const [queueing, setQueueing] = useState(false)
  const [parsedByPersona, setParsedByPersona] = useState({})
  const [jobs, setJobs] = useState(initialJobs)
  const [err, setErr] = useState('')

  useEffect(() => {
    const ch = supabase.channel('gen-jobs-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs', filter: `workspace_id=eq.${workspaceId}` }, (p) => {
        if (p.eventType === 'INSERT') setJobs((prev) => [p.new, ...prev].slice(0, 25))
        else if (p.eventType === 'UPDATE') setJobs((prev) => prev.map((j) => j.id === p.new.id ? p.new : j))
        else if (p.eventType === 'DELETE') setJobs((prev) => prev.filter((j) => j.id !== p.old.id))
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  function togglePersona(id) {
    setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll() {
    setSelectedIds((s) => s.size === initialPersonas.length ? new Set() : new Set(initialPersonas.map((p) => p.id)))
  }
  const selectedPersonas = useMemo(() => initialPersonas.filter((p) => selectedIds.has(p.id)), [initialPersonas, selectedIds])

  async function parseOne(persona) {
    const naskah = (naskahByPersona[persona.id] || '').trim()
    if (!naskah) { setErr(`${persona.name}: naskah kosong`); return }
    setParsing((p) => ({ ...p, [persona.id]: true })); setErr('')
    try {
      const refLabels = (persona.persona_refs || []).map((pr) => pr.refs?.label).filter(Boolean)
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          naskah, lang: config.lang, mode: config.mode, ar: config.ar, refLabels,
          brand: activeBrand ? { notes: activeBrand.notes, config: activeBrand.config } : null,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      setParsedByPersona((p) => ({ ...p, [persona.id]: data.parsed }))
    } catch (e) { setErr(`${persona.name}: ${e.message}`) }
    setParsing((p) => ({ ...p, [persona.id]: false }))
  }

  async function parseAll() {
    if (!selectedPersonas.length) { setErr('Pilih persona dulu'); return }
    setErr('')
    await Promise.all(selectedPersonas.map((p) => parseOne(p)))
  }

  async function queueGenerate() {
    const ready = selectedPersonas.filter((p) => parsedByPersona[p.id])
    if (!ready.length) { setErr('Parse dulu sebelum queue generate'); return }
    setQueueing(true); setErr('')
    try {
      const refSnapshotByPersona = (personaId) => {
        const persona = initialPersonas.find((x) => x.id === personaId)
        return (persona?.persona_refs || []).map((pr) => pr.refs).filter(Boolean)
      }
      const jobRows = ready.flatMap((persona) => {
        const parsed = parsedByPersona[persona.id]
        const refs = refSnapshotByPersona(persona.id)
        if (config.mode === 'storyboard') {
          return [{
            workspace_id: workspaceId,
            kind: 'bulk',
            config: {
              persona_id: persona.id, persona_name: persona.name, persona_username: persona.username,
              postiz_channel_id: persona.postiz_channel_id,
              refs, brand: activeBrand,
              mode: 'storyboard', vidModel: config.vidModel, imgModel: config.imgModel,
              ar: config.ar, lang: config.lang,
              storyboard: parsed,
            },
            created_by: userId,
          }]
        }
        return (parsed.shots || []).map((shot) => ({
          workspace_id: workspaceId,
          kind: 'pipeline',
          config: {
            persona_id: persona.id, persona_name: persona.name, persona_username: persona.username,
            postiz_channel_id: persona.postiz_channel_id,
            refs, brand: activeBrand,
            mode: 'shots', vidModel: config.vidModel, imgModel: config.imgModel,
            ar: config.ar, lang: config.lang,
            shot,
          },
          created_by: userId,
        }))
      })
      const { error } = await supabase.from('jobs').insert(jobRows)
      if (error) throw error
    } catch (e) { setErr(e.message) }
    setQueueing(false)
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold mb-1">⚡ Generate</h1>
        <p className="text-sm text-[var(--muted)]">
          Multi-persona pipeline. Pilih persona → naskah per-persona → Parse (Gemini) → queue jobs.
          {activeBrand && <> · Brand aktif: <strong className="text-[var(--accent)]">{activeBrand.name}</strong></>}
        </p>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      {/* 1. Persona picker */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)]">
            1️⃣ Pilih Persona ({selectedIds.size}/{initialPersonas.length})
          </h2>
          {initialPersonas.length > 0 && (
            <button onClick={selectAll} className="text-[10px] text-[var(--muted)] underline hover:text-white">
              {selectedIds.size === initialPersonas.length ? 'Unselect all' : 'Select all'}
            </button>
          )}
        </div>
        {initialPersonas.length === 0 ? (
          <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">
            Belum ada persona. <a href="/personas" className="underline text-[var(--accent)]">Bikin persona dulu</a>.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {initialPersonas.map((p) => {
              const on = selectedIds.has(p.id)
              return (
                <button key={p.id} onClick={() => togglePersona(p.id)}
                  className={`text-left p-3 rounded-lg border transition ${on
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

      {/* 2. Naskah per persona */}
      {selectedPersonas.length > 0 && (
        <section>
          <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-2">
            2️⃣ Naskah per Persona
          </h2>
          <div className="space-y-3">
            {selectedPersonas.map((p) => {
              const parsed = parsedByPersona[p.id]
              const isParsing = parsing[p.id]
              return (
                <div key={p.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    {p.avatar_url
                      ? <img src={p.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" />
                      : <div className="w-6 h-6 rounded-full bg-[var(--surface2)] flex items-center justify-center text-[10px] font-bold">{(p.name || '?').slice(0, 1).toUpperCase()}</div>}
                    <div className="text-sm font-semibold">{p.name}</div>
                    <div className="text-[10px] text-[var(--muted)]">@{p.username || '—'}</div>
                    <div className="ml-auto flex items-center gap-2">
                      {parsed && (
                        <span className="text-[10px] text-green-400 font-semibold">
                          ✓ {(parsed.shots || parsed.panels || []).length} {parsed.shots ? 'shots' : 'panels'}
                        </span>
                      )}
                      <button onClick={() => parseOne(p)} disabled={isParsing}
                        className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--border)] disabled:opacity-50">
                        {isParsing ? '⏳ Parsing' : '🤖 Parse'}
                      </button>
                    </div>
                  </div>
                  <textarea rows={3} value={naskahByPersona[p.id] || ''}
                    onChange={(e) => setNaskahByPersona({ ...naskahByPersona, [p.id]: e.target.value })}
                    placeholder="Tempel naskah untuk persona ini..."
                    className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
                  {parsed && (
                    <div className="mt-3 text-xs space-y-1.5 max-h-60 overflow-y-auto pr-2">
                      {(parsed.shots || parsed.panels || []).map((item, i) => (
                        <div key={i} className="bg-[var(--surface2)] rounded p-2">
                          <div className="font-semibold text-[11px]">
                            {parsed.shots ? `Shot ${item.shot} · ${item.duration}s` : `Panel ${item.n} (${item.seconds}s) · ${item.title}`}
                          </div>
                          {(item.image_prompt || item.visual) && <div className="text-[var(--muted)] mt-0.5">📷 {item.image_prompt || item.visual}</div>}
                          {item.video_motion && <div className="text-[var(--muted)] mt-0.5">🎥 {item.video_motion}</div>}
                          {(item.dialogue || item.dialog) && <div className="text-[#93c5fd] mt-0.5 italic">💬 {item.dialogue || item.dialog}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 3. Config */}
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-3">3️⃣ Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Sel label="Mode" value={config.mode} onChange={(v) => setConfig({ ...config, mode: v })}
            options={[['shots', '🎬 Per-Shot (5-8 cuts)'], ['storyboard', '🗂 Storyboard 3×3 (~15s)']]} />
          <Sel label="Aspect Ratio" value={config.ar} onChange={(v) => setConfig({ ...config, ar: v })}
            options={[['9:16', '9:16 vertical'], ['16:9', '16:9 horizontal'], ['1:1', '1:1 square']]} />
          <Sel label="Video Model" value={config.vidModel} onChange={(v) => setConfig({ ...config, vidModel: v })}
            options={VIDEO_MODELS.map((m) => [m.v, m.l])} />
          <Sel label="Image Model" value={config.imgModel} onChange={(v) => setConfig({ ...config, imgModel: v })}
            options={IMAGE_MODELS.map((m) => [m.v, m.l])} />
          <Sel label="Bahasa Dialog" value={config.lang} onChange={(v) => setConfig({ ...config, lang: v })}
            options={[['Indonesian', 'Indonesian'], ['English', 'English'], ['Javanese', 'Javanese'], ['Sundanese', 'Sundanese'], ['Balinese', 'Balinese']]} />
        </div>
      </section>

      {/* 4. Actions */}
      <section className="flex flex-wrap gap-3">
        <button onClick={parseAll} disabled={!selectedPersonas.length || Object.values(parsing).some(Boolean)}
          className="px-5 py-2.5 rounded bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold hover:bg-[var(--border)] disabled:opacity-50">
          🤖 Parse Semua (Gemini)
        </button>
        <button onClick={queueGenerate} disabled={queueing || !Object.keys(parsedByPersona).length}
          className="px-5 py-2.5 rounded bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50">
          {queueing ? '⏳ Queuing...' : '⚡ Queue Generate Jobs'}
        </button>
      </section>

      {/* 5. Live jobs */}
      <section>
        <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-2">📋 Live Jobs (realtime)</h2>
        {jobs.length === 0 ? (
          <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">
            Belum ada job — queue dulu di atas ☝️
          </div>
        ) : (
          <div className="space-y-1.5">
            {jobs.map((j) => (
              <div key={j.id} className="bg-[var(--surface)] border border-[var(--border)] rounded p-2.5 flex items-center gap-3 text-xs">
                <StatusBadge status={j.status} />
                <span className="font-mono text-[10px] text-[var(--muted2)]">{j.id.slice(0, 8)}</span>
                <span className="font-semibold">{j.kind}</span>
                <span className="text-[var(--muted)] flex-1 truncate">
                  {j.config?.persona_name && `→ ${j.config.persona_name}`}
                  {j.config?.shot && ` · shot ${j.config.shot.shot}`}
                  {j.config?.storyboard && ` · storyboard`}
                </span>
                {j.progress > 0 && <span className="text-[var(--muted)]">{j.progress}%</span>}
                <span className="text-[var(--muted2)] text-[10px]">{new Date(j.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="text-[10px] text-[var(--muted2)] p-3 bg-[var(--surface)] rounded border border-[var(--border)] leading-relaxed">
        ℹ️ <strong>Status worker (Phase 2):</strong> Job di-queue ke DB tapi belum dieksekusi otomatis — worker (HF Space) belum nge-poll Supabase. Yang udah jalan: <strong>Parse pake Gemini real</strong> ✓, persona+naskah+config+queue real DB ✓, realtime jobs subscription ✓. Eksekusi video gen (fal calls) nyusul setelah worker di-rewire.
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

function StatusBadge({ status }) {
  const map = {
    done:      'bg-green-500/20 text-green-400',
    running:   'bg-orange-500/20 text-orange-400',
    error:     'bg-red-500/20 text-red-400',
    cancelled: 'bg-[var(--surface2)] text-[var(--muted)]',
    queued:    'bg-blue-500/20 text-blue-400',
  }
  return (
    <span className={`px-2 py-0.5 rounded font-semibold ${map[status] || 'bg-[var(--surface2)] text-[var(--muted)]'}`}>
      {status}
    </span>
  )
}
