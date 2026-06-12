'use client'
// F CREATOR — autopilot content factory.
// Pick persona → paste N naskah → RUN: parse → gen (KONTI chain) →
// auto-assemble + subtitle → optional voice swap → lands in QC pending.
// The browser IS the factory worker (final render = ffmpeg.wasm), so the
// tab must stay open while running — wakeLock keeps the machine awake and
// factory_runs persistence makes a refresh resume, not restart.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { VIDEO_MODELS, IMAGE_MODELS } from '@/lib/fal-client'
import { imageCost, videoCost, fmtCost } from '@/lib/cost-table'
import { runNaskahPipeline, effectiveVidModel } from '../_lib/factory-pipeline'

const MODES = [
  { v: 'shots', l: '🎬 Per-Shot (image → video)' },
  { v: 'storyboard', l: '🗂 Storyboard 3×3 (~15s)' },
  { v: 'direct', l: '🎯 Direct Video (refs only)' },
]
const STAGE_CHIPS = ['parse', 'images', 'videos', 'assemble', 'voice', 'qc']
const STAGE_LABEL = { parse: 'Parse', images: 'Imgs', videos: 'Vids', assemble: 'Edit', voice: 'Voice', qc: 'QC' }

function uid() { return Math.random().toString(36).slice(2, 10) }

export default function FCreatorClient({ workspaceId, userId, activeBrand, personas, workspaceRefs }) {
  const supabase = createClient()

  // ── config ──
  const [personaId, setPersonaId] = useState(personas[0]?.id || null)
  const persona = useMemo(() => personas.find((p) => p.id === personaId) || null, [personas, personaId])
  const personaRefIds = useMemo(() => new Set(
    (persona?.persona_refs || []).map((pr) => pr.refs?.id).filter(Boolean)
  ), [persona])
  const [extraRefIds, setExtraRefIds] = useState(new Set())
  // Refs for the run = persona's own refs + manually toggled workspace refs.
  const cfgRefs = useMemo(() => workspaceRefs.filter((r) => personaRefIds.has(r.id) || extraRefIds.has(r.id)), [workspaceRefs, personaRefIds, extraRefIds])

  const [mode, setMode] = useState('shots')
  const [imgModel, setImgModel] = useState(IMAGE_MODELS[0]?.v || 'fal-ai/nano-banana-2/edit')
  const [vidModel, setVidModel] = useState('fal-ai/kling-video/o3/standard/image-to-video')
  const [ar, setAr] = useState('9:16')
  const [duration, setDuration] = useState(5)
  const [shotCount, setShotCount] = useState('') // '' = auto
  const [chips, setChips] = useState({ noCuts: true, noDialog: false, noText: true, noProduct: false })
  const [konti, setKonti] = useState(true)
  const [autoEdit, setAutoEdit] = useState({ subtitle: true, transitions: true, hook: true })
  const [voiceSwap, setVoiceSwap] = useState(false)
  const [lang, setLang] = useState('Indonesian')

  // ── queue ──
  const [items, setItems] = useState([{ id: uid(), naskah: '', stage: 'idle', detail: '' }])
  const itemsRef = useRef(items)
  itemsRef.current = items

  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const stopRef = useRef(false)
  const wakeLockRef = useRef(null)
  const runIdRef = useRef(null)
  const persistWarnedRef = useRef(false)
  const [resumeRun, setResumeRun] = useState(null)

  function updateItem(idx, patch) {
    setItems((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], ...patch }
      itemsRef.current = next
      return next
    })
  }

  // ── persistence (resume-safe; tolerates missing table) ──
  async function persist(status = 'running') {
    try {
      const payload = {
        workspace_id: workspaceId, created_by: userId, status,
        config: { personaId, mode, imgModel, vidModel, ar, duration, shotCount, chips, konti, autoEdit, voiceSwap, lang, extraRefIds: [...extraRefIds] },
        items: itemsRef.current,
        updated_at: new Date().toISOString(),
      }
      if (runIdRef.current) {
        await supabase.from('factory_runs').update(payload).eq('id', runIdRef.current)
      } else {
        const { data, error } = await supabase.from('factory_runs').insert(payload).select('id').single()
        if (error) throw error
        runIdRef.current = data.id
      }
    } catch (e) {
      if (!persistWarnedRef.current) {
        persistWarnedRef.current = true
        setErr(`⚠ Run state gak kesimpen (apply migration 0027_factory_runs.sql biar refresh bisa resume): ${String(e?.message || e).slice(0, 120)}`)
      }
    }
  }

  // Offer resume of the latest unfinished run.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data } = await supabase.from('factory_runs')
          .select('id, config, items, created_at')
          .eq('workspace_id', workspaceId).eq('status', 'running')
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (alive && data && (data.items || []).some((it) => it.stage !== 'done')) setResumeRun(data)
      } catch { /* table belum ada — fine */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function loadResume() {
    const c = resumeRun.config || {}
    if (c.personaId && personas.some((p) => p.id === c.personaId)) setPersonaId(c.personaId)
    if (c.mode) setMode(c.mode)
    if (c.imgModel) setImgModel(c.imgModel)
    if (c.vidModel) setVidModel(c.vidModel)
    if (c.ar) setAr(c.ar)
    if (c.duration) setDuration(c.duration)
    if (c.shotCount != null) setShotCount(c.shotCount)
    if (c.chips) setChips(c.chips)
    if (c.konti != null) setKonti(c.konti)
    if (c.autoEdit) setAutoEdit(c.autoEdit)
    if (c.voiceSwap != null) setVoiceSwap(c.voiceSwap)
    if (Array.isArray(c.extraRefIds)) setExtraRefIds(new Set(c.extraRefIds))
    const loaded = (resumeRun.items || []).map((it) => ({ ...it, detail: it.stage === 'done' ? '✓ Siap QC' : (it.stage === 'error' ? it.error : 'resume dari sini') }))
    setItems(loaded); itemsRef.current = loaded
    runIdRef.current = resumeRun.id
    setResumeRun(null)
  }

  // ── cost estimator (kasar, sebelum RUN) ──
  const estimate = useMemo(() => {
    const filled = items.filter((it) => it.naskah.trim() && it.stage !== 'done')
    if (!filled.length) return 0
    const evm = effectiveVidModel(vidModel, mode)
    let per = 0
    if (mode === 'storyboard') {
      per = imageCost(imgModel) + videoCost(evm, 15)
    } else {
      const n = parseInt(shotCount) || 3
      const imgs = mode === 'direct' ? 0 : (konti ? 1 : n)
      per = imgs * imageCost(imgModel) + n * videoCost(evm, duration)
    }
    if (autoEdit.subtitle) per += 0.02
    if (voiceSwap && persona?.voice_id) per += 0.30
    return per * filled.length
  }, [items, mode, imgModel, vidModel, shotCount, duration, konti, autoEdit, voiceSwap, persona])

  // ── THE FACTORY LOOP ──
  async function runFactory() {
    if (running) return
    if (!persona) { setErr('Pilih persona dulu'); return }
    const queue = itemsRef.current.filter((it) => it.naskah.trim())
    if (!queue.length) { setErr('Isi minimal 1 naskah'); return }
    setErr(''); setRunning(true); stopRef.current = false
    try { wakeLockRef.current = await navigator.wakeLock?.request('screen') } catch {}

    const cfg = {
      persona, refs: cfgRefs, brand: activeBrand,
      mode, imgModel, vidModel, ar, duration,
      shotCount: parseInt(shotCount) || null,
      ...chips, konti: mode === 'storyboard' ? false : konti,
      autoEdit, voiceSwap, lang,
    }
    const deps = { supabase, workspaceId, userId }
    await persist('running')

    for (let i = 0; i < itemsRef.current.length; i++) {
      if (stopRef.current) break
      const item = itemsRef.current[i]
      if (!item.naskah.trim() || item.stage === 'done') continue
      if (!item.label) updateItem(i, { label: `${persona.name} — ${item.naskah.trim().slice(0, 36)}${item.naskah.trim().length > 36 ? '…' : ''}` })
      if (item.stage === 'error') updateItem(i, { stage: 'idle', error: null })
      await runNaskahPipeline(
        itemsRef.current[i], cfg, deps,
        (patch) => updateItem(i, patch),
        () => stopRef.current,
      )
      await persist('running')
    }

    const allDone = itemsRef.current.filter((it) => it.naskah.trim()).every((it) => it.stage === 'done')
    await persist(stopRef.current ? 'paused' : (allDone ? 'done' : 'running'))
    try { wakeLockRef.current?.release?.() } catch {}
    setRunning(false)
  }

  function pauseFactory() { stopRef.current = true }

  const doneCount = items.filter((it) => it.stage === 'done').length
  const queueCount = items.filter((it) => it.naskah.trim()).length

  return (
    <div className="max-w-5xl">
      <div className="hero-halo mb-5 fade-in-up">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[9px] uppercase tracking-[0.2em] font-bold text-[var(--accent)] mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] pulse-live" /> Autopilot Factory
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight">🏭 <span className="gradient-text-strong">F Creator</span></h1>
        <p className="text-sm text-[var(--muted)] mt-1">Pilih persona → paste naskah-naskah → RUN. Pabrik jalan sendiri (parse → gen → konti → auto-edit → subtitle) — lu tinggal QC. <b>Biarin tab ini kebuka selama jalan.</b></p>
      </div>

      {resumeRun && (
        <div className="mb-4 p-3 rounded-lg glass-deep flex items-center gap-3">
          <span className="text-sm">⏯ Ada run yang belum kelar ({(resumeRun.items || []).filter((i) => i.stage === 'done').length}/{(resumeRun.items || []).length} done) — lanjutin?</span>
          <button onClick={loadResume} className="btn-primary-glow text-xs px-4 py-1.5">Lanjutin run</button>
          <button onClick={() => setResumeRun(null)} className="text-xs text-[var(--muted)] hover:text-white">Abaikan</button>
        </div>
      )}
      {err && <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-700 text-red-200 text-xs">{err}</div>}

      {/* ── SETUP ── */}
      <div className="glass-deep p-4 mb-5 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <label className="block col-span-2">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Persona</span>
          <select value={personaId || ''} onChange={(e) => setPersonaId(e.target.value)} disabled={running}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]">
            {personas.map((p) => <option key={p.id} value={p.id}>{p.name}{p.voice_id ? ' 🎙' : ''}</option>)}
          </select>
        </label>
        <label className="block col-span-2">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={running}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]">
            {MODES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
        </label>
        <label className="block col-span-2">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Image model {mode === 'direct' ? '(skip — direct)' : ''}</span>
          <select value={imgModel} onChange={(e) => setImgModel(e.target.value)} disabled={running || mode === 'direct'}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]">
            {IMAGE_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
        </label>
        <label className="block col-span-2">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Video model</span>
          <select value={vidModel} onChange={(e) => setVidModel(e.target.value)} disabled={running}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]">
            {VIDEO_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
          {effectiveVidModel(vidModel, mode) !== vidModel && (
            <span className="text-[9px] text-[var(--amber,#fbbf24)]">mode {mode} → dipakai: {effectiveVidModel(vidModel, mode).split('/').pop()}</span>
          )}
        </label>
        <label className="block">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">AR</span>
          <select value={ar} onChange={(e) => setAr(e.target.value)} disabled={running}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]">
            <option value="9:16">9:16</option><option value="16:9">16:9</option><option value="1:1">1:1</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Detik/shot</span>
          <input type="number" min={3} max={15} value={duration} disabled={running}
            onChange={(e) => setDuration(parseInt(e.target.value) || 5)}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Shot count</span>
          <input type="number" min={1} max={8} placeholder="auto" value={shotCount} disabled={running}
            onChange={(e) => setShotCount(e.target.value)}
            className="w-full mt-1 px-2 py-2 rounded bg-[var(--surface2)] border border-[var(--border)]" />
        </label>
        <div className="block">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Konti (chain antar shot)</span>
          <button onClick={() => setKonti(!konti)} disabled={running || mode === 'storyboard'}
            className={`w-full mt-1 px-2 py-2 rounded border text-left ${konti && mode !== 'storyboard' ? 'bg-[var(--accent)]/25 border-[var(--accent)] font-bold' : 'bg-[var(--surface2)] border-[var(--border)] text-[var(--muted)]'}`}>
            {konti && mode !== 'storyboard' ? '🔗 ON — frame nyambung' : 'OFF'}
          </button>
        </div>

        <div className="col-span-2 md:col-span-4 flex flex-wrap gap-2 pt-1">
          {[['noCuts', '🎬 No cuts'], ['noDialog', '🔇 No dialog'], ['noText', '📝 No text'], ['noProduct', '📦 No product']].map(([k, l]) => (
            <button key={k} onClick={() => setChips((c) => ({ ...c, [k]: !c[k] }))} disabled={running}
              className={`text-[10px] px-2.5 py-1 rounded-full border ${chips[k] ? 'bg-[var(--accent)]/25 border-[var(--accent)] font-bold' : 'bg-[var(--surface2)] border-[var(--border)] text-[var(--muted)]'}`}>
              {chips[k] ? '●' : '○'} {l}
            </button>
          ))}
          <span className="mx-1 text-[var(--border)]">|</span>
          {[['subtitle', '💬 Subtitle'], ['transitions', '✨ Transisi'], ['hook', '🪝 Hook text']].map(([k, l]) => (
            <button key={k} onClick={() => setAutoEdit((c) => ({ ...c, [k]: !c[k] }))} disabled={running}
              className={`text-[10px] px-2.5 py-1 rounded-full border ${autoEdit[k] ? 'bg-pink-500/25 border-pink-500/60 font-bold' : 'bg-[var(--surface2)] border-[var(--border)] text-[var(--muted)]'}`}>
              {autoEdit[k] ? '●' : '○'} {l}
            </button>
          ))}
          <button onClick={() => setVoiceSwap(!voiceSwap)} disabled={running || !persona?.voice_id}
            title={persona?.voice_id ? `Swap ke voice: ${persona.voice_name || 'cloned'} (+$0.30/konten)` : 'Persona belum punya voice (clone dulu di Personas)'}
            className={`text-[10px] px-2.5 py-1 rounded-full border ${voiceSwap && persona?.voice_id ? 'bg-purple-500/30 border-purple-500/70 font-bold' : 'bg-[var(--surface2)] border-[var(--border)] text-[var(--muted)]'} disabled:opacity-40`}>
            {voiceSwap && persona?.voice_id ? '●' : '○'} 🎙 Voice swap
          </button>
        </div>

        {/* refs picker */}
        <div className="col-span-2 md:col-span-4">
          <span className="text-[10px] uppercase font-bold text-[var(--muted)]">Refs ({cfgRefs.length} kepakai — refs persona auto, klik buat nambah produk/lainnya)</span>
          <div className="flex flex-wrap gap-1.5 mt-1.5 max-h-24 overflow-y-auto">
            {workspaceRefs.map((r) => {
              const auto = personaRefIds.has(r.id)
              const on = auto || extraRefIds.has(r.id)
              return (
                <button key={r.id} disabled={running || auto}
                  onClick={() => setExtraRefIds((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n })}
                  title={auto ? 'Auto (ref persona)' : (r.label || '')}
                  className={`text-[9px] px-2 py-1 rounded border truncate max-w-[140px] ${on ? 'bg-[var(--accent)]/25 border-[var(--accent)]' : 'bg-[var(--surface2)] border-[var(--border)] text-[var(--muted2)]'}`}>
                  {r.kind === 'product' ? '📦' : r.kind === 'style' ? '🎨' : '👤'} {r.label || 'ref'}{auto ? ' •' : ''}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── NASKAH QUEUE ── */}
      <div className="space-y-3 mb-5">
        {items.map((item, i) => (
          <div key={item.id} className={`glass-deep p-3 ${item.stage === 'error' ? 'border border-red-500/60' : ''}`}>
            <div className="flex items-start gap-3">
              <div className="text-xs font-bold text-[var(--muted2)] pt-2 w-6">#{i + 1}</div>
              <div className="flex-1 min-w-0">
                <textarea rows={2} value={item.naskah} disabled={running}
                  onChange={(e) => updateItem(i, { naskah: e.target.value })}
                  placeholder="Paste naskah di sini... (vlog UGC review charger, hook di awal, dst)"
                  className="w-full text-xs px-2.5 py-2 rounded bg-[var(--surface2)]/70 border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
                {/* stage chips */}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {STAGE_CHIPS.map((s) => {
                    const order = STAGE_CHIPS.indexOf(s)
                    const cur = STAGE_CHIPS.indexOf(item.stage)
                    const state = item.stage === 'done' ? 'done' : item.stage === 'error' ? (order <= cur ? 'err' : 'wait') : (order < cur ? 'done' : order === cur ? 'now' : 'wait')
                    if (s === 'voice' && !(voiceSwap && persona?.voice_id)) return null
                    return (
                      <span key={s} className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                        state === 'done' ? 'bg-green-500/20 text-green-300'
                        : state === 'now' ? 'bg-[var(--accent)]/30 text-white pulse-live'
                        : state === 'err' ? 'bg-red-500/20 text-red-300'
                        : 'bg-[var(--surface2)] text-[var(--muted2)]'
                      }`}>{STAGE_LABEL[s]}{state === 'done' ? ' ✓' : ''}</span>
                    )
                  })}
                  {item.detail && <span className="text-[9px] text-[var(--muted)] truncate max-w-[320px]">{item.detail}</span>}
                </div>
                {item.error && <div className="text-[10px] text-red-300 mt-1 break-all">⚠ {item.error}</div>}
                {item.stage === 'done' && item.final_url && (
                  <div className="flex gap-2 mt-1.5">
                    <a href={item.final_url} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-0.5 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">▶ Preview</a>
                    <Link href="/qc" className="text-[10px] px-2 py-0.5 rounded bg-green-500/20 border border-green-500/40 text-green-300">🧪 Ke QC</Link>
                  </div>
                )}
              </div>
              {!running && (
                <button onClick={() => setItems((prev) => prev.filter((_, x) => x !== i))}
                  className="text-[var(--muted2)] hover:text-red-400 text-sm pt-1">✕</button>
              )}
            </div>
          </div>
        ))}
        <button onClick={() => setItems((prev) => [...prev, { id: uid(), naskah: '', stage: 'idle', detail: '' }])}
          disabled={running}
          className="w-full text-xs px-3 py-2.5 rounded-lg border border-dashed border-[var(--border-bright)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
          + Tambah naskah
        </button>
      </div>

      {/* ── RUN BAR ── */}
      <div className="glass-deep p-4 flex items-center gap-4 flex-wrap sticky bottom-3 z-20">
        <div className="text-xs">
          <div className="font-bold">{queueCount} naskah{doneCount ? ` · ${doneCount} done` : ''}</div>
          <div className="text-[var(--muted)]">Estimasi kasar: <b className="gradient-text">{fmtCost(estimate)}</b> total</div>
        </div>
        <div className="ml-auto flex gap-2">
          {running ? (
            <button onClick={pauseFactory} className="btn-ghost-glow text-sm">⏸ Pause (selesai stage ini)</button>
          ) : (
            <button onClick={runFactory} disabled={!queueCount || !persona}
              className="btn-primary-glow text-sm px-7 py-3 press-scale disabled:opacity-50">
              ▶ RUN FACTORY
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
