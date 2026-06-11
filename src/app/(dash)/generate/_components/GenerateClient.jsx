'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  falRun, buildImgInput, buildVidInput,
  buildStoryboardGridPrompt,
  VIDEO_MODELS, IMAGE_MODELS,
  getVideoMaxDuration,
} from '@/lib/fal-client'
import { imageCost, videoCost, fmtCost } from '@/lib/cost-table'
import { STYLE_PRESETS } from '@/lib/style-presets'
import { compileImagePrompt, compileVideoPrompt } from '@/lib/prompt-compiler'
import { CAMERA_PRESETS, listAllPresets, DEFAULT_CAMERA, getCameraPreset } from '@/lib/camera-presets'
import { buildIdentitySentence, productNotesShort } from '@/lib/identity'
import { uploadFile } from '@/lib/upload-client'
import { LazyVideo } from '@/lib/use-lazy-video'

export default function GenerateClient({ workspaceId, userId, activeBrand, personas: initialPersonas, workspaceRefs: initialRefs, incomingPreset = null }) {
  const supabase = createClient()
  // Mirror server-fetched data to local state so realtime can keep it fresh.
  // Without this, mutations made elsewhere (other tab, /qc, /refs, persona
  // edit) require a full page refresh to reflect — which is what the user
  // was complaining about.
  const [personas, setPersonas] = useState(initialPersonas)
  const [workspaceRefs, setWorkspaceRefs] = useState(initialRefs)
  const [selectedIds, setSelectedIds] = useState(new Set())

  // Realtime sync: any change to personas / refs / persona_refs (link table)
  // for this workspace triggers a targeted refetch. Single channel covers all
  // tables — cheap on the wire, no re-subscribe per route.
  useEffect(() => {
    if (!workspaceId) return
    let pendingPersonas = null
    let pendingRefs = null
    function reloadPersonas() {
      if (pendingPersonas) return
      pendingPersonas = setTimeout(async () => {
        pendingPersonas = null
        const { data } = await supabase
          .from('personas')
          .select('id, name, username, avatar_url, role_label, postiz_channel_id, voice_id, voice_name, persona_refs(refs(id, fal_url, label, knowledge, kind))')
          .eq('workspace_id', workspaceId).order('created_at', { ascending: false })
        if (data) setPersonas(data)
      }, 400)
    }
    function reloadRefs() {
      if (pendingRefs) return
      pendingRefs = setTimeout(async () => {
        pendingRefs = null
        const { data } = await supabase.from('refs')
          .select('id, fal_url, label, knowledge, kind')
          .eq('workspace_id', workspaceId).order('created_at', { ascending: false })
        if (data) setWorkspaceRefs(data)
      }, 400)
    }
    const ch = supabase.channel('gen-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'personas', filter: `workspace_id=eq.${workspaceId}` }, reloadPersonas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'refs', filter: `workspace_id=eq.${workspaceId}` }, reloadRefs)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'persona_refs' }, reloadPersonas)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
      if (pendingPersonas) { clearTimeout(pendingPersonas); pendingPersonas = null }
      if (pendingRefs) { clearTimeout(pendingRefs); pendingRefs = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const [globalConfig, setGlobalConfig] = useState({
    mode: 'shots', ar: '9:16', lang: 'Indonesian',
    imgModel: IMAGE_MODELS[0].v, vidModel: VIDEO_MODELS[0].v,
    style: 'ugc',                       // @deprecated — kept for back-compat, mapped to camera in compiler
    cameraPreset: DEFAULT_CAMERA,       // NEW — drives Visual Compiler L1
    // Output constraints — toggles per gen session.
    continuousShot: false,
    skipDialog: false,
    skipOnscreen: false,
    skipProduct: false,
    wardrobeOverride: '',
    // Per-Shot mode: optional user-set shot count. null = LLM decides based on
    // naskah length (1+ shots, 3-10s each). Set explicit number to force exactly
    // that many shots. Storyboard mode always 9 panels regardless.
    shotCount: null,
  })
  // Workspace custom camera presets (user-defined). Built-ins are imported.
  const [userCameraPresets, setUserCameraPresets] = useState([])
  useEffect(() => {
    if (!workspaceId) return
    fetch('/api/workspace/camera-presets').then((r) => r.json()).then((j) => {
      if (j.ok) setUserCameraPresets(j.presets || [])
    }).catch(() => {})
  }, [workspaceId])
  // Reload on realtime change so CRUD modal updates immediately.
  useEffect(() => {
    if (!workspaceId) return
    const ch = supabase.channel('cam-presets-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'camera_presets', filter: `workspace_id=eq.${workspaceId}` }, () => {
        fetch('/api/workspace/camera-presets').then((r) => r.json()).then((j) => {
          if (j.ok) setUserCameraPresets(j.presets || [])
        }).catch(() => {})
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // Pick style — does NOT touch model selection (user controls model independently)
  function pickStyle(styleKey) {
    setGlobalConfig((c) => ({ ...c, style: styleKey === c.style ? 'none' : styleKey }))
  }
  const [stateByPersona, setStateByPersona] = useState({})
  const [err, setErr] = useState('')
  // UI compactness — settings panels collapse by default to reduce visual noise.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showConfigDetails, setShowConfigDetails] = useState(false)
  const [showPersonaPicker, setShowPersonaPicker] = useState(true) // collapses after first selection
  // GOD MODE handoff — cinematic preset selected via ?preset=ID query param.
  // Held in state so the user can dismiss it, and the gen pipeline can read
  // it when building motion prompts.
  const [activePreset, setActivePreset] = useState(incomingPreset)

  function togglePersona(id) {
    setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
    setStateByPersona((st) => st[id] ? st : ({
      ...st,
      [id]: { naskah: '', refIds: new Set(), showWorkspaceRefs: false, parsed: null, busy: false, shots: [] },
    }))
  }
  function selectAll() {
    setSelectedIds((s) => s.size === personas.length ? new Set() : new Set(personas.map((p) => p.id)))
  }
  function patchPersona(id, patch) {
    setStateByPersona((st) => ({ ...st, [id]: { ...st[id], ...(typeof patch === 'function' ? patch(st[id]) : patch) } }))
  }

  const selectedPersonas = useMemo(() => personas.filter((p) => selectedIds.has(p.id)), [personas, selectedIds])

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Hero header — halo glow + gradient typography. Aim: less
          "AI-template" plain h1, more "landing page" focal energy. */}
      <div className="hero-halo text-center py-8 md:py-12">
        <div className="flex justify-center mb-4">
          {activeBrand && (
            <div className="brand-pill">
              🏷 BRAND AKTIF · {activeBrand.name}
            </div>
          )}
        </div>
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.05] mb-3">
          <span className="gradient-text-strong">Generate.</span>
          <br />
          <span className="text-[var(--text)]">Build your brand.</span>
        </h1>
        <p className="text-sm md:text-base text-[var(--muted)] max-w-xl mx-auto leading-relaxed">
          Pilih persona → naskah → Parse → <strong className="text-[var(--text)]">Images dulu</strong> → approve yang oke → <strong className="text-[var(--text)]">Videos</strong> dari approved.
          <br className="hidden md:inline" />
          <span className="text-[var(--muted2)]">Image murah, video mahal — filter di level image dulu.</span>
        </p>
      </div>

      {/* Cinematic preset banner — appears when user lands here via the
          "Use →" button in GOD MODE. Preset is auto-applied to every shot's
          video_motion when the user clicks Parse. Dismissable. */}
      {activePreset && (
        <div className="mb-4 p-3 rounded-lg bg-gradient-to-r from-[var(--accent)]/15 via-[var(--accent)]/5 to-transparent border border-[var(--accent)]/40 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-xl flex-shrink-0">🎥</span>
            <div className="min-w-0">
              <div className="text-xs font-bold text-[var(--accent)]">
                Cinematic preset aktif: {activePreset.label}
              </div>
              <div className="text-[10px] text-[var(--muted)] truncate">
                {activePreset.desc} — auto-inject ke video_motion saat klik Parse
              </div>
            </div>
          </div>
          <button
            onClick={() => setActivePreset(null)}
            className="text-[10px] text-[var(--muted)] hover:text-white flex-shrink-0 px-2 py-1 rounded hover:bg-[var(--surface2)]">
            ✕ Lepas preset
          </button>
        </div>
      )}

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 space-y-3">
        {/* Camera Preset — primary control. Always visible. */}
        <CameraPresetPicker
          workspaceId={workspaceId}
          value={globalConfig.cameraPreset}
          onChange={(id) => setGlobalConfig({ ...globalConfig, cameraPreset: id })}
          userPresets={userCameraPresets}
          onUserPresetsChanged={() => {
            fetch('/api/workspace/camera-presets').then((r) => r.json()).then((j) => {
              if (j.ok) setUserCameraPresets(j.presets || [])
            }).catch(() => {})
          }} />

        {/* Compact summary bar — shows current mode/AR/lang/models in 1 line.
            Click to expand the dropdowns when user wants to change. */}
        <div>
          <button onClick={() => setShowConfigDetails((s) => !s)} type="button"
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] hover:border-[var(--muted)] text-xs">
            <div className="flex items-center gap-2 flex-wrap text-left">
              <span className="text-[var(--muted)]">⚙</span>
              <span className="font-semibold">
                {globalConfig.mode === 'storyboard' ? '🗂 Storyboard' : '🎬 Per-Shot'} · {globalConfig.ar} · {globalConfig.lang}
              </span>
              <span className="text-[var(--muted2)]">·</span>
              <span className="text-[var(--muted)]">{globalConfig.imgModel.split('/').pop()?.replace(/-/g, ' ')}</span>
              <span className="text-[var(--muted2)]">→</span>
              <span className="text-[var(--muted)]">{globalConfig.vidModel.split('/').pop()?.replace(/-/g, ' ')}</span>
            </div>
            <span className="text-[var(--muted)] text-[10px]">{showConfigDetails ? '▲ tutup' : '▼ edit'}</span>
          </button>
          {showConfigDetails && (
            <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-3">
              <Sel label="Mode" value={globalConfig.mode} onChange={(v) => {
                // Auto-switch vidModel on mode change.
                //   storyboard  -> seedance 2 fast ref-to-video (9 image slots
                //                  = grid + up to 8 subject refs; the storyboard
                //                  pipeline needs this many)
                //   direct      -> grok ref-to-video (cheap, refs anchor visual)
                //   shots       -> grok image-to-video (animates approved still)
                // Skip override if user already picked an explicit model.
                const next = { ...globalConfig, mode: v }
                const curr = globalConfig.vidModel || ''
                if (v === 'storyboard' && !curr.includes('ref-to-video') && !curr.includes('reference-to-video')) {
                  next.vidModel = 'bytedance/seedance-2.0/fast/reference-to-video'
                } else if (v === 'direct' && !curr.includes('ref-to-video') && !curr.includes('reference-to-video')) {
                  next.vidModel = 'xai/grok-imagine-video/reference-to-video'
                } else if (v === 'shots' && (curr.includes('ref-to-video') || curr.includes('reference-to-video'))) {
                  next.vidModel = 'xai/grok-imagine-video/image-to-video'
                }
                setGlobalConfig(next)
              }}
                options={[
                  ['shots', '🎬 Per-Shot (image → video)'],
                  ['storyboard', '🗂 Storyboard 3×3 (~15s)'],
                  ['direct', '🎯 Direct Video (skip image, refs only)'],
                ]} />
              {(globalConfig.mode === 'shots' || globalConfig.mode === 'direct') && (
                <div>
                  <label className="block text-[9px] uppercase text-[var(--muted)] font-semibold mb-1">Shot Count</label>
                  <select value={globalConfig.shotCount ?? ''} onChange={(e) => setGlobalConfig({ ...globalConfig, shotCount: e.target.value ? parseInt(e.target.value) : null })}
                    className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">
                    <option value="">Auto (LLM decide)</option>
                    {[1,2,3,4,5,6,7,8,9,10,12,15,20].map((n) => <option key={n} value={n}>{n} shot{n>1?'s':''}</option>)}
                  </select>
                </div>
              )}
              <Sel label="Aspect Ratio" value={globalConfig.ar} onChange={(v) => setGlobalConfig({ ...globalConfig, ar: v })}
                options={[['9:16', '9:16 vertical'], ['16:9', '16:9 horizontal'], ['1:1', '1:1 square']]} />
              <Sel label="Bahasa Dialog" value={globalConfig.lang} onChange={(v) => setGlobalConfig({ ...globalConfig, lang: v })}
                options={[['Indonesian', 'Indonesian'], ['English', 'English'], ['Javanese', 'Javanese'], ['Sundanese', 'Sundanese'], ['Balinese', 'Balinese']]} />
              <Sel label="Image Model" value={globalConfig.imgModel} onChange={(v) => setGlobalConfig({ ...globalConfig, imgModel: v })}
                options={IMAGE_MODELS.map((m) => [m.v, m.l])} />
              <Sel label="Video Model" value={globalConfig.vidModel}
                onChange={(v) => {
                  // When user changes video model, the new model's max
                  // duration may be lower than what's stored on existing
                  // shots. Without this clamp, those shots would silently
                  // get truncated output (user typed 15, got 10). Walk all
                  // personas + their shots and trim where needed.
                  const newMax = getVideoMaxDuration(v)
                  setStateByPersona((prev) => {
                    const next = { ...prev }
                    for (const pid of Object.keys(next)) {
                      const shots = next[pid]?.shots
                      if (!Array.isArray(shots)) continue
                      next[pid] = {
                        ...next[pid],
                        shots: shots.map((s) => {
                          const d = parseInt(s.raw?.duration) || 5
                          if (d > newMax) return { ...s, raw: { ...s.raw, duration: newMax } }
                          return s
                        }),
                      }
                    }
                    return next
                  })
                  setGlobalConfig({ ...globalConfig, vidModel: v })
                }}
                options={VIDEO_MODELS.map((m) => [m.v, m.l])} />
            </div>
          )}
        </div>

        {/* Output Constraints — compact chip strip. 4 toggles in 1 row. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-[var(--muted)] uppercase font-semibold mr-1">Constraints:</span>
          <ChipToggle label="🎬 No cuts" on={!!globalConfig.continuousShot}
            onClick={() => setGlobalConfig({ ...globalConfig, continuousShot: !globalConfig.continuousShot })} />
          <ChipToggle label="🔇 No dialog" on={!!globalConfig.skipDialog}
            onClick={() => setGlobalConfig({ ...globalConfig, skipDialog: !globalConfig.skipDialog })} />
          <ChipToggle label="📝 No text" on={!!globalConfig.skipOnscreen}
            onClick={() => setGlobalConfig({ ...globalConfig, skipOnscreen: !globalConfig.skipOnscreen })} />
          <ChipToggle label="🚫 No product" on={!!globalConfig.skipProduct}
            onClick={() => setGlobalConfig({ ...globalConfig, skipProduct: !globalConfig.skipProduct })} />
          <button onClick={() => setShowAdvanced((s) => !s)} type="button"
            className="ml-auto text-[10px] text-[var(--muted)] hover:text-[var(--accent)] underline">
            {showAdvanced ? '▲ Hide advanced' : '▼ Advanced'}
          </button>
        </div>

        {/* Advanced section — collapsed by default. Style preset / style refs /
            wardrobe / continuous-shot hint live here. */}
        {showAdvanced && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            {/* Legacy Style preset — kept for back-compat, but Camera Preset
                supersedes. Hidden behind Advanced because most users won't need it. */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">
                  🎨 Style / Genre <span className="text-[9px] font-normal text-[var(--muted2)]">(legacy — Camera Preset di atas udah supersede ini)</span>
                </label>
                {globalConfig.style && globalConfig.style !== 'none' && (
                  <button onClick={() => setGlobalConfig({ ...globalConfig, style: 'none' })} className="text-[10px] text-[var(--muted)] underline hover:text-white">Clear</button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
                {Object.entries(STYLE_PRESETS).map(([key, preset]) => {
                  const on = globalConfig.style === key
                  return (
                    <button key={key} onClick={() => pickStyle(key)}
                      className={`text-left p-1.5 rounded border text-[10px] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--surface2)] hover:border-[var(--muted)]'}`}>
                      <div className="text-xs font-semibold">{preset.label}</div>
                      <div className="text-[9px] text-[var(--muted)] mt-0.5 line-clamp-1">{preset.description}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            <StyleRefsPicker workspaceId={workspaceId} userId={userId}
              selectedIds={globalConfig.styleRefIds || new Set()}
              onChange={(ids) => setGlobalConfig({ ...globalConfig, styleRefIds: ids })} />

{globalConfig.continuousShot && !globalConfig.vidModel.includes('reference-to-video') && !globalConfig.vidModel.includes('ref-to-video') && (
              <div className="p-2 rounded border border-yellow-500/40 bg-yellow-500/10 text-[10px] text-yellow-200/90 leading-relaxed">
                💡 <strong>Tips no-morph</strong>: continuous + image-to-video = morph. Switch ke <strong>🎭 Ref-to-Video model</strong> di Video Model — model itu ignore grid sebagai start frame.
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        {/* Compact bar when persona already selected — toggle to re-expand. */}
        {selectedIds.size > 0 && !showPersonaPicker ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <span className="text-[10px] text-[var(--muted)] uppercase font-semibold mr-1">Persona:</span>
            <div className="flex items-center gap-1.5 flex-1 flex-wrap">
              {selectedPersonas.slice(0, 4).map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-xs">
                  {p.avatar_url
                    ? <img src={p.avatar_url} alt="" className="w-4 h-4 rounded-full object-cover" />
                    : <span className="w-4 h-4 rounded-full bg-[var(--surface2)] flex items-center justify-center text-[9px] font-bold">{(p.name || '?').slice(0, 1).toUpperCase()}</span>}
                  <span className="font-semibold">{p.name}</span>
                </span>
              ))}
              {selectedPersonas.length > 4 && (
                <span className="text-[10px] text-[var(--muted)]">+{selectedPersonas.length - 4} more</span>
              )}
            </div>
            <button onClick={() => setShowPersonaPicker(true)} className="text-[10px] text-[var(--accent)] hover:underline whitespace-nowrap">
              ✎ Change
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)]">
                Pilih Persona ({selectedIds.size}/{personas.length})
              </h2>
              <div className="flex items-center gap-2">
                {personas.length > 0 && (
                  <button onClick={selectAll} className="text-[10px] text-[var(--muted)] underline hover:text-white">
                    {selectedIds.size === personas.length ? 'Unselect all' : 'Select all'}
                  </button>
                )}
                {selectedIds.size > 0 && (
                  <button onClick={() => setShowPersonaPicker(false)} className="text-[10px] text-[var(--accent)] hover:underline">
                    ✓ Done · Collapse
                  </button>
                )}
              </div>
            </div>
        {personas.length === 0 ? (
          <div className="text-xs text-[var(--muted)] p-4 border border-dashed border-[var(--border)] rounded">
            Belum ada persona. <a href="/personas" className="underline text-[var(--accent)]">Bikin persona dulu</a>.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {personas.map((p) => {
              const on = selectedIds.has(p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => togglePersona(p.id)}
                  data-selected={on ? 'true' : 'false'}
                  className="glow-card text-left p-3.5"
                >
                  <div className="flex items-center gap-2.5">
                    {p.avatar_url ? (
                      <span className="avatar-ring shrink-0">
                        <img src={p.avatar_url} alt="" className="w-9 h-9 object-cover" />
                      </span>
                    ) : (
                      <span className="avatar-ring shrink-0">
                        <div className="w-9 h-9 bg-[var(--surface2)] flex items-center justify-center text-sm font-bold">
                          {(p.name || '?').slice(0, 1).toUpperCase()}
                        </div>
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{p.name}</div>
                      <div className="text-[10px] text-[var(--muted)] truncate">@{p.username || '—'}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
          </>
        )}
      </section>

      {selectedPersonas.map((persona) => (
        <PersonaSection
          key={persona.id}
          persona={persona}
          workspaceRefs={workspaceRefs}
          // Lift newly-uploaded refs into workspaceRefs state so the
          // selectedRefs useMemo inside PersonaSection can resolve their id
          // through the personaOwnRefs+workspaceRefs lookup. Without this,
          // a freshly uploaded ref's id sat in state.refIds but the lookup
          // map didn't contain it -> selectedRefs filter returned undefined
          // for that id and the shot card showed "REFS: 1/1" instead of 2.
          onWorkspaceRefAdded={(newRef) => setWorkspaceRefs((prev) => {
            if (prev.some((r) => r.id === newRef.id)) return prev
            return [newRef, ...prev]
          })}
          state={stateByPersona[persona.id] || { naskah: '', refIds: new Set(), showWorkspaceRefs: false, parsed: null, busy: false, shots: [] }}
          onPatch={(patch) => patchPersona(persona.id, patch)}
          globalConfig={globalConfig}
          userCameraPresets={userCameraPresets}
          styleRefs={workspaceRefs.filter((r) => r.kind === 'style' && (globalConfig.styleRefIds || new Set()).has(r.id))}
          activeBrand={activeBrand}
          activePreset={activePreset}
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

// Coerce LLM response field to a primitive string. Gemini sometimes returns
// arrays / objects for fields the schema declared as string — calling .trim()
// on those throws "trim is not a function" which kills the gen flow. Arrays
// join with ", "; objects fall back to JSON; anything else gets String()'d.
function toStr(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join(', ')
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return '' } }
  return String(v)
}

// Translate raw fal.ai error blobs into a human-actionable message. fal
// surfaces partner failures as JSON-ish strings like
//   [{"ctx":{"extra_info":{"reason":"partner_validation_failed"}}}]
// which is useless to the user. We pattern-match the most common cases and
// hint a concrete next step (switch model, retry, etc).
function friendlyFalError(raw) {
  const s = String(raw || '')
  if (/partner_validation_failed/i.test(s)) {
    return 'Konten ditolak partner (kemungkinan content moderation OpenAI — sensitif sama anak/keluarga). Coba ganti Image Model ke Nano Banana 2 atau Seedream V4.'
  }
  if (/content[_\s]?policy|safety|moderation|nsfw|inappropriate/i.test(s)) {
    return 'Konten kena content moderation. Ganti model atau hapus elemen sensitif dari prompt.'
  }
  if (/rate[_\s]?limit|too many requests|429/i.test(s)) {
    return 'Rate limited. Tunggu beberapa detik lalu coba lagi.'
  }
  if (/unprocessable entity|422/i.test(s)) {
    return 'Model gak terima input (kemungkinan reject moderation). Coba ganti model atau ubah prompt.'
  }
  if (/timeout/i.test(s)) {
    // Match fal-client defaults — video 20min, image 15min. Hint user
    // to click Re-Img/Re-vid (refs+prompt cached locally so it's cheap)
    // before swapping models entirely.
    const isVideo = /vid|video/i.test(s)
    return isVideo
      ? 'Job timeout — fal.ai gak balas dalam 20 menit. Click Re-vid buat retry, atau pindah ke model lebih cepet (Kling v3 standard / Seedance Fast).'
      : 'Job timeout — fal.ai gak balas dalam 15 menit (kemungkinan webhook fal drop). Click Re-Img buat retry, atau swap ke model lain (nano-banana / grok-imagine).'
  }
  if (s.length > 120) return s.slice(0, 120) + '...'
  return s
}

function PersonaSection({ persona, workspaceRefs, onWorkspaceRefAdded, styleRefs = [], state, onPatch, globalConfig, userCameraPresets = [], activeBrand, activePreset = null, workspaceId, userId, onErr, supabase }) {
  const personaOwnRefs = (persona.persona_refs || []).map((pr) => pr.refs).filter(Boolean)

  // Default: only this persona's own refs are SELECTED. Workspace pool stays
  // hidden until user toggles "+ Show workspace refs".
  useEffect(() => {
    if (state.refIds.size === 0 && personaOwnRefs.length > 0) {
      onPatch({ refIds: new Set(personaOwnRefs.map((r) => r.id)) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona.id])

  function patchShot(idx, patch) {
    onPatch((s) => {
      const next = [...s.shots]
      next[idx] = { ...next[idx], ...(typeof patch === 'function' ? patch(next[idx]) : patch) }
      return { shots: next }
    })
  }
  // Switch active image variant. shot.image.url is the "current" mirror so
  // Send to QC + Gen Video read the picked one without rewriting their code.
  function pickImageVariant(idx, variantIdx) {
    patchShot(idx, (prev) => {
      const v = prev.image_variants?.[variantIdx]
      if (!v) return {}
      return { image: { ...prev.image, status: 'done', url: v.url }, image_active_idx: variantIdx }
    })
  }
  function pickVideoVariant(idx, variantIdx) {
    patchShot(idx, (prev) => {
      const v = prev.video_variants?.[variantIdx]
      if (!v) return {}
      return {
        video: { ...prev.video, status: 'done', url: v.url, result_id: v.result_id, cloned_audio_url: v.cloned_audio_url },
        video_active_idx: variantIdx,
      }
    })
  }
  function patchShotRaw(idx, key, value) {
    onPatch((s) => {
      const next = [...s.shots]
      next[idx] = { ...next[idx], raw: { ...next[idx].raw, [key]: value } }
      return { shots: next }
    })
  }
  function patchPanel(shotIdx, panelIdx, key, value) {
    onPatch((s) => {
      const next = [...s.shots]
      const shot = next[shotIdx]
      const panels = [...(shot.raw.panels || [])]
      panels[panelIdx] = { ...panels[panelIdx], [key]: value }
      next[shotIdx] = { ...shot, raw: { ...shot.raw, panels } }
      return { shots: next }
    })
  }

  const selectedRefs = useMemo(() => {
    const all = new Map()
    personaOwnRefs.forEach((r) => all.set(r.id, r))
    workspaceRefs.forEach((r) => all.set(r.id, r))
    return [...all.values()].filter((r) => state.refIds.has(r.id))
  }, [personaOwnRefs, workspaceRefs, state.refIds])

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
          // Honor output constraints — parser respects these instead of forcing
          // dialog/onscreen/product into every panel.
          constraints: {
            continuousShot: !!globalConfig.continuousShot,
            skipDialog: !!globalConfig.skipDialog,
            skipOnscreen: !!globalConfig.skipOnscreen,
            skipProduct: !!globalConfig.skipProduct,
          },
          shotCount: globalConfig.shotCount || null,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)

      // Storyboard mode = ONE shot containing all 9 panels (single grid image
      // + single 15s video). Per-shot mode = N separate shots.
      let shotsInit
      if (globalConfig.mode === 'storyboard') {
        const panels = data.parsed.panels || []
        shotsInit = [{
          id: `${persona.id}-storyboard-${Date.now()}`,
          raw: {
            concept: toStr(data.parsed.concept),
            // NEW: parser now extracts shared environment + wardrobe (auto-
            // detected from naskah) + sequence motion. Compiler picks parsed
            // wardrobe first, falls back to globalConfig.wardrobeOverride only
            // if parser didn't extract any.
            // toStr() coerces array/object responses from LLM into a string —
            // some Gemini responses return wardrobe as ["formal", "pastel"]
            // instead of "formal outfit, pastel" which broke .trim() downstream.
            environment: toStr(data.parsed.environment),
            wardrobe: toStr(data.parsed.wardrobe),
            video_motion: toStr(data.parsed.video_motion),
            panels: panels.map((p) => ({
              n: p.n, title: p.title || '', visual: p.visual || p.scene || '',
              dialog: p.dialog || '', onscreen: p.onscreen || p.purpose || '',
              seconds: p.seconds || 2, shot_type: p.shot_type || '',
              chars_in_shot: p.chars_in_shot || [],
            })),
            chars_in_shot: data.parsed.characters || [],
            duration: panels.reduce((sum, p) => sum + (parseInt(p.seconds) || 2), 0) || 15,
            shot_label: 'Storyboard 3×3',
          },
          label: `${persona.name} — Storyboard`,
          image: { status: 'idle' },
          video: { status: 'idle' },
          approved: false,
        }]
      } else {
        const items = data.parsed.shots || []
        const sharedEnv = toStr(data.parsed.environment)
        const sharedWardrobe = toStr(data.parsed.wardrobe)
        shotsInit = items.map((it, i) => ({
          id: `${persona.id}-${i}-${Date.now()}`,
          raw: {
            image_prompt: toStr(it.image_prompt),
            video_motion: toStr(it.video_motion),
            dialogue: toStr(it.dialogue),
            environment: sharedEnv,
            wardrobe: sharedWardrobe,
            chars_in_shot: it.chars_in_shot || [],
            duration: it.duration || 5,
            shot_label: `Shot ${it.shot}`,
          },
          label: `${persona.name} — Shot ${it.shot || i + 1}`,
          image: { status: 'idle' },
          video: { status: 'idle' },
          approved: false,
        }))
      }
      // Apply cinematic preset if one is active (from GOD MODE handoff via
      // ?preset=ID). Appends preset.prompt to each shot's video_motion so
      // the camera move / cinematic vibe is baked into the gen prompt.
      // Storyboard mode: append to the single video_motion sequence prompt.
      // Per-shot mode: append to every shot's individual video_motion.
      if (activePreset?.prompt) {
        const presetLine = `\n\n[Cinematic preset: ${activePreset.label}] ${activePreset.prompt}`
        shotsInit = shotsInit.map((s) => ({
          ...s,
          raw: {
            ...s.raw,
            video_motion: String(s.raw.video_motion || '').trim() + presetLine,
          },
        }))
      }
      onPatch({ parsed: data.parsed, shots: shotsInit })
    } catch (e) { onErr(`${persona.name}: ${e.message}`) }
    onPatch({ busy: false })
  }

  async function genImageForShot(idx) {
    const shot = state.shots[idx]
    if (!shot) return
    patchShot(idx, { image: { status: 'generating' } })
    try {
      const productKnowledge = selectedRefs.map((r) => String(r.knowledge || '').trim()).filter(Boolean).join('\n')
      const characterProductUrls = selectedRefs.map((r) => r.fal_url).filter(Boolean)
      // Style refs = ad-hoc mood board (global section) PLUS the camera
      // preset's own mood board (per-preset attachment). Dedupe so a user-
      // selected ref doesn't end up double-counted if it's also pinned to
      // the active preset.
      const adhocStyleUrls = styleRefs.map((r) => r.fal_url).filter(Boolean)
      const cam = getCameraPreset(globalConfig.cameraPreset || DEFAULT_CAMERA, userCameraPresets)
      const presetStyleUrls = Array.isArray(cam?.style_ref_urls) ? cam.style_ref_urls : []
      const styleUrls = Array.from(new Set([...adhocStyleUrls, ...presetStyleUrls]))
      // ORDER MATTERS: style refs go LAST so the compiler's L8b "the last N
      // images are style references" claim is literally true to the model.
      const refUrls = [...characterProductUrls, ...styleUrls]

      // Storyboard mode = grid layout description only. Per-shot mode = single action.
      const isGrid = !!shot.raw.panels
      const gridHeader = isGrid
        ? buildStoryboardGridPrompt(shot.raw.panels, globalConfig.ar, shot.raw.concept, {
            skipDialog: !!globalConfig.skipDialog,
            skipOnscreen: !!globalConfig.skipOnscreen,
            skipProduct: !!globalConfig.skipProduct,
          })
        : null
      const action = isGrid ? null : (shot.raw.image_prompt || shot.raw.shot_label)

      // Identity sentence — built from the persona record's character_prompt.
      // Used as L2 of the compiler (after camera tokens, before everything else).
      const identity = persona.character_prompt
        ? `${persona.name} (${persona.character_prompt.slice(0, 200)})`
        : null

      const brand = (!globalConfig.skipProduct)
        ? productNotesShort(productKnowledge || activeBrand?.notes)
        : null

      // Wardrobe = parser-extracted from naskah, period. Single source of
      // truth. If user wrote outfit in naskah, parser picks it up; if not,
      // reference photo handles outfit. No more dual-source confusion.
      // Safe coerce — parser sometimes returns array/object for wardrobe; .trim() on
      // those throws "trim is not a function". String() forces a primitive first.
      const wardrobe = String(shot.raw.wardrobe || '').trim() || null

      // IMAGE path — full 11-layer compile (camera, identity, wardrobe, env,
      // action, brand, AR, continuity, quality, negatives, L11 edit imperative).
      // refsCount = character/product refs only; styleRefsCount keeps the
      // style-ref count separate so L8b can tell the model "the last N images
      // are style references — match aesthetic, don't borrow characters".
      const fullPrompt = compileImagePrompt({
        camera: globalConfig.cameraPreset || DEFAULT_CAMERA,
        identity,
        wardrobe,
        environment: shot.raw.environment || null,
        action,
        brand,
        ar: globalConfig.ar,
        skipProduct: !!globalConfig.skipProduct,
        continuousShot: !!globalConfig.continuousShot,
        refsCount: characterProductUrls.length,
        styleRefsCount: styleUrls.length,
        gridHeader,
        userPresets: userCameraPresets,
      })

      const imgInput = buildImgInput(globalConfig.imgModel, { prompt: fullPrompt, refUrls, ar: globalConfig.ar })
      const imgResult = await falRun(globalConfig.imgModel, imgInput, { onProgress: (p) => patchShot(idx, { image: { status: p } }), workspaceId })
      const imageUrl = imgResult.images?.[0]?.url
      if (!imageUrl) throw new Error('no image URL returned')
      // Push to variants instead of overwriting — user wants to A/B-compare
      // multiple re-gens and pick the best one. shot.image.url stays as the
      // active mirror so downstream code (Send to QC, Gen Video) keeps working.
      patchShot(idx, (prev) => {
        const variants = [...(prev.image_variants || []), { url: imageUrl, at: Date.now() }]
        return {
          image: { status: 'done', url: imageUrl },
          image_variants: variants,
          image_active_idx: variants.length - 1,
          // Switch the media slot to image view so the user sees the new
          // re-gen. Without this, if a video was already generated from
          // an older image, the media slot kept showing that stale video
          // and the new image silently piled up in variants the user
          // never saw.
          mediaView: 'image',
        }
      })
    } catch (e) {
      patchShot(idx, { image: { status: 'error', error: friendlyFalError(e?.message || e) } })
    }
  }

  async function genVideoForShot(idx) {
    const shot = state.shots[idx]
    if (!shot) return
    // Validate motion field — empty/blank motion = model generates from text
    // prompt that's literally nothing or just the system role-id. User reported
    // a real $0.70 burn from the Continue button creating a shot with the
    // motion field still showing placeholder text (which the user mistook for
    // pre-filled content). Block gen with a clear message instead.
    const motionText = String(shot.raw.video_motion || '').trim()
    const isPlaceholder = !motionText
      || motionText.startsWith('Beat-by-beat')
      || motionText.startsWith('Dialog karakter di sini')
      || motionText.startsWith('[TULIS NASKAH')
      || motionText.length < 10
    if (isPlaceholder) {
      onErr(`${persona.name} ${shot.raw.shot_label || ''}: motion kosong / masih placeholder. Tulis naskah action di field "Video Motion" dulu (hapus hint "[TULIS NASKAH BAGIAN 2 DI SINI]" dan ganti dengan cerita lanjutan), atau klik "Parse with Gemini" supaya LLM auto-fill dari naskah.`)
      return
    }
    // Direct mode skips image gen entirely — refs are the visual anchor, motion
    // is the only text signal. Other modes require an approved image first.
    const isDirect = globalConfig.mode === 'direct'
    if (!isDirect && !shot.image?.url) return
    // Determine if this shot is a storyboard grid (panel layout) — important
    // because the 3x3 grid given to an image-to-video model causes the
    // "9 panels rocking around" glitch (model animates the grid frame, not
    // the implied sequence). Storyboard requires ref-to-video.
    const isGridShot = !!shot.raw.panels
    // Force ref-to-video at gen time if:
    //   - direct mode: refs are the only visual anchor, no source image
    //   - storyboard mode: grid must be treated as sequence map, not source
    // If user manually picked an i2v model in these modes, override silently
    // instead of letting fal.ai 422 us or producing glitched output.
    let vidModel = globalConfig.vidModel
    const isRefModel = vidModel.includes('ref-to-video') || vidModel.includes('reference-to-video')
    if (isDirect && !isRefModel) {
      vidModel = 'xai/grok-imagine-video/reference-to-video'
    } else if (isGridShot && !isRefModel) {
      vidModel = 'bytedance/seedance-2.0/fast/reference-to-video'
    }
    patchShot(idx, { video: { status: 'generating' } })
    try {
      // Per-shot ref override — user can deselect specific refs for THIS shot
      // via the chip picker in ShotEditor. `shot.disabledRefIds` is the array
      // of ref IDs explicitly excluded; empty = use all globally selected.
      const disabledSet = new Set(shot.disabledRefIds || [])
      const filteredSelected = selectedRefs.filter((r) => !disabledSet.has(r.id))
      const filteredStyle = styleRefs.filter((r) => !disabledSet.has(r.id))
      const characterProductUrls = filteredSelected.map((r) => r.fal_url).filter(Boolean)
      const styleUrls = filteredStyle.map((r) => r.fal_url).filter(Boolean)
      const refUrls = [...characterProductUrls, ...styleUrls]
      // Direct mode REQUIRES refs (there's no source image to fall back on).
      // Guard early with a clear error so user knows to upload refs first.
      if (isDirect && refUrls.length === 0) {
        throw new Error('Direct mode butuh minimal 1 reference image. Upload ref di persona dulu (atau enable di chip picker shot).')
      }

      // Visual Compiler for VIDEO prompt — same layered priority + sanitizer
      // as image gen. Replaces the regex-mutilated motion string (jsx:470)
      // and per-mode hardcoded fallbacks. Sanitizer drops 'multi-scene / 9
      // panels' language when continuousShot=true (declarative, no regex).
      const isGrid = isGridShot
      const dialogs = globalConfig.skipDialog
        ? ''
        : (isGrid
          ? shot.raw.panels.map((p) => p.dialog).filter(Boolean).join(' ')
          : (shot.raw.dialogue || ''))
      // ALWAYS use the user's video_motion from the parsed naskah. continuousShot
      // toggle = "single take, no cuts" — that's a CONSTRAINT we ADD to the
      // user's motion, NOT a replacement for it. Previously the toggle was
      // throwing away the user's video_motion entirely and substituting a
      // hardcoded string, which is why their naskah direction wasn't reaching
      // the video model.
      const userMotion = shot.raw.video_motion
        || (isGrid ? 'Smooth motion through the storyboard moments in order.' : 'Natural cinematic motion.')
      const defaultMotion = globalConfig.continuousShot
        ? `${userMotion} Single continuous take, no cuts.`
        : userMotion
      const action = dialogs
        ? `${defaultMotion} The subject speaks in fluent native ${globalConfig.lang}: "${dialogs}"`
        : defaultMotion
      const identity = persona.character_prompt
        ? `${persona.name} (${persona.character_prompt.slice(0, 200)})`
        : null
      const productKnowledge2 = selectedRefs.map((r) => String(r.knowledge || '').trim()).filter(Boolean).join('\n')
      const brand = (!globalConfig.skipProduct)
        ? productNotesShort(productKnowledge2 || activeBrand?.notes)
        : null

      // Safe coerce — parser sometimes returns array/object for wardrobe; .trim() on
      // those throws "trim is not a function". String() forces a primitive first.
      const wardrobe = String(shot.raw.wardrobe || '').trim() || null
      const motion = compileVideoPrompt({
        camera: globalConfig.cameraPreset || DEFAULT_CAMERA,
        identity,
        wardrobe,
        environment: shot.raw.environment || null,
        action,
        brand,
        ar: globalConfig.ar,
        skipProduct: !!globalConfig.skipProduct,
        continuousShot: !!globalConfig.continuousShot,
        refsCount: refUrls.length,
        userPresets: userCameraPresets,
      })
      // Storyboard + reference-to-video: prepend the approved 3x3 grid as the
      // FIRST reference. Direct mode: NO image at all — refs only. Other modes
      // (shots + image-to-video): image is the source, refs are character
      // anchors via reference_urls.
      const isRefVid = vidModel.includes('reference-to-video') || vidModel.includes('ref-to-video')
      // shot.additional_ref_urls — populated by "Continue Storyboard" button.
      // These are last-frame anchors from previous storyboard segments; they
      // ride along at the END of reference_image_urls so the model sees them
      // as recent context (most-recent ref = strongest continuity hint).
      const continuationRefs = Array.isArray(shot.additional_ref_urls) ? shot.additional_ref_urls : []
      const vidRefUrls = (isGrid && isRefVid && shot.image?.url)
        ? [shot.image.url, ...refUrls, ...continuationRefs].filter(Boolean)
        : [...refUrls, ...continuationRefs].filter(Boolean)
      // Role-identification prompt for storyboard ref-to-video. The model has
      // a strong default behavior of "animate the input image" — when handed
      // a 3x3 grid, it tends to animate the GRID composition itself (panels
      // visibly rocking around), which is the user-reported "glitch" mode.
      // This prompt redirects: the grid is a SEQUENCE MAP, not a frame.
      // Subjects from refs[2..] are what gets animated, panel by panel, in
      // a single seamless take with NO grid lines or panel borders visible.
      //
      // If continuationRefs are present (from a prior storyboard's last
      // frame), tell the model the LAST ref is the final frame of the
      // previous segment and the new sequence should start where it ended.
      let finalMotion = motion
      // Opsi A (narrow, opted-in by user): append a short identity-anchor
      // note for SHOTS / DIRECT + r2v. WITHOUT this note, r2v models
      // (Grok / Seedance / Kling / Happy Horse) default to "animate the
      // first ref as-is" — copying reference pose/location/expression
      // instead of using refs as identity inspiration. User-reported
      // "plek ketiplek sama referencenya" bug.
      //
      // Scope: ONLY shots/direct (non-storyboard) r2v with at least 1 ref.
      // Storyboard r2v has its own dedicated prompt below.
      // Storyboard i2v unchanged.
      // Refs can be character / product / object — note covers all.
      if (!isGrid && isRefVid && vidRefUrls.length > 0) {
        finalMotion = `${motion}

NOTE: Reference images are IDENTITY anchors only (character look, product/object appearance, art style — apapun yang muncul di refs). Render the SCENE and ACTION exactly as described in the brief above — do NOT replicate the reference pose, location, expression, or background. The brief is authoritative; refs only lock the visual identity of subjects shown in the brief.`
      }
      if (isGrid && isRefVid && shot.image?.url) {
        let cont = ''
        // Branch on continuity_fallback flag (set by continueStoryboard when
        // the last-frame extract failed and we fell back to the prev shot's
        // approved image). Misinforming the model that there's a "final frame"
        // when the ref is actually a storyboard grid hurts more than helps.
        const fallback = !!shot.continuity_fallback
        if (continuationRefs.length === 1 && fallback) {
          cont = `\n- The LAST reference image is the previous segment's storyboard grid (frame-level handoff unavailable). Match its art style and character look exactly. Treat this as a strong style anchor.`
        } else if (continuationRefs.length === 1) {
          cont = `\n- The LAST reference image is the final frame of the PREVIOUS segment. START the new sequence from a pose/setting/lighting that smoothly continues from it. The first second of output should look like a natural continuation of that frame.`
        } else if (continuationRefs.length >= 2) {
          cont = `\n- The SECOND-TO-LAST reference image is the previous segment's storyboard grid — match its art style and character look exactly. The LAST reference image is the final frame of the previous segment — START the new sequence from that pose/setting. The first second of output should look like a natural continuation of that frame.`
        }
        finalMotion = `IMAGE ROLES:
- Image 1 = a 3x3 storyboard GRID showing 9 sequential keyframes (panels) read left-to-right, top-to-bottom. It is a SEQUENCE MAP, NOT a frame to animate.
- Images 2 onwards = subject/character/style references to render.${cont}

INSTRUCTIONS:
- Animate the SUBJECTS (not the grid) performing the actions shown in each panel of Image 1, panel-by-panel, smoothly transitioning scene-to-scene as one continuous take.
- ABSOLUTELY DO NOT show grid lines, panel borders, panel numbers, or 3x3 layout in the output video. The output is a normal full-frame video of the subjects.
- Maintain the SAME character identity, outfit, and art style from the reference images across the entire video. No mid-video morphing.

MOTION DETAILS:
${motion}`
      }
      const vidInput = buildVidInput(vidModel, {
        prompt: finalMotion,
        image_url: isDirect ? undefined : shot.image?.url,
        reference_urls: vidRefUrls,
        duration: shot.raw.duration || 5,
        aspect_ratio: globalConfig.ar,
      })
      const vidResult = await falRun(vidModel, vidInput, { onProgress: (p) => patchShot(idx, { video: { status: p } }), workspaceId, duration: shot.raw.duration || 5 })
      const videoUrl = vidResult.video?.url || vidResult.video
      if (!videoUrl) throw new Error('no video URL returned')

      const { data: row, error } = await supabase.from('results').insert({
        workspace_id: workspaceId, persona_id: persona.id, type: 'video', url: videoUrl, label: shot.label, ar: globalConfig.ar,
        group_label: persona.name,
        meta: { image_url: shot.image?.url || null, raw: shot.raw, source: 'generate', direct: isDirect || undefined },
        created_by: userId,
      }).select('id').single()
      if (error) throw error
      // Push to variants — every re-gen appends, user can switch between them
      // via the picker UI. video.url stays mirror of the active variant.
      patchShot(idx, (prev) => {
        const variants = [...(prev.video_variants || []), { url: videoUrl, result_id: row.id, at: Date.now() }]
        return {
          video: { status: 'done', url: videoUrl, result_id: row.id },
          video_variants: variants,
          video_active_idx: variants.length - 1,
          // Switch the media slot to video view so the user sees the new
          // gen. Pairs with the mediaView='image' set in genImageForShot.
          mediaView: 'video',
        }
      })

      // Voice clone post-gen — if persona has a cloned voice, swap the AI native audio
      // for the persona's voice via ElevenLabs Speech-to-Speech. Lip-sync preserved
      // because S2S converts the same audio (same phonemes/timing, new timbre).
      // Best-effort; failures don't break the video gen.
      if (persona.voice_id) {
        patchShot(idx, { video: { status: '🎙 voice clone...', url: videoUrl, result_id: row.id } })
        try {
          const r = await fetch('/api/voice/convert', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_url: videoUrl, voice_id: persona.voice_id, result_id: row.id }),
          })
          const j = await r.json()
          if (j.ok) {
            patchShot(idx, (prev) => {
              const variants = [...(prev.video_variants || [])]
              const lastIdx = variants.length - 1
              if (lastIdx >= 0) variants[lastIdx] = { ...variants[lastIdx], cloned_audio_url: j.audio_url }
              return {
                video: { status: 'done', url: videoUrl, result_id: row.id, cloned_audio_url: j.audio_url },
                video_variants: variants,
              }
            })
          } else {
            console.warn('voice convert skipped:', j.error)
            patchShot(idx, { video: { status: 'done', url: videoUrl, result_id: row.id } })
          }
        } catch (e) {
          console.warn('voice convert error:', e)
          patchShot(idx, { video: { status: 'done', url: videoUrl, result_id: row.id } })
        }
      }
    } catch (e) {
      patchShot(idx, { video: { status: 'error', error: friendlyFalError(e?.message || e) } })
    }
  }

  async function genAllImages() {
    if (!state.shots.length) { onErr(`${persona.name}: parse dulu`); return }
    const pending = state.shots.filter((s) => !s.image?.url).length
    const estCost = pending * imageCost(globalConfig.imgModel)
    // Confirmation modal kalau cost > $0.20 (kecil banget threshold biar
    // user aware setiap kali). Skip for trivial cost.
    if (estCost > 0.20 && !confirm(
      `Generate ${pending} image dengan ${globalConfig.imgModel.split('/').pop()}?\n\n` +
      `Estimated cost: ${fmtCost(estCost)}\n` +
      `Tap OK = jalanin, Cancel = batal.`
    )) return
    onPatch({ busy: true }); onErr('')
    for (let i = 0; i < state.shots.length; i++) {
      if (state.shots[i].image?.url) continue
      await genImageForShot(i)
    }
    onPatch({ busy: false })
  }

  // Continue from previous video — chains a new shot by extracting the last
  // frame of the source video and pre-loading it as an additional reference.
  // Works for BOTH storyboard mode (creates new empty 9-panel shot) and
  // direct mode (creates new direct shot with just motion field). Detects
  // source mode by presence of shot.raw.panels.
  async function continueStoryboard(idx) {
    const prev = state.shots[idx]
    if (!prev?.video?.url) { onErr('Continue: video belum jadi'); return }
    const isPrevStoryboard = !!prev.raw.panels
    // Mark the shot as in-progress so the button can disable itself + show
    // the current stage. First-click can stall ~10s while ffmpeg.wasm loads;
    // without visible feedback the user assumes the button is broken.
    patchShot(idx, { continuing: 'Loading ffmpeg...' })
    onPatch({ busy: true }); onErr('')
    try {
      console.log('[Continue] loading ffmpeg-extract module...')
      const { extractLastFrame } = await import('@/lib/ffmpeg-extract')
      const { uploadBlob } = await import('@/lib/upload-client')
      patchShot(idx, { continuing: 'Extracting last frame...' })
      console.log('[Continue] extracting last frame from', prev.video.url)
      // 100% duration — exact-last-frame requested. ffmpeg's -sseof needs a
      // small negative offset (0 = end-of-stream marker), so 0.05s is the
      // safe approximation that still hits the visually-final frame.
      // extractLastFrame internally falls back from -sseof to -update 1 if
      // the MP4 lacks faststart / has seek index issues.
      let frameUrl = null
      let extractFailed = false
      let noAnchor = false
      try {
        const blob = await extractLastFrame(prev.video.url, { offsetEnd: 0.05 })
        patchShot(idx, { continuing: `Uploading ${(blob.size / 1024).toFixed(0)}KB to R2...` })
        console.log('[Continue] frame extracted', blob.size, 'bytes — uploading')
        const up = await uploadBlob(blob, `lastframe-${prev.id}.jpg`, 'continuation')
        frameUrl = up.url
        console.log('[Continue] uploaded', frameUrl)
      } catch (extractErr) {
        // Frame extract failed entirely (all 3 ffmpeg strategies). Two paths:
        // - Storyboard source: fall back to prev.image.url (the grid) as
        //   anchor. Lose pose handoff but keep style + character continuity.
        // - Direct source: no image to fall back to. Continue WITHOUT anchor
        //   — persona refs in selectedRefs/styleRefs still lock character +
        //   style. Worst case = "shot in same world" continuity, no
        //   frame-level handoff. Better than blocking the feature entirely.
        console.warn('[Continue] frame extract failed:', extractErr.message)
        if (prev.image?.url) {
          frameUrl = prev.image.url
          extractFailed = true
          patchShot(idx, { continuing: 'Gak bisa ambil frame terakhir — pake gambar storyboard sebagai anchor...' })
          onErr(`✓ Shot baru dibikin di bawah. ⚠ Tapi frame terakhir video A gak bisa di-extract (codec MP4 fal.ai gak compatible). Gua pake gambar storyboard approved sebagai anchor — karakter + style tetep konsisten.`)
        } else {
          // Direct mode — no prev image. Continue without any anchor.
          noAnchor = true
          patchShot(idx, { continuing: 'Gak bisa ambil frame terakhir — continue tanpa anchor...' })
          onErr(`✓ Shot baru dibikin di bawah. ⚠ Tapi frame terakhir video A gak bisa di-extract (codec MP4 fal.ai gak compatible). Karakter + style tetep locked dari persona refs, cuma seam-nya mungkin keliatan dikit (no exact frame handoff). Lanjut isi naskah part 2 di shot baru.`)
        }
      }
      // Build the continuation shot. Storyboard source -> empty 9-panel
      // shot (user fills via Parse). Direct source -> direct shot with
      // motion-only schema. Either way, additional_ref_urls carries the
      // last frame as a continuity anchor.
      const baseRaw = {
        environment: prev.raw.environment || '',
        wardrobe: prev.raw.wardrobe || '',
        chars_in_shot: prev.raw.chars_in_shot || [],
        shot_label: 'Continuation',
      }
      // Pre-fill motion field with a starter hint so the user knows they must
      // edit it before gen. Previous version left it empty (textarea showed
      // placeholder text from JSX, which users mistook for content). The
      // empty-motion gate in genVideoForShot now blocks this anyway, but a
      // visible hint helps users know what to do next.
      const motionHint = isPrevStoryboard
        ? '[TULIS NASKAH BAGIAN 2 DI SINI] Lanjutan dari storyboard sebelumnya — describe what happens next, beat-by-beat. Refs lock character/style; motion drives the new action sequence.'
        : '[TULIS NASKAH BAGIAN 2 DI SINI] Lanjutan dari shot sebelumnya — describe what happens next, beat-by-beat. The last frame is included as a reference so the model can visually continue from where the previous video ended.'
      // Build continuity refs. Three scenarios:
      //
      // 1. Frame extract SUCCEEDED (frameUrl = real extracted last frame):
      //    For storyboard source, include BOTH the previous grid (style +
      //    character look) AND the last frame (exact pose/setting). Two
      //    distinct anchors = stronger continuity.
      //
      // 2. Frame extract FAILED with fallback (frameUrl = prev.image.url):
      //    Only include prev.image.url once. Role-id prompt below branches
      //    on extractFailed so it doesn't misinform the model.
      //
      // 3. Frame extract FAILED no fallback (noAnchor, direct mode):
      //    No additional refs at all. Persona refs in selectedRefs still
      //    drive character + style. Continuation is "shot in same world"
      //    rather than "continued from this frame".
      const continuityRefs = noAnchor
        ? []                                          // direct + extract failed: no anchor
        : extractFailed
          ? [frameUrl]                                // storyboard + extract failed: grid only
          : (isPrevStoryboard && prev.image?.url && prev.image.url !== frameUrl)
            ? [prev.image.url, frameUrl]              // success storyboard: grid + last frame
            : [frameUrl]                              // success direct: last frame
      const newShot = {
        id: `${persona.id}-cont-${Date.now()}`,
        raw: isPrevStoryboard
          ? {
              ...baseRaw,
              panels: [],
              concept: '',
              video_motion: motionHint,
              duration: 10,
            }
          : {
              ...baseRaw,
              video_motion: motionHint,
              dialogue: '',
              duration: prev.raw.duration || 5,
            },
        label: `${prev.label} — Continuation`,
        image: { status: 'idle' },
        video: { status: 'idle' },
        approved: false,
        additional_ref_urls: continuityRefs,
        // Flag: did extract-last-frame succeed, or did we fall back to prev
        // image as anchor? genVideoForShot uses this to phrase the role-id
        // prompt correctly (saying "last frame" when there is no last frame
        // would misinform the model).
        continuity_fallback: extractFailed,
        continued_from: prev.id,
      }
      onPatch({ shots: [...state.shots, newShot] })
      patchShot(idx, { continuing: null })
      console.log('[Continue] new shot appended:', newShot.id)
    } catch (e) {
      console.error('[Continue] failed:', e)
      onErr(`Continue: ${e.message || e}`)
      patchShot(idx, { continuing: null })
    }
    onPatch({ busy: false })
  }

  // linkFrameToNextShot — DIFFERS from continueStoryboard:
  //   continueStoryboard creates a NEW shot with extracted last frame.
  //   linkFrameToNextShot MERGES the last frame into the EXISTING next
  //   shot's additional_ref_urls. Use case: user parsed naskah into N
  //   sequential shots already; gen Shot 1; then "link" its last frame
  //   into Shot 2's refs BEFORE genning Shot 2 → visual handoff without
  //   destroying the LLM-parsed motion text in Shot 2.
  async function linkFrameToNextShot(idx) {
    const prev = state.shots[idx]
    const next = state.shots[idx + 1]
    if (!prev?.video?.url) { onErr('Link: video Shot ini belum jadi'); return }
    if (!next) { onErr('Link: gak ada shot berikutnya di list'); return }
    patchShot(idx, { continuing: 'Loading ffmpeg...' })
    onPatch({ busy: true }); onErr('')

    // Same 4-tier extract chain as Continue (canvas -> sseof -> update ->
    // seq-dump). Plus fallback paths if all 4 fail:
    //   - Storyboard source: use prev.image.url (grid) as anchor
    //   - Direct source: skip anchor, just log a warning (Shot N+1 will
    //     still gen with its base refs — character + style still locked)
    let frameUrl = null
    let extractFailed = false
    try {
      const { extractLastFrame } = await import('@/lib/ffmpeg-extract')
      const { uploadBlob } = await import('@/lib/upload-client')
      patchShot(idx, { continuing: 'Extracting last frame (canvas/ffmpeg fallback)...' })
      console.log('[Link] extracting from', prev.video.url)
      const blob = await extractLastFrame(prev.video.url, { offsetEnd: 0.05 })
      patchShot(idx, { continuing: `Uploading ${(blob.size / 1024).toFixed(0)}KB to R2...` })
      const up = await uploadBlob(blob, `link-${prev.id}-to-${next.id}.jpg`, 'continuation')
      frameUrl = up.url
      console.log('[Link] uploaded', frameUrl)
    } catch (extractErr) {
      console.warn('[Link] extract failed (all 4 strategies):', extractErr.message)
      if (prev.image?.url) {
        // Storyboard source — fall back to the grid image as anchor.
        frameUrl = prev.image.url
        extractFailed = true
        patchShot(idx, { continuing: 'Frame extract failed — using prev image...' })
      } else {
        // Direct source + extract failed = no anchor available. Don't
        // throw — just tell the user the link couldn't be made but Shot
        // N+1 will still gen with its base refs.
        patchShot(idx, { continuing: null })
        onErr(`Link gagal: ${extractErr.message?.slice(0, 80)}. Shot ${idx + 2} tetep bisa di-gen tapi tanpa visual handoff dari Shot ${idx + 1}. Karakter + style tetep locked dari persona refs.`)
        onPatch({ busy: false })
        return
      }
    }

    // Merge into next shot's additional_ref_urls. Dedupe so repeated
    // clicks don't pile up the same URL.
    const nextIdx = idx + 1
    patchShot(nextIdx, (prevNextState) => {
      const existing = prevNextState.additional_ref_urls || []
      if (existing.includes(frameUrl)) return prevNextState
      return {
        additional_ref_urls: [...existing, frameUrl],
        linked_from_shot: prev.label || `Shot ${idx + 1}`,
        // Phrases the genVideoForShot role-id prompt correctly:
        // true  -> "this is the prev storyboard grid (style anchor)"
        // false -> "this is the final frame (start from this pose)"
        continuity_fallback: extractFailed,
      }
    })
    patchShot(idx, { continuing: null })
    onErr(`✓ Last frame Shot ${idx + 1} linked ke Shot ${idx + 2}. Sekarang klik "Gen Video Direct" di Shot ${idx + 2} untuk dapet visual handoff.${extractFailed ? ' (Pakai gambar fallback — pose handoff lemah, tapi character + style tetep locked.)' : ''}`)
    onPatch({ busy: false })
  }

  async function genVideosFromApproved() {
    const approvedIdx = state.shots
      .map((s, i) => (s.approved && s.image?.url && s.video?.status !== 'done' ? i : -1))
      .filter((i) => i >= 0)
    if (!approvedIdx.length) { onErr(`${persona.name}: gak ada shot ter-approve yang udah ada image`); return }
    const estCost = approvedIdx.reduce((sum, i) => sum + videoCost(globalConfig.vidModel, state.shots[i].raw.duration || 5), 0)
    // Always confirm video gen — it's the expensive one
    if (!confirm(
      `Generate ${approvedIdx.length} video dengan ${globalConfig.vidModel.split('/').pop()}?\n\n` +
      `Estimated cost: ${fmtCost(estCost)}\n` +
      `Total duration: ${approvedIdx.reduce((s, i) => s + (state.shots[i].raw.duration || 5), 0)} detik\n\n` +
      `⚠ Video generation mahal & lama. Pastikan shot udah final.\n` +
      `Tap OK = jalanin, Cancel = batal.`
    )) return
    onPatch({ busy: true }); onErr('')
    for (const i of approvedIdx) await genVideoForShot(i)
    onPatch({ busy: false })
  }

  // Send the BEST currently-available output (video > image) to QC.
  // If video exists -> just flip qc_status='pending' on its results row.
  // If only image exists -> INSERT a new image result row dengan qc_status=pending.
  async function sendToQC(idx) {
    const shot = state.shots[idx]
    if (!shot) return
    onErr('')

    // Prefer video if available
    if (shot.video?.result_id) {
      const { error } = await supabase.from('results').update({ qc_status: 'pending' }).eq('id', shot.video.result_id)
      if (error) { onErr(error.message); return }
      patchShot(idx, { qc_sent: 'video' })
      return
    }

    // Fallback: send image-only result
    if (shot.image?.url) {
      const { data: row, error } = await supabase.from('results').insert({
        workspace_id: workspaceId, persona_id: persona.id, type: 'image',
        url: shot.image.url, label: shot.label, ar: globalConfig.ar,
        group_label: persona.name, qc_status: 'pending',
        meta: { source: 'generate-image-only', raw: shot.raw },
        created_by: userId,
      }).select('id').single()
      if (error) { onErr(error.message); return }
      patchShot(idx, { image: { ...shot.image, result_id: row.id }, qc_sent: 'image' })
      return
    }

    onErr(`${persona.name}: belum ada image atau video buat dikirim ke QC`)
  }
  async function renameResult(resultId, label) {
    if (!resultId) return
    const { error } = await supabase.from('results').update({ label }).eq('id', resultId)
    if (error) onErr(error.message)
  }
  async function deleteResult(idx, resultId) {
    if (!confirm('Hapus video result ini?')) return
    if (resultId) {
      const { error } = await supabase.from('results').delete().eq('id', resultId)
      if (error) { onErr(error.message); return }
    }
    patchShot(idx, { video: { status: 'idle' } })
  }

  const approvedCount = state.shots.filter((s) => s.approved && s.image?.url && s.video?.status !== 'done').length
  const imageDoneCount = state.shots.filter((s) => s.image?.status === 'done').length

  return (
    <section className="bg-[var(--surface)] border-2 border-[var(--accent)]/30 rounded-lg p-4">
      <header className="flex items-center gap-3 mb-4">
        {persona.avatar_url
          ? <img src={persona.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover" />
          : <div className="w-10 h-10 rounded-full bg-[var(--surface2)] flex items-center justify-center text-base font-bold">{(persona.name || '?').slice(0, 1).toUpperCase()}</div>}
        <div className="flex-1">
          <div className="text-lg font-bold">{persona.name}</div>
          <div className="text-xs text-[var(--muted)]">@{persona.username || '—'} · {personaOwnRefs.length} ref{personaOwnRefs.length !== 1 ? 's' : ''}</div>
        </div>
      </header>

      <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">Naskah</label>
          <textarea rows={4} value={state.naskah} onChange={(e) => onPatch({ naskah: e.target.value })}
            placeholder={`Tempel naskah buat ${persona.name}...`}
            className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
        </div>

        <RefsPicker
          personaOwnRefs={personaOwnRefs}
          workspaceRefs={workspaceRefs}
          showWorkspace={state.showWorkspaceRefs}
          onToggleShowWorkspace={() => onPatch({ showWorkspaceRefs: !state.showWorkspaceRefs })}
          selectedIds={state.refIds}
          onToggle={(id) => {
            const next = new Set(state.refIds)
            next.has(id) ? next.delete(id) : next.add(id)
            onPatch({ refIds: next })
          }}
          workspaceId={workspaceId}
          userId={userId}
          personaId={persona.id}
          supabase={supabase}
          onErr={onErr}
          onAdded={(newRef) => {
            // 1. Lift the new ref into the parent's workspaceRefs state so
            //    the selectedRefs lookup (personaOwnRefs+workspaceRefs by id)
            //    can resolve it. Without this, the id sits in state.refIds
            //    but the lookup returns undefined -> shot picker shows fewer
            //    refs than the user selected at persona level.
            // 2. Mark the new ref as selected for this persona.
            if (onWorkspaceRefAdded) onWorkspaceRefAdded(newRef)
            const next = new Set(state.refIds); next.add(newRef.id)
            onPatch({ refIds: next })
          }}
        />

        <div className="flex flex-wrap gap-2">
          <button onClick={parseNaskah} disabled={state.busy || !state.naskah.trim()}
            className="px-4 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold hover:bg-[var(--border)] disabled:opacity-50">
            🤖 Parse with Gemini
          </button>
          {state.shots.length > 0 && globalConfig.mode !== 'direct' && (() => {
            const imgPending = state.shots.filter((s) => !s.image?.url).length
            const estImg = imgPending * imageCost(globalConfig.imgModel)
            return (
              <button onClick={genAllImages} disabled={state.busy}
                className="px-4 py-2 rounded bg-blue-500 text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                🖼 Generate Images ({imgPending || state.shots.length})
                <span className="ml-1.5 text-[10px] opacity-80">≈ {fmtCost(estImg)}</span>
              </button>
            )
          })()}
          {/* Direct mode: jump straight to batch video — no image gate. */}
          {state.shots.length > 0 && globalConfig.mode === 'direct' && (() => {
            const vidPending = state.shots.filter((s) => !s.video?.url).length
            const estVid = state.shots.reduce((sum, s) => (s.video?.url ? sum : sum + videoCost(globalConfig.vidModel, s.raw.duration || 5)), 0)
            return (
              <button onClick={async () => {
                if (estVid > 0.50 && !confirm(
                  `Generate ${vidPending} video direct dengan ${globalConfig.vidModel.split('/').pop()}?\n\n` +
                  `Estimated cost: ${fmtCost(estVid)}\n` +
                  `Tap OK = jalanin, Cancel = batal.`
                )) return
                onPatch({ busy: true }); onErr('')
                for (let i = 0; i < state.shots.length; i++) {
                  if (state.shots[i].video?.url) continue
                  // eslint-disable-next-line no-await-in-loop
                  await genVideoForShot(i)
                }
                onPatch({ busy: false })
              }} disabled={state.busy || vidPending === 0}
                className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                🎯 Generate Videos Direct ({vidPending})
                {vidPending > 0 && <span className="ml-1.5 text-[10px] opacity-80">≈ {fmtCost(estVid)}</span>}
              </button>
            )
          })()}
          {imageDoneCount > 0 && globalConfig.mode !== 'direct' && (() => {
            const approvedShots = state.shots.filter((s) => s.approved && s.image?.url && s.video?.status !== 'done')
            const estVid = approvedShots.reduce((sum, s) => sum + videoCost(globalConfig.vidModel, s.raw.duration || 5), 0)
            return (
              <button onClick={genVideosFromApproved} disabled={state.busy || !approvedCount}
                className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                🎬 Generate Videos ({approvedCount} approved)
                {approvedCount > 0 && <span className="ml-1.5 text-[10px] opacity-80">≈ {fmtCost(estVid)}</span>}
              </button>
            )
          })()}
        </div>

        {state.shots.length > 0 && (
          <div className="pt-3 border-t border-[var(--border)] space-y-3">
            <div className="text-[10px] uppercase font-semibold text-[var(--muted)]">
              📝 {globalConfig.mode === 'storyboard' ? 'Storyboard — edit 9 panel, gen grid, approve, gen video'
                : globalConfig.mode === 'direct' ? '🎯 Direct — edit motion + dialog, refs sebagai visual anchor, langsung gen video'
                : 'Shots — edit text, gen image, approve, gen video'}
            </div>
            {state.shots.map((shot, i) => (
              shot.raw.panels
                ? <StoryboardEditor key={shot.id} shot={shot} idx={i} ar={globalConfig.ar}
                    availableRefs={[...selectedRefs, ...styleRefs]}
                    onToggleRef={(refId) => patchShot(i, (prev) => {
                      const cur = new Set(prev.disabledRefIds || [])
                      if (cur.has(refId)) cur.delete(refId); else cur.add(refId)
                      return { disabledRefIds: Array.from(cur) }
                    })}
                    onResetRefs={() => patchShot(i, { disabledRefIds: [] })}
                    onChangeRaw={(key, value) => patchShotRaw(i, key, value)}
                    onSetMediaView={(v) => patchShot(i, { mediaView: v })}
                    onChangePanel={(pi, key, value) => patchPanel(i, pi, key, value)}
                    onGenImage={() => genImageForShot(i)}
                    onGenVideo={() => genVideoForShot(i)}
                    onPickImage={(vi) => pickImageVariant(i, vi)}
                    onPickVideo={(vi) => pickVideoVariant(i, vi)}
                    onApprove={(v) => patchShot(i, { approved: v })}
                    onRename={(label) => { patchShot(i, { label }); renameResult(shot.video?.result_id, label) }}
                    onSendQC={() => sendToQC(i)}
                    onContinue={() => continueStoryboard(i)}
                    onLinkNext={i + 1 < state.shots.length ? () => linkFrameToNextShot(i) : null}
                    onDelete={() => deleteResult(i, shot.video?.result_id)} />
                : <ShotEditor key={shot.id} shot={shot} idx={i}
                    mode={globalConfig.mode}
                    maxDuration={getVideoMaxDuration(globalConfig.vidModel)}
                    vidModelLabel={(VIDEO_MODELS.find((m) => m.v === globalConfig.vidModel)?.l || globalConfig.vidModel).split('—')[0].trim()}
                    availableRefs={[...selectedRefs, ...styleRefs]}
                    onToggleRef={(refId) => patchShot(i, (prev) => {
                      const cur = new Set(prev.disabledRefIds || [])
                      if (cur.has(refId)) cur.delete(refId); else cur.add(refId)
                      return { disabledRefIds: Array.from(cur) }
                    })}
                    onResetRefs={() => patchShot(i, { disabledRefIds: [] })}
                    onChangeRaw={(key, value) => patchShotRaw(i, key, value)}
                    onSetMediaView={(v) => patchShot(i, { mediaView: v })}
                    onGenImage={() => genImageForShot(i)}
                    onGenVideo={() => genVideoForShot(i)}
                    onPickImage={(vi) => pickImageVariant(i, vi)}
                    onPickVideo={(vi) => pickVideoVariant(i, vi)}
                    onApprove={(v) => patchShot(i, { approved: v })}
                    onRename={(label) => { patchShot(i, { label }); renameResult(shot.video?.result_id, label) }}
                    onSendQC={() => sendToQC(i)}
                    onContinue={() => continueStoryboard(i)}
                    onLinkNext={i + 1 < state.shots.length ? () => linkFrameToNextShot(i) : null}
                    onDelete={() => deleteResult(i, shot.video?.result_id)} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ShotEditor({ shot, idx, mode = 'shots', maxDuration = 15, vidModelLabel = '', availableRefs = [], onToggleRef, onResetRefs, onChangeRaw, onSetMediaView, onGenImage, onGenVideo, onPickImage, onPickVideo, onApprove, onRename, onSendQC, onContinue, onLinkNext, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(shot.label || '')
  const imgStatus = shot.image?.status || 'idle'
  const vidStatus = shot.video?.status || 'idle'
  const isDirect = mode === 'direct'
  const disabledIds = shot.disabledRefIds || []
  const activeRefCount = availableRefs.length - disabledIds.length

  return (
    <div className={`bg-[var(--surface2)] border rounded p-3 ${shot.approved ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
      <div className="flex items-start gap-3">
        {/* Image preview (left) */}
        <div className="w-32 flex-shrink-0">
          <div className="aspect-[9/16] bg-black rounded overflow-hidden border border-[var(--border)] relative">
            {(() => {
              const showVideo = shot.mediaView ? shot.mediaView === 'video' : !!shot.video?.url
              if (showVideo && shot.video?.url) return <LazyVideo src={shot.video.url} controls muted loop playsInline className="w-full h-full object-cover" />
              if (shot.image?.url) return <img src={shot.image.url} alt="" loading="lazy" className="w-full h-full object-cover" />
              return (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-[var(--muted)] text-center p-2">
                  {isDirect
                    ? (vidStatus === 'idle' ? '🎯 no video yet — click Gen Video Direct' : vidStatus)
                    : (imgStatus === 'idle' ? 'no image yet' : imgStatus)}
                </div>
              )
            })()}
            {shot.image?.url && shot.video?.url && onSetMediaView && (
              <button
                onClick={() => onSetMediaView((shot.mediaView === 'image') ? 'video' : 'image')}
                className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded bg-black/70 text-white border border-white/20 hover:bg-black/90"
                title="Toggle image / video view">
                {(shot.mediaView === 'image' ? '🎬' : '🖼')}
              </button>
            )}
            {imgStatus !== 'idle' && imgStatus !== 'done' && imgStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[9px] bg-black/80 text-white px-1.5 py-0.5 rounded truncate">⏳ {imgStatus}</div>
            )}
            {vidStatus !== 'idle' && vidStatus !== 'done' && vidStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[9px] bg-orange-600 text-white px-1.5 py-0.5 rounded truncate">🎬 {vidStatus}</div>
            )}
            {imgStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[9px] bg-red-700 text-white px-1.5 py-1 rounded leading-tight max-h-[60%] overflow-y-auto" title={shot.image.error}>⚠ {shot.image.error}</div>
            )}
            {vidStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[9px] bg-red-700 text-white px-1.5 py-1 rounded leading-tight max-h-[60%] overflow-y-auto" title={shot.video.error}>⚠ {shot.video.error}</div>
            )}
          </div>

          {/* Variants strip — video preferred over image when both exist. */}
          <MediaGallery shot={shot} onPickImage={onPickImage} onPickVideo={onPickVideo} onSetMediaView={onSetMediaView} />

          {/* Direct mode: skip image entirely. Single Gen Video button uses
              uploaded refs as visual anchor. Other modes: classic image-first
              flow with separate Img / OK / Vid buttons. */}
          {isDirect ? (
            <button onClick={onGenVideo} disabled={vidStatus === 'generating'}
              className="w-full mt-2 text-[11px] px-2 py-1.5 rounded bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white font-semibold disabled:opacity-50">
              {shot.video?.url ? '🔁 Re-gen Video' : '🎯 Generate Video Direct'}
            </button>
          ) : (
            <>
              <div className="mt-2 flex gap-1">
                <button onClick={onGenImage} disabled={imgStatus === 'generating' || vidStatus === 'generating'}
                  title={shot.image?.url ? 'Re-gen image' : 'Gen image'}
                  className="flex-1 text-[10px] px-1.5 py-1 rounded bg-blue-500/80 hover:bg-blue-500 text-white font-semibold disabled:opacity-50">
                  {shot.image?.url ? '🔁 Re-img' : '🖼 Img'}
                </button>
                <label className={`flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-[10px] font-semibold ${shot.approved ? 'bg-green-500/30 text-green-300 border border-green-500/50' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]'}`}>
                  <input type="checkbox" checked={shot.approved} disabled={!shot.image?.url} onChange={(e) => onApprove(e.target.checked)} className="w-3 h-3" />
                  OK
                </label>
              </div>
              {shot.image?.url && (
                <button onClick={onGenVideo} disabled={vidStatus === 'generating' || imgStatus === 'generating'}
                  className="w-full mt-1 text-[10px] px-1.5 py-1 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
                  {shot.video?.url ? '🔁 Re-vid' : '🎬 Vid this one'}
                </button>
              )}
            </>
          )}

          {/* Per-shot ref picker — chip row. Click chip to exclude that ref
              for THIS shot's video gen. Empty disabled list = inherit global.
              Only shown if there are refs to pick from. */}
          {availableRefs.length > 0 && (
            <div className="mt-2 pt-2 border-t border-[var(--border)]">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[9px] uppercase text-[var(--muted)] font-semibold">
                  🎯 Refs: {activeRefCount}/{availableRefs.length}
                </div>
                {disabledIds.length > 0 && (
                  <button onClick={onResetRefs} type="button" className="text-[9px] text-[var(--accent)] hover:underline">↺ all</button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {availableRefs.map((r) => {
                  const off = disabledIds.includes(r.id)
                  return (
                    <button key={r.id} type="button" onClick={() => onToggleRef?.(r.id)}
                      title={`${r.label || 'unlabeled'}${off ? ' (excluded)' : ''} — klik toggle`}
                      className={`relative w-7 h-7 rounded overflow-hidden border ${off ? 'border-[var(--border)] opacity-40' : 'border-[var(--accent)]'}`}>
                      <img src={r.fal_url} alt="" className="w-full h-full object-cover" />
                      {off && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-[11px] font-bold">✕</div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Prominent Send to QC — visible begitu ada image atau video */}
          {(shot.image?.url || shot.video?.url) && (
            shot.qc_sent ? (
              <a href="/qc" className="block w-full mt-1 text-[10px] px-1.5 py-1 rounded bg-green-500/30 hover:bg-green-500/50 border border-green-500/50 text-green-300 font-semibold text-center">
                ✓ In QC →
              </a>
            ) : (
              <button onClick={onSendQC}
                className="w-full mt-1 text-[10px] px-1.5 py-1 rounded bg-purple-500 hover:bg-purple-600 text-white font-bold">
                🧪 Send to QC
              </button>
            )
          )}
          {/* Continue — appears after video gen. Extracts last frame and
              creates a new shot below with continuity-anchor ref. Same
              mechanism as Storyboard's Continue, works for direct mode too.
              shot.continuing carries the live stage label so the user knows
              the click registered. */}
          {shot.video?.url && onContinue && (
            <button onClick={onContinue} disabled={!!shot.continuing}
              title="Continue from this shot's last frame as a NEW shot (appended at end)"
              className="w-full mt-1 text-[10px] px-1.5 py-1 rounded bg-cyan-600 hover:bg-cyan-700 text-white font-bold disabled:opacity-60 disabled:cursor-wait">
              {shot.continuing ? `⏳ ${shot.continuing}` : '➕ Continue (new shot)'}
            </button>
          )}
          {/* Link to next existing shot — merges this shot's last frame
              into Shot N+1's additional_ref_urls. Different from Continue:
              doesn't create a new shot, just patches the next one. Only
              shown when video is done AND there IS a next shot. Solves:
              user already Parsed N shots and wants visual handoff between
              them without losing the LLM-parsed motion text in Shot N+1. */}
          {shot.video?.url && onLinkNext && (
            <button onClick={onLinkNext} disabled={!!shot.continuing}
              title="Attach this shot's last frame as a continuity anchor for the NEXT shot in this persona (without creating a new shot)"
              className="w-full mt-1 text-[10px] px-1.5 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white font-bold disabled:opacity-60 disabled:cursor-wait">
              {shot.continuing ? `⏳ ${shot.continuing}` : '🔗 Link to Next Shot'}
            </button>
          )}
          {/* Inbound link indicator — shown on shots that received a frame
              from a previous shot via the link button. */}
          {shot.linked_from_shot && (
            <div className="mt-1 text-[9px] text-violet-300 bg-violet-900/30 border border-violet-700/40 rounded px-1.5 py-0.5 text-center">
              🔗 from {shot.linked_from_shot}
            </div>
          )}
        </div>

        {/* Editable text fields (right) */}
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            {editing ? (
              <input value={label} onChange={(e) => setLabel(e.target.value)}
                onBlur={() => { setEditing(false); if (label !== shot.label) onRename(label) }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                autoFocus className="flex-1 text-xs px-2 py-1 rounded bg-[var(--surface)] border border-[var(--accent)] focus:outline-none" />
            ) : (
              <div onDoubleClick={() => setEditing(true)} className="text-xs font-bold truncate cursor-text flex-1" title="double-click rename">
                {shot.label} <span className="text-[var(--muted2)] font-normal">· {shot.raw.shot_label}</span>
              </div>
            )}
            <div className="flex gap-1">
              {shot.video?.url && (
                <button onClick={onSendQC} className="text-[10px] px-2 py-1 rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--border)] font-semibold" title="Send to QC">🧪</button>
              )}
              <button onClick={onDelete} className="text-[10px] px-2 py-1 rounded text-red-400 hover:bg-[var(--surface)]" title="Hapus result">🗑</button>
            </div>
          </div>

          {/* Image prompt is meaningless in direct mode (no image gen step).
              Hide the field so user can't waste time editing it. */}
          {!isDirect && (
            <FieldRow label="📷 Image Prompt">
              <textarea rows={2} value={shot.raw.image_prompt || ''} onChange={(e) => onChangeRaw('image_prompt', e.target.value)}
                placeholder="English scene + lighting + camera..."
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
            </FieldRow>
          )}
          <FieldRow label={isDirect ? '🎥 Video Motion (ACTION timeline — pack semua aksi di sini)' : '🎥 Video Motion'}>
            <textarea rows={isDirect ? 4 : 2} value={shot.raw.video_motion || ''} onChange={(e) => onChangeRaw('video_motion', e.target.value)}
              placeholder={isDirect ? 'Beat-by-beat: what happens, camera moves, mood. Refs lock visual; motion is what changes.' : 'English motion + camera movement, max 20 kata'}
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </FieldRow>
          {/* Shared fields extracted by parser from naskah. Editable so user
              can override per-shot if needed. These get inlined into the
              final prompt by the compiler — not garbage, just hidden before. */}
          <FieldRow label="🌅 Environment (set + lighting from naskah)">
            <textarea rows={1} value={shot.raw.environment || ''} onChange={(e) => onChangeRaw('environment', e.target.value)}
              placeholder="auto-filled by parser from naskah, edit if needed"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </FieldRow>
          <FieldRow label="👔 Wardrobe (outfit from naskah)">
            <textarea rows={1} value={shot.raw.wardrobe || ''} onChange={(e) => onChangeRaw('wardrobe', e.target.value)}
              placeholder="auto-filled by parser if naskah mentions outfit, blank if not"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </FieldRow>
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <FieldRow label="💬 Dialog (di bahasa yang dipilih)">
              <textarea rows={2} value={shot.raw.dialogue || ''} onChange={(e) => onChangeRaw('dialogue', e.target.value)}
                placeholder='"Dialog karakter di sini..."'
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
            </FieldRow>
            <FieldRow label={`⏱ Detik (max ${maxDuration}s — ${vidModelLabel})`}>
              <input type="number" min={1} max={maxDuration} value={shot.raw.duration || 5}
                onChange={(e) => {
                  // Clamp to model max. fal.ai silently truncates output if
                  // we send larger duration than the model supports, which
                  // looks like a bug to the user (typed 15, got 10).
                  const v = parseInt(e.target.value) || 5
                  onChangeRaw('duration', Math.min(v, maxDuration))
                }}
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
              {(shot.raw.duration || 5) > maxDuration && (
                <div className="text-[9px] text-amber-400 mt-0.5">⚠ {shot.raw.duration}s exceeds {vidModelLabel} cap ({maxDuration}s) — akan di-cap saat gen</div>
              )}
            </FieldRow>
          </div>
        </div>
      </div>
    </div>
  )
}

// Small horizontal strip of variant thumbnails — visible only when there are
// 2+ variants. Click swaps which one is "active". Highlighted ring on current.
// kind = 'image' | 'video' so we can render <img> vs <video poster>.
function VariantStrip({ variants, activeIdx, onPick, kind }) {
  if (!variants || variants.length < 2) return null
  return (
    <div className="mt-2 flex gap-1 overflow-x-auto pb-1" title={`${variants.length} variants — klik buat pilih`}>
      {variants.map((v, i) => {
        const isActive = i === activeIdx
        return (
          <button key={i} onClick={() => onPick(i)}
            className={`relative flex-shrink-0 w-14 h-14 rounded overflow-hidden border-2 transition-all ${isActive ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] opacity-60 hover:opacity-100'}`}
            title={`Variant ${i + 1}${isActive ? ' (active)' : ''}`}>
            {kind === 'video' ? (
              <video src={v.url} muted preload="metadata" className="w-full h-full object-cover pointer-events-none" />
            ) : (
              <img src={v.url} alt="" loading="lazy" className="w-full h-full object-cover" />
            )}
            <span className="absolute top-0 left-0 text-[8px] bg-black/70 text-white px-1 rounded-br font-bold">{i + 1}</span>
          </button>
        )
      })}
    </div>
  )
}

// MediaGallery — shows BOTH image and video variants in separate labeled
// sections. User feedback: the old single-strip VariantStrip was confusing
// because it only showed one type at a time (video if any video existed,
// else image), making it look like the image variants disappeared after
// the first video gen. New layout makes it obvious that BOTH histories
// are preserved and clickable.
//
// Each row: type icon + count + horizontal scrollable thumbnails. Clicking
// a thumbnail sets it as active AND switches the media slot to that type
// (via onSetMediaView). Rows that have <2 items collapse to nothing — no
// point showing a "gallery" with one item.
function MediaGallery({ shot, onPickImage, onPickVideo, onSetMediaView }) {
  const imgVariants = shot.image_variants || []
  const vidVariants = shot.video_variants || []
  // Hide the whole block until something to pick from exists. Keeps the
  // shot card tight while user is still in setup.
  if (imgVariants.length < 2 && vidVariants.length < 2) return null
  const imgActive = shot.image_active_idx ?? (imgVariants.length - 1)
  const vidActive = shot.video_active_idx ?? (vidVariants.length - 1)
  return (
    <div className="mt-2 space-y-1.5">
      {imgVariants.length >= 2 && (
        <div>
          <div className="text-[9px] uppercase font-semibold text-[var(--muted)] mb-0.5">
            🖼 Images <span className="text-[var(--muted2)] font-normal normal-case">({imgVariants.length})</span>
          </div>
          <div className="flex gap-1 overflow-x-auto pb-1">
            {imgVariants.map((v, i) => {
              const isActive = i === imgActive
              return (
                <button key={i}
                  onClick={() => { onPickImage(i); if (onSetMediaView) onSetMediaView('image') }}
                  className={`relative flex-shrink-0 w-14 h-14 rounded overflow-hidden border-2 transition-all ${isActive && shot.mediaView !== 'video' ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] opacity-60 hover:opacity-100'}`}
                  title={`Image ${i + 1}${isActive ? ' (active)' : ''}`}>
                  <img src={v.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  <span className="absolute top-0 left-0 text-[8px] bg-black/70 text-white px-1 rounded-br font-bold">{i + 1}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {vidVariants.length >= 2 && (
        <div>
          <div className="text-[9px] uppercase font-semibold text-[var(--muted)] mb-0.5">
            🎬 Videos <span className="text-[var(--muted2)] font-normal normal-case">({vidVariants.length})</span>
          </div>
          <div className="flex gap-1 overflow-x-auto pb-1">
            {vidVariants.map((v, i) => {
              const isActive = i === vidActive
              return (
                <button key={i}
                  onClick={() => { onPickVideo(i); if (onSetMediaView) onSetMediaView('video') }}
                  className={`relative flex-shrink-0 w-14 h-14 rounded overflow-hidden border-2 transition-all ${isActive && shot.mediaView !== 'image' ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] opacity-60 hover:opacity-100'}`}
                  title={`Video ${i + 1}${isActive ? ' (active)' : ''}`}>
                  <video src={v.url} muted preload="metadata" className="w-full h-full object-cover pointer-events-none" />
                  <span className="absolute top-0 left-0 text-[8px] bg-black/70 text-white px-1 rounded-br font-bold">{i + 1}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function StoryboardEditor({ shot, idx, ar, availableRefs = [], onToggleRef, onResetRefs, onChangeRaw, onSetMediaView, onChangePanel, onGenImage, onGenVideo, onPickImage, onPickVideo, onApprove, onRename, onSendQC, onContinue, onLinkNext, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(shot.label || '')
  const [showPanels, setShowPanels] = useState(true)
  const imgStatus = shot.image?.status || 'idle'
  const vidStatus = shot.video?.status || 'idle'
  const panels = shot.raw.panels || []
  const totalSec = panels.reduce((s, p) => s + (parseInt(p.seconds) || 2), 0)
  const aspectClass = ar === '16:9' ? 'aspect-video' : ar === '1:1' ? 'aspect-square' : 'aspect-[9/16]'
  const disabledIds = shot.disabledRefIds || []
  const activeRefCount = availableRefs.length - disabledIds.length

  return (
    <div className={`bg-[var(--surface2)] border rounded p-3 ${shot.approved ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-3">
        {editing ? (
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { setEditing(false); if (label !== shot.label) onRename(label) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
            autoFocus className="flex-1 text-sm px-2 py-1 rounded bg-[var(--surface)] border border-[var(--accent)] focus:outline-none" />
        ) : (
          <div onDoubleClick={() => setEditing(true)} className="text-sm font-bold cursor-text flex-1 truncate" title="double-click rename">
            🗂 {shot.label}
            <span className="ml-2 text-[var(--muted2)] font-normal text-xs">{totalSec}s total · {panels.length} panel</span>
          </div>
        )}
        <div className="flex gap-1">
          {shot.video?.url && (
            <button onClick={onSendQC} title="Send to QC" className="text-xs px-2 py-1 rounded bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--border)] font-semibold">🧪</button>
          )}
          <button onClick={onDelete} title="Hapus" className="text-xs px-2 py-1 rounded text-red-400 hover:bg-[var(--surface)]">🗑</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* Left: grid image preview + actions */}
        <div>
          <div className={`${aspectClass} bg-black rounded overflow-hidden border border-[var(--border)] relative`}>
            {(() => {
              // Pick which media to show. Explicit shot.mediaView wins; if
              // unset, prefer video (post-gen default). Re-img sets
              // mediaView='image' so the new image is visible instead of
              // the stale video.
              const showVideo = shot.mediaView ? shot.mediaView === 'video' : !!shot.video?.url
              if (showVideo && shot.video?.url) return <LazyVideo src={shot.video.url} controls muted loop playsInline className="w-full h-full object-cover" />
              if (shot.image?.url) return <img src={shot.image.url} alt="" loading="lazy" className="w-full h-full object-cover" />
              return (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-[var(--muted)] text-center p-2">
                  {imgStatus === 'idle' ? 'no grid yet — klik 🖼 Gen Grid' : imgStatus}
                </div>
              )
            })()}
            {/* View toggle — only shown when BOTH image and video exist.
                Lets the user flip between grid (image) and video without
                re-genning either. */}
            {shot.image?.url && shot.video?.url && onSetMediaView && (
              <button
                onClick={() => onSetMediaView((shot.mediaView === 'image') ? 'video' : 'image')}
                className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white border border-white/20 hover:bg-black/90"
                title="Toggle image / video view">
                {(shot.mediaView === 'image' ? '🎬 vid' : '🗂 img')}
              </button>
            )}
            {imgStatus !== 'idle' && imgStatus !== 'done' && imgStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[10px] bg-black/80 text-white px-1.5 py-0.5 rounded truncate">⏳ img: {imgStatus}</div>
            )}
            {vidStatus !== 'idle' && vidStatus !== 'done' && vidStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[10px] bg-orange-600 text-white px-1.5 py-0.5 rounded truncate">🎬 vid: {vidStatus}</div>
            )}
            {imgStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[10px] bg-red-700 text-white px-1.5 py-1 rounded leading-tight max-h-[60%] overflow-y-auto" title={shot.image.error}>⚠ {shot.image.error}</div>
            )}
            {vidStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[10px] bg-red-700 text-white px-1.5 py-1 rounded leading-tight max-h-[60%] overflow-y-auto" title={shot.video.error}>⚠ {shot.video.error}</div>
            )}
          </div>

          {/* Media gallery — image variants + video variants both visible
              separately. Click thumbnail to switch active variant + media
              slot view. Collapses when nothing to pick from. */}
          <MediaGallery shot={shot} onPickImage={onPickImage} onPickVideo={onPickVideo} onSetMediaView={onSetMediaView} />

          <div className="mt-2 flex gap-1">
            <button onClick={onGenImage} disabled={imgStatus === 'generating' || vidStatus === 'generating'}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-blue-500/80 hover:bg-blue-500 text-white font-semibold disabled:opacity-50">
              {shot.image?.url ? '🔁 Re-gen Grid' : '🖼 Gen Grid'}
            </button>
            <label className={`flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer text-xs font-semibold ${shot.approved ? 'bg-green-500/30 text-green-300 border border-green-500/50' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]'}`}>
              <input type="checkbox" checked={shot.approved} disabled={!shot.image?.url} onChange={(e) => onApprove(e.target.checked)} className="w-3 h-3" />
              OK
            </label>
          </div>
          {shot.image?.url && (
            <button onClick={onGenVideo} disabled={vidStatus === 'generating' || imgStatus === 'generating'}
              className="w-full mt-1 text-xs px-2 py-1.5 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
              {shot.video?.url ? '🔁 Re-gen Video' : `🎬 Gen Video (${totalSec || 15}s)`}
            </button>
          )}

          {/* Per-shot ref picker — chip row. Same as ShotEditor. */}
          {availableRefs.length > 0 && (
            <div className="mt-2 pt-2 border-t border-[var(--border)]">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[9px] uppercase text-[var(--muted)] font-semibold">
                  🎯 Refs: {activeRefCount}/{availableRefs.length}
                </div>
                {disabledIds.length > 0 && (
                  <button onClick={onResetRefs} type="button" className="text-[9px] text-[var(--accent)] hover:underline">↺ all</button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {availableRefs.map((r) => {
                  const off = disabledIds.includes(r.id)
                  return (
                    <button key={r.id} type="button" onClick={() => onToggleRef?.(r.id)}
                      title={`${r.label || 'unlabeled'}${off ? ' (excluded)' : ''} — klik toggle`}
                      className={`relative w-7 h-7 rounded overflow-hidden border ${off ? 'border-[var(--border)] opacity-40' : 'border-[var(--accent)]'}`}>
                      <img src={r.fal_url} alt="" className="w-full h-full object-cover" />
                      {off && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-[11px] font-bold">✕</div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Prominent Send to QC — visible begitu ada image atau video */}
          {(shot.image?.url || shot.video?.url) && (
            shot.qc_sent ? (
              <a href="/qc" className="block w-full mt-1 text-xs px-2 py-1.5 rounded bg-green-500/30 hover:bg-green-500/50 border border-green-500/50 text-green-300 font-semibold text-center">
                ✓ In QC → buka QC
              </a>
            ) : (
              <button onClick={onSendQC}
                className="w-full mt-1 text-xs px-2 py-1.5 rounded bg-purple-500 hover:bg-purple-600 text-white font-bold">
                🧪 Send to QC {shot.video?.url ? '(video)' : '(image)'}
              </button>
            )
          )}
          {/* Continue Storyboard — appears once a video has been generated.
              Extracts the last frame and pre-loads it as a continuity anchor
              on a fresh empty storyboard shot below. User writes naskah for
              part 2, the new storyboard's video gen will include the last
              frame so visual handoff is smooth.
              First click can stall ~10s while ffmpeg.wasm loads — shot.continuing
              carries the live stage label so the button shows progress. */}
          {shot.video?.url && onContinue && (
            <button onClick={onContinue} disabled={!!shot.continuing}
              title="Continue from this storyboard's last frame as a NEW storyboard (appended at end)"
              className="w-full mt-1 text-xs px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-700 text-white font-bold disabled:opacity-60 disabled:cursor-wait">
              {shot.continuing ? `⏳ ${shot.continuing}` : '➕ Continue Storyboard (new)'}
            </button>
          )}
          {shot.video?.url && onLinkNext && (
            <button onClick={onLinkNext} disabled={!!shot.continuing}
              title="Attach this storyboard's last frame as a continuity anchor for the NEXT storyboard in this persona"
              className="w-full mt-1 text-xs px-2 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white font-bold disabled:opacity-60 disabled:cursor-wait">
              {shot.continuing ? `⏳ ${shot.continuing}` : '🔗 Link to Next Storyboard'}
            </button>
          )}
          {shot.linked_from_shot && (
            <div className="mt-1 text-[10px] text-violet-300 bg-violet-900/30 border border-violet-700/40 rounded px-2 py-1 text-center">
              🔗 anchor from {shot.linked_from_shot}
            </div>
          )}
        </div>

        {/* Right: concept + motion + 9 panels editable */}
        <div className="space-y-3 min-w-0">
          <FieldRow label="📜 Konsep Storyboard">
            <input value={shot.raw.concept || ''} onChange={(e) => onChangeRaw('concept', e.target.value)}
              placeholder="One-line concept (e.g. SEBUAH IBU MENYADARI ANCAMAN OBESITAS...)"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
          </FieldRow>
          <FieldRow label="🎥 Video Motion (transisi antar scene, max 30 kata)">
            <textarea rows={2} value={shot.raw.video_motion || ''} onChange={(e) => onChangeRaw('video_motion', e.target.value)}
              placeholder="Smooth transitions between scenes, subtle focus pulls..."
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </FieldRow>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[9px] uppercase text-[var(--muted)] font-semibold tracking-wider">9 Panel — edit per scene</div>
              <button onClick={() => setShowPanels((s) => !s)} className="text-[10px] text-[var(--muted)] underline hover:text-white">
                {showPanels ? 'Hide panels' : 'Show panels'}
              </button>
            </div>
            {showPanels && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {panels.map((panel, pi) => (
                  <PanelCard key={pi} panel={panel} onChange={(key, value) => onChangePanel(pi, key, value)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PanelCard({ panel, onChange }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="w-5 h-5 rounded-full bg-[var(--accent)] text-white text-[10px] flex items-center justify-center font-bold flex-shrink-0">{panel.n}</span>
        <input value={panel.title || ''} onChange={(e) => onChange('title', e.target.value)}
          placeholder="TITLE" className="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] font-bold uppercase" />
        <input type="number" min={1} max={5} value={panel.seconds || 2} onChange={(e) => onChange('seconds', parseInt(e.target.value) || 2)}
          className="w-12 text-[10px] px-1 py-0.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] text-center" title="seconds" />
        <span className="text-[9px] text-[var(--muted)]">s</span>
      </div>
      <textarea rows={2} value={panel.visual || ''} onChange={(e) => onChange('visual', e.target.value)}
        placeholder="📷 Visual..." className="w-full text-[10px] px-1.5 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] mb-1 resize-none" />
      <textarea rows={2} value={panel.dialog || ''} onChange={(e) => onChange('dialog', e.target.value)}
        placeholder='💬 "Dialog/VO..."' className="w-full text-[10px] px-1.5 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] text-[#93c5fd] italic mb-1 resize-none" />
      <textarea rows={1} value={panel.onscreen || ''} onChange={(e) => onChange('onscreen', e.target.value)}
        placeholder="📝 Keterangan..." className="w-full text-[10px] px-1.5 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] text-[var(--muted)] resize-none" />
    </div>
  )
}

function FieldRow({ label, children }) {
  return (
    <div>
      <div className="text-[9px] uppercase text-[var(--muted)] font-semibold tracking-wider mb-1">{label}</div>
      {children}
    </div>
  )
}

// Compact field label + child wrapper (used by PresetEditorModal)
function Field({ label, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">{label}</div>
      {children}
    </div>
  )
}

function RefsPicker({ personaOwnRefs, workspaceRefs, showWorkspace, onToggleShowWorkspace, selectedIds, onToggle, workspaceId, userId, personaId, supabase, onErr, onAdded }) {
  const [extras, setExtras] = useState([])
  const fileRef = useRef(null)
  const [pendingFile, setPendingFile] = useState(null)
  const [pLabel, setPLabel] = useState('')
  const [pKnowledge, setPKnowledge] = useState('')
  const [pKind, setPKind] = useState('character')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)

  // Active visible refs: persona's own + uploaded extras; PLUS workspace refs if toggled
  const personaScope = useMemo(() => {
    const seen = new Set()
    const out = []
    extras.forEach((r) => { if (!seen.has(r.id)) { seen.add(r.id); out.push(r) } })
    personaOwnRefs.forEach((r) => { if (!seen.has(r.id)) { seen.add(r.id); out.push(r) } })
    return out
  }, [extras, personaOwnRefs])

  const workspaceScope = useMemo(() => {
    const personaIds = new Set(personaScope.map((r) => r.id))
    return workspaceRefs.filter((r) => !personaIds.has(r.id))
  }, [workspaceRefs, personaScope])

  async function onFilePicked(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    // Single file → open the label/knowledge modal as before.
    if (files.length === 1) {
      setPendingFile(files[0])
      setPLabel('')
      setPKnowledge('')
      setPKind('character')
      setOpening(true)
      return
    }
    // Multi-file → batch upload with filename as label + kind=character.
    // User can edit label/knowledge per ref later from /refs. This unblocks
    // the "I have 8 reference photos, just take them all" flow.
    setBusy(true); onErr('')
    let added = 0
    try {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue
        try {
          const { url: publicUrl } = await uploadFile(f, 'refs')
          const { data: row, error } = await supabase.from('refs')
            .insert({
              workspace_id: workspaceId, fal_url: publicUrl,
              label: f.name.replace(/\.[^.]+$/, ''), knowledge: null,
              kind: 'character', created_by: userId,
            })
            .select('id, fal_url, label, knowledge, kind').single()
          if (error) throw error
          if (personaId) {
            await supabase.from('persona_refs').insert({ persona_id: personaId, ref_id: row.id })
          }
          setExtras((p) => [{ ...row, source: 'just-uploaded' }, ...p])
          onAdded(row)
          added++
        } catch (perFileErr) {
          onErr(`${f.name}: ${perFileErr.message}`)
        }
      }
      if (added > 0) onErr(`✓ ${added} ref(s) uploaded — edit label/knowledge di /refs kalau perlu.`)
    } catch (e) { onErr('Batch upload: ' + e.message) }
    setBusy(false)
  }

  async function savePending() {
    if (!pendingFile) return
    setBusy(true); onErr('')
    try {
      const { url: publicUrl } = await uploadFile(pendingFile, 'refs')
      const { data: row, error } = await supabase.from('refs')
        .insert({
          workspace_id: workspaceId, fal_url: publicUrl,
          label: pLabel.trim() || pendingFile.name.replace(/\.[^.]+$/, ''),
          knowledge: pKnowledge.trim() || null,
          kind: pKind, created_by: userId,
        })
        .select('id, fal_url, label, knowledge, kind').single()
      if (error) throw error
      if (personaId) {
        await supabase.from('persona_refs').insert({ persona_id: personaId, ref_id: row.id })
      }
      setExtras((p) => [{ ...row, source: 'just-uploaded' }, ...p])
      onAdded(row)
      setOpening(false); setPendingFile(null)
    } catch (e) { onErr('Upload: ' + e.message) }
    setBusy(false)
  }

  function RefTile({ r }) {
    const on = selectedIds.has(r.id)
    return (
      <button onClick={() => onToggle(r.id)} type="button"
        className={`relative w-[88px] rounded border ${on ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] opacity-60 hover:opacity-100'}`}>
        <div className="aspect-square w-full bg-[var(--surface2)] rounded-t overflow-hidden">
          <img src={r.fal_url} alt={r.label} className="w-full h-full object-cover" />
        </div>
        <div className="px-1 py-1">
          <div className="text-[10px] font-semibold truncate text-left">{r.label || 'unlabeled'}</div>
          <div className="flex justify-between text-[9px]">
            <span className="text-[var(--muted)]">{r.kind === 'product' ? '📦' : '👤'}</span>
            {r.knowledge && <span title={r.knowledge} className="text-[var(--accent)]">📋</span>}
          </div>
        </div>
        {on && <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-[var(--accent)] text-white text-[10px] flex items-center justify-center">✓</span>}
      </button>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[10px] uppercase text-[var(--muted)] font-semibold">
          Refs ({selectedIds.size} selected) — character + product
        </label>
        {workspaceScope.length > 0 && (
          <button onClick={onToggleShowWorkspace} className="text-[10px] text-[var(--muted)] underline hover:text-white">
            {showWorkspace ? `Hide workspace pool` : `+ Show workspace pool (${workspaceScope.length})`}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 p-1 bg-[var(--surface2)]/30 rounded border border-[var(--border)]">
        {personaScope.length === 0 && !showWorkspace && (
          <div className="w-full text-[10px] text-[var(--muted)] p-3">
            Persona ini belum punya ref. Klik <strong>+ Upload</strong> di kanan, atau toggle "Show workspace pool" buat pakai ref umum.
          </div>
        )}
        {personaScope.map((r) => <RefTile key={r.id} r={r} />)}
        {showWorkspace && workspaceScope.map((r) => <RefTile key={r.id} r={r} />)}

        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
          className="w-[88px] rounded border-2 border-dashed border-[var(--border)] flex flex-col items-center justify-center gap-1 text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          style={{ height: 116 }}>
          <span className="text-2xl">{busy ? '⏳' : '+'}</span>
          <span className="text-[9px] font-semibold">{busy ? 'Upload...' : 'Upload (multi)'}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFilePicked} />
      </div>

      {opening && pendingFile && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) setOpening(false) }}>
          <div className="w-full max-w-lg bg-[var(--surface)] rounded-xl border border-[var(--border)]">
            <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <h3 className="text-base font-bold">+ Upload Reference</h3>
              <button onClick={() => setOpening(false)} className="text-[var(--muted)]">✕</button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-[120px_1fr] gap-4 items-start">
                <img src={URL.createObjectURL(pendingFile)} alt="" className="w-full aspect-square object-cover rounded border border-[var(--border)]" />
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">Label / Nama</label>
                    <input value={pLabel} onChange={(e) => setPLabel(e.target.value)} placeholder="e.g. AceKid kaleng 400g"
                      className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">Tipe</label>
                    <div className="flex gap-2">
                      {[['character', '👤 Karakter'], ['product', '📦 Produk']].map(([v, l]) => (
                        <button key={v} onClick={() => setPKind(v)} type="button"
                          className={`px-3 py-1.5 rounded text-xs ${pKind === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface2)] text-[var(--muted)]'}`}>{l}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-[10px] uppercase text-[var(--muted)] font-semibold mb-1">
                  📋 Keterangan / Product Knowledge {pKind === 'character' && <span className="text-[var(--muted2)] normal-case">(opsional)</span>}
                </label>
                <textarea rows={5} value={pKnowledge} onChange={(e) => setPKnowledge(e.target.value)}
                  placeholder={pKind === 'product'
                    ? 'TEKS KEMASAN: "AceKid", "Activegro", "3+ Years"\nWARNA: kaleng biru-kuning, tutup biru\nATURAN: kaleng tegak, logo hadap kamera\nVARIAN: 130g / 400g\nDIMENSI: tinggi 16cm × diameter 12cm (400g)\nSKALA: fit 2 tangan dewasa'
                    : 'ROLE: baby / adult / elder (family role)\nPROPORSI: chibi (kepala ≈ ⅓ tinggi total)\nUKURAN RELATIVE: ⅓ tinggi Ayah / sebatas pinggang adult\nOUTFIT: blue bandana "Ace" + yellow ear tag\nCIRI KHAS: cow spots, pink cheeks\nPERSONALITY: cheerful, baby talk "muchu muchu"'}
                  className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
                <div className="text-[10px] text-[var(--muted2)] mt-1">
                  Auto-inject ke prompt image gen pas ref ini ke-link ke shot.
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end gap-3">
              <button onClick={() => setOpening(false)} className="px-4 py-2 rounded text-sm">Batal</button>
              <button onClick={savePending} disabled={busy}
                className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
                {busy ? '⏳ Uploading...' : '✓ Simpan + Pakai'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Camera Preset picker — dropdown + chip strip of recent presets + CRUD modal.
// Built-in presets come from CAMERA_PRESETS const. User custom presets from
// /api/workspace/camera-presets. Lu bisa Add / Edit / Clone / Delete custom.
function CameraPresetPicker({ workspaceId, value, onChange, userPresets, onUserPresetsChanged }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null | { id?, _row_id?, preset_key, label, ... }
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const all = useMemo(() => listAllPresets(userPresets), [userPresets])
  const current = useMemo(() => all.find((p) => p.id === value) || all[0], [all, value])

  // Group by category for the dropdown
  const grouped = useMemo(() => {
    const g = { phone: [], cinema: [], animation: [], social: [], custom: [] }
    all.forEach((p) => {
      const cat = p.category || (p._builtin ? 'cinema' : 'custom')
      if (!g[cat]) g[cat] = []
      g[cat].push(p)
    })
    return g
  }, [all])

  function startNew() {
    setEditing({
      preset_key: '',
      label: '',
      category: 'custom',
      use_case: '',
      tokens: [],
      negatives: [],
      conflicts_with: [],
      dominance: 5,
    })
    setErr('')
    setModalOpen(true)
  }
  function startEdit(preset) {
    setEditing({
      ...preset,
      tokens: preset.tokens || [],
      negatives: preset.negatives || [],
    })
    setErr('')
    setModalOpen(true)
  }
  function startClone(preset) {
    setEditing({
      preset_key: (preset.id + '_copy').slice(0, 60),
      label: preset.label + ' (copy)',
      category: 'custom',
      use_case: preset.use_case || '',
      tokens: [...(preset.tokens || [])],
      negatives: [...(preset.negatives || [])],
      conflicts_with: [...(preset.conflicts_with || [])],
      dominance: preset.dominance || 5,
    })
    setErr('')
    setModalOpen(true)
  }
  async function save() {
    if (!editing.label?.trim()) { setErr('Label wajib'); return }
    if (!editing.preset_key?.trim()) { setErr('Preset key wajib'); return }
    if (!editing.tokens?.length) { setErr('Minimal 1 token'); return }
    setBusy(true); setErr('')
    try {
      const method = editing._row_id ? 'PATCH' : 'POST'
      const body = {
        ...editing,
        id: editing._row_id || undefined,
      }
      const r = await fetch('/api/workspace/camera-presets', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setModalOpen(false); setEditing(null)
      onUserPresetsChanged?.()
      // Auto-select the just-saved preset
      if (j.preset_key) onChange(j.preset_key)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  async function deletePreset(preset) {
    if (!preset._row_id) return
    if (!confirm(`Hapus preset "${preset.label}"?`)) return
    setBusy(true)
    try {
      const r = await fetch('/api/workspace/camera-presets', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: preset._row_id }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      onUserPresetsChanged?.()
      if (value === preset.id) onChange(DEFAULT_CAMERA)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">
          📷 Camera Preset — drives visual identity (L1 tokens, highest priority)
        </label>
        <div className="flex items-center gap-2">
          {current && !current._builtin && (
            <button onClick={() => startEdit(current)} type="button" className="text-[10px] text-[var(--muted)] hover:text-[var(--accent)] underline">Edit</button>
          )}
          {current && (
            <button onClick={() => startClone(current)} type="button" className="text-[10px] text-[var(--muted)] hover:text-[var(--accent)] underline">Clone</button>
          )}
          <button onClick={startNew} type="button" className="text-[10px] text-[var(--accent)] font-semibold hover:underline">+ Bikin Preset</button>
        </div>
      </div>
      <select value={value || DEFAULT_CAMERA} onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]">
        {['phone', 'cinema', 'animation', 'social', 'custom'].map((cat) => {
          const list = grouped[cat] || []
          if (list.length === 0) return null
          return (
            <optgroup key={cat} label={`${cat.toUpperCase()} (${list.length})`}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p._builtin ? '⚙️ ' : '👤 '}{p.label}{p.use_case ? ` — ${p.use_case}` : ''}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
      {current && (
        <div className="text-[10px] text-[var(--muted2)] mt-1 leading-relaxed">
          <strong className="text-[var(--muted)]">{current.tokens?.length || 0} tokens</strong>: {(current.tokens || []).slice(0, 6).join(', ')}{current.tokens?.length > 6 ? '...' : ''}
        </div>
      )}

      {modalOpen && editing && (
        <PresetEditorModal
          preset={editing}
          onChange={setEditing}
          err={err}
          busy={busy}
          workspaceId={workspaceId}
          onCancel={() => { setModalOpen(false); setEditing(null) }}
          onSave={save}
          onDelete={editing._row_id ? () => deletePreset(editing) : null} />
      )}
    </div>
  )
}

function PresetEditorModal({ preset, onChange, err, busy, workspaceId, onCancel, onSave, onDelete }) {
  const tokensText = (preset.tokens || []).join('\n')
  const negativesText = (preset.negatives || []).join('\n')
  const styleRefs = preset.style_ref_urls || []
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  // Lazy supabase client — only needed when user actually uploads.
  const supabase = useMemo(() => createClient(), [])

  async function onPickFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    if (!workspaceId) { setUploadErr('Workspace belum siap'); return }
    const room = 8 - styleRefs.length
    if (room <= 0) { setUploadErr('Max 8 style refs per preset'); return }
    const take = files.slice(0, room)
    setUploading(true); setUploadErr('')
    const newUrls = []
    try {
      for (const f of take) {
        if (!f.type.startsWith('image/')) continue
        const { url } = await uploadFile(f, 'preset-style', { name: `${preset.preset_key || 'new'}-${f.name || 'img'}` })
        newUrls.push(url)
      }
      onChange({ ...preset, style_ref_urls: [...styleRefs, ...newUrls] })
    } catch (e) { setUploadErr(e.message || String(e)) }
    setUploading(false)
  }
  function removeRef(url) {
    onChange({ ...preset, style_ref_urls: styleRefs.filter((u) => u !== url) })
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="w-full max-w-2xl bg-[var(--surface)] rounded-xl border border-[var(--border)] max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold">📷 {preset._row_id ? 'Edit' : 'Bikin'} Camera Preset</h2>
            <p className="text-[10px] text-[var(--muted)]">Tokens di-inject paling awal di prompt (highest priority). Negatives di-strip dari layer lain pas preset ini menang.</p>
          </div>
          <button onClick={onCancel} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto flex-1 text-xs">
          {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-2 rounded">⚠ {err}</div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label (ditampilin di dropdown)">
              <input value={preset.label} onChange={(e) => onChange({ ...preset, label: e.target.value })}
                placeholder="My Brand UGC"
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]" />
            </Field>
            <Field label="Preset key (id, lowercase + underscore)">
              <input value={preset.preset_key} disabled={!!preset._row_id}
                onChange={(e) => onChange({ ...preset, preset_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                placeholder="acekid_brand_ugc"
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] font-mono disabled:opacity-60" />
            </Field>
          </div>
          <Field label="Use case (hint)">
            <input value={preset.use_case || ''} onChange={(e) => onChange({ ...preset, use_case: e.target.value })}
              placeholder="Brand AceKid TikTok UGC — Samsung look natural"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <select value={preset.category} onChange={(e) => onChange({ ...preset, category: e.target.value })}
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)]">
                <option value="phone">phone</option>
                <option value="cinema">cinema</option>
                <option value="animation">animation</option>
                <option value="social">social</option>
                <option value="custom">custom</option>
              </select>
            </Field>
            <Field label="Dominance (1-10, higher wins contradictions)">
              <input type="number" min={1} max={10} value={preset.dominance ?? 5}
                onChange={(e) => onChange({ ...preset, dominance: Math.max(1, Math.min(10, parseInt(e.target.value) || 5)) })}
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] font-mono" />
            </Field>
          </div>
          <Field label="Tokens (1 per line) — visual phrases injected as L1, FIRST in prompt">
            <textarea value={tokensText} onChange={(e) => onChange({ ...preset, tokens: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
              rows={6}
              placeholder={`shot on Samsung Galaxy A13 phone camera\ncandid handheld\nvertical 9:16\nnatural window light\nslight motion blur\nimperfect framing\nauthentic skin pores\nno color grade`}
              className="w-full text-[11px] font-mono px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] resize-y" />
            <div className="text-[9px] text-[var(--muted2)] mt-0.5">{preset.tokens?.length || 0} token. Recommend 5-10 untuk hasil paling stabil.</div>
          </Field>
          <Field label="Negatives (1 per line) — phrases sanitizer strips dari layer lain pas preset ini menang">
            <textarea value={negativesText} onChange={(e) => onChange({ ...preset, negatives: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
              rows={4}
              placeholder={`cinematic\nARRI Alexa\nprofessional studio\nglossy\ncolor graded\nsharp focus\nhigh-detail photography\nwell-balanced composition`}
              className="w-full text-[11px] font-mono px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] resize-y" />
          </Field>
          <div className="pt-2 border-t border-[var(--border)]">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase text-[var(--muted)] font-semibold">🖼 Visual Style References (mood board) — {styleRefs.length}/8</div>
              <label className={`text-[10px] px-2 py-1 rounded font-semibold cursor-pointer ${uploading ? 'bg-[var(--surface2)] text-[var(--muted)]' : 'bg-[var(--accent)] text-white'}`}>
                {uploading ? '⏳ Upload...' : '+ Upload image'}
                <input type="file" accept="image/*" multiple disabled={uploading || styleRefs.length >= 8} onChange={onPickFiles} className="hidden" />
              </label>
            </div>
            <div className="text-[9px] text-[var(--muted2)] mb-2 leading-relaxed">
              Auto-inject ke image gen sebagai <strong>style refs</strong> pas preset ini aktif. Model bakal cocokin palette, lighting, render style — TIDAK ngambil karakter/wajah dari gambar.
            </div>
            {uploadErr && <div className="text-[10px] text-red-400 mb-1.5">⚠ {uploadErr}</div>}
            {styleRefs.length > 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {styleRefs.map((url) => (
                  <div key={url} className="relative group aspect-square bg-[var(--surface2)] rounded overflow-hidden border border-[var(--border)]">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    <button onClick={() => removeRef(url)} type="button"
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500/90 text-white text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-[var(--muted2)] italic">Belum ada style ref. Upload 1-3 gambar yang nge-represent look yang lo mau.</div>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-between gap-3 flex-shrink-0">
          <div>
            {onDelete && (
              <button onClick={onDelete} className="text-xs px-3 py-2 rounded text-red-400 hover:bg-red-900/20">🗑 Hapus</button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onCancel} className="text-xs px-3 py-2 rounded text-[var(--muted)] hover:bg-[var(--surface2)]">Cancel</button>
            <button onClick={onSave} disabled={busy} className="text-xs px-4 py-2 rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
              {busy ? '⏳ Save...' : (preset._row_id ? 'Update' : '+ Bikin')}
            </button>
          </div>
        </div>
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

// Compact chip toggle — used for Output Constraints (4 in a row).
// One-line, just icon+label. ToggleCard below is the bigger card version
// (no longer used since UI compactification — kept for back-compat).
function ChipToggle({ label, on, onClick }) {
  return (
    <button onClick={onClick} type="button"
      className={`text-[10px] px-2 py-1 rounded-full border font-semibold whitespace-nowrap ${on
        ? 'bg-[var(--accent)]/15 border-[var(--accent)]/60 text-[var(--accent)]'
        : 'bg-[var(--surface2)] border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]'}`}>
      {on ? '✓ ' : '○ '}{label}
    </button>
  )
}

function ToggleCard({ label, sub, on, onClick }) {
  return (
    <button onClick={onClick} type="button"
      className={`text-left p-2 rounded border transition-all ${on
        ? 'border-[var(--accent)] bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]'
        : 'border-[var(--border)] bg-[var(--surface2)] hover:border-[var(--muted)]'}`}>
      <div className="text-xs font-semibold flex items-center gap-1.5">
        <span className={`text-[10px] ${on ? 'text-[var(--accent)]' : 'text-[var(--muted2)]'}`}>{on ? '✓' : '○'}</span>
        {label}
      </div>
      {sub && <div className="text-[9px] text-[var(--muted2)] mt-0.5 line-clamp-2">{sub}</div>}
    </button>
  )
}

// Style References — mood board images yang di-inject ke gen request buat
// keep visual style consistent across shots. Refs disimpan di table 'refs'
// dengan kind='style' (beda dari character/product refs di persona picker).
function StyleRefsPicker({ workspaceId, userId, selectedIds, onChange }) {
  const supabase = useMemo(() => require('@/lib/supabase/client').createClient(), [])
  const [refs, setRefs] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    if (!workspaceId) return
    setLoading(true)
    async function load() {
      const { data, error } = await supabase.from('refs')
        .select('id, fal_url, label, knowledge, kind')
        .eq('workspace_id', workspaceId)
        .eq('kind', 'style')
        .order('created_at', { ascending: false })
      if (error) {
        // 400 dari sini berarti ref_kind enum belum punya 'style' value.
        // Sebelum migration 0015 di-apply, fail gracefully — tampilin empty
        // list bukannya throw. Migrasi enum: alter type ref_kind add value 'style'.
        if (error.code === 'PGRST204' || /invalid input value for enum/i.test(error.message)) {
          setErr('Style refs disabled — apply migration 0015_ref_kind_style.sql di Supabase SQL Editor.')
        }
        setRefs([])
      } else {
        setRefs(data || [])
      }
      setLoading(false)
    }
    load()
    // Realtime sync: kalau user upload style ref atau hapus, list auto-update.
    const ch = supabase.channel('styleref-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'refs', filter: `workspace_id=eq.${workspaceId}` }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [workspaceId, supabase])

  function toggle(id) {
    const next = new Set(selectedIds)
    next.has(id) ? next.delete(id) : next.add(id)
    onChange(next)
  }

  async function onFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    if (!f.type.startsWith('image/')) { setErr('File harus image'); return }
    setBusy(true); setErr('')
    try {
      const { url: publicUrl } = await uploadFile(f, 'style')
      const { data: row, error } = await supabase.from('refs').insert({
        workspace_id: workspaceId, fal_url: publicUrl,
        label: f.name.replace(/\.[^.]+$/, ''),
        kind: 'style', created_by: userId,
      }).select('id, fal_url, label, knowledge, kind').single()
      if (error) throw error
      setRefs((p) => [row, ...p])
      // Auto-select newly uploaded
      const next = new Set(selectedIds); next.add(row.id); onChange(next)
    } catch (e) { setErr('Upload: ' + e.message) }
    setBusy(false)
  }

  async function deleteRef(id) {
    if (!confirm('Hapus style reference ini?')) return
    const { error } = await supabase.from('refs').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    setRefs((p) => p.filter((r) => r.id !== id))
    const next = new Set(selectedIds); next.delete(id); onChange(next)
  }

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">
          🖼 Style References ({selectedIds.size} aktif)
        </label>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className="text-[10px] px-2 py-1 rounded bg-cyan-500/30 border border-cyan-500/60 text-cyan-200 hover:bg-cyan-500/50 disabled:opacity-50">
          {busy ? '⏳' : '+ Upload mood board'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      </div>
      {err && <div className="text-[10px] text-red-400 mb-1">⚠ {err}</div>}

      {loading ? (
        <div className="text-[10px] text-[var(--muted)] p-2">Loading style refs...</div>
      ) : refs.length === 0 ? (
        <div className="text-[10px] text-[var(--muted)] p-3 border border-dashed border-[var(--border)] rounded">
          Belum ada style refs. Upload 1-3 mood board image (referensi look/warna/komposisi) buat keep output consistent across shots.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 p-2 bg-[var(--surface2)]/30 rounded border border-[var(--border)]">
          {refs.map((r) => {
            const on = selectedIds.has(r.id)
            return (
              <div key={r.id} className="relative group">
                <button onClick={() => toggle(r.id)} type="button"
                  className={`w-[80px] aspect-square rounded border-2 overflow-hidden ${on ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/50' : 'border-[var(--border)] opacity-60 hover:opacity-100'}`}>
                  <img src={r.fal_url} alt={r.label} className="w-full h-full object-cover" />
                </button>
                {on && <span className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-[var(--accent)] text-white text-[10px] flex items-center justify-center font-bold">✓</span>}
                <button onClick={() => deleteRef(r.id)} className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] hidden group-hover:flex items-center justify-center" title="Delete">×</button>
                <div className="text-[8px] text-[var(--muted2)] text-center truncate w-[80px]">{r.label}</div>
              </div>
            )
          })}
        </div>
      )}
      <div className="text-[10px] text-[var(--muted2)] mt-1">
        Style refs di-inject sebagai image_urls ke image gen → output cocokin look/warna/komposisi referensi. Best 1-3 image.
      </div>
    </div>
  )
}
