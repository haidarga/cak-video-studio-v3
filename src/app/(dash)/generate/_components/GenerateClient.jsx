'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  falRun, buildImgInput, buildVidInput, productDirective,
  buildStoryboardGridPrompt,
  IMG_QUALITY, VID_STABILITY, VIDEO_MODELS, IMAGE_MODELS,
} from '@/lib/fal-client'
import { imageCost, videoCost, fmtCost } from '@/lib/cost-table'
import { STYLE_PRESETS, applyStylePreset } from '@/lib/style-presets'

export default function GenerateClient({ workspaceId, userId, activeBrand, personas: initialPersonas, workspaceRefs: initialRefs }) {
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
    style: 'ugc',
    // Output constraints — toggles per gen session. These override the
    // parser's default scene breakdown + brand product injection.
    continuousShot: false, // storyboard: 1 continuous take (no multi-scene language in vid prompt)
    skipDialog: false,     // omit dialog/VO from vid prompt + storyboard grid
    skipOnscreen: false,   // omit onscreen text from prompt + grid
    skipProduct: false,    // bypass brand product injection in CTA panel
  })

  // Pick style — does NOT touch model selection (user controls model independently)
  function pickStyle(styleKey) {
    setGlobalConfig((c) => ({ ...c, style: styleKey === c.style ? 'none' : styleKey }))
  }
  const [stateByPersona, setStateByPersona] = useState({})
  const [err, setErr] = useState('')

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
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold mb-1">⚡ Generate</h1>
        <p className="text-sm text-[var(--muted)]">
          Pilih persona → naskah → Parse → <strong>Generate Images dulu</strong> → approve yang oke → <strong>Generate Videos</strong> dari approved. Image murah, video mahal — filter di level image dulu.
          {activeBrand && <> · Brand aktif: <strong className="text-[var(--accent)]">{activeBrand.name}</strong></>}
        </p>
      </div>

      {err && <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 p-3 rounded">⚠ {err}</div>}

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--muted)] mb-3">Global Config</h2>

        {/* Style preset grid — affects PROMPT only. Model dipilih independent. */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">🎨 Style / Genre — affects prompt only</label>
            {globalConfig.style && globalConfig.style !== 'none' && (
              <button onClick={() => setGlobalConfig({ ...globalConfig, style: 'none' })} className="text-[10px] text-[var(--muted)] underline hover:text-white">
                Clear style
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {Object.entries(STYLE_PRESETS).map(([key, preset]) => {
              const on = globalConfig.style === key
              return (
                <button key={key} onClick={() => pickStyle(key)}
                  className={`text-left p-2 rounded border transition-all ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]' : 'border-[var(--border)] bg-[var(--surface2)] hover:border-[var(--muted)]'}`}>
                  <div className="text-xs font-semibold">{preset.label}</div>
                  <div className="text-[10px] text-[var(--muted)] mt-0.5 line-clamp-2">{preset.description}</div>
                  <div className="text-[9px] text-[var(--muted2)] mt-1">💡 Suggest: {preset.recommended_img_model?.split('/').pop()}</div>
                </button>
              )
            })}
          </div>
          <div className="text-[10px] text-[var(--muted2)] mt-1.5">
            Style cuma inject ke prompt (prefix + suffix + negative + boosters). Model dipilih manual di bawah — fleksibel.
          </div>
        </div>

        {/* Style References — upload mood board images buat consistent look */}
        <StyleRefsPicker workspaceId={workspaceId} userId={userId}
          selectedIds={globalConfig.styleRefIds || new Set()}
          onChange={(ids) => setGlobalConfig({ ...globalConfig, styleRefIds: ids })} />

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Sel label="Mode" value={globalConfig.mode} onChange={(v) => setGlobalConfig({ ...globalConfig, mode: v })}
            options={[['shots', '🎬 Per-Shot (5-8 cut)'], ['storyboard', '🗂 Storyboard 3×3 (~15s)']]} />
          <Sel label="Aspect Ratio" value={globalConfig.ar} onChange={(v) => setGlobalConfig({ ...globalConfig, ar: v })}
            options={[['9:16', '9:16 vertical'], ['16:9', '16:9 horizontal'], ['1:1', '1:1 square']]} />
          <Sel label="Bahasa Dialog" value={globalConfig.lang} onChange={(v) => setGlobalConfig({ ...globalConfig, lang: v })}
            options={[['Indonesian', 'Indonesian'], ['English', 'English'], ['Javanese', 'Javanese'], ['Sundanese', 'Sundanese'], ['Balinese', 'Balinese']]} />
          <Sel label="Image Model" value={globalConfig.imgModel} onChange={(v) => setGlobalConfig({ ...globalConfig, imgModel: v })}
            options={IMAGE_MODELS.map((m) => [m.v, m.l])} />
          <Sel label="Video Model" value={globalConfig.vidModel} onChange={(v) => setGlobalConfig({ ...globalConfig, vidModel: v })}
            options={VIDEO_MODELS.map((m) => [m.v, m.l])} />
        </div>

        {/* Output constraint toggles — overrides default parser/prompt behavior.
            Especially relevant for storyboard mode where default = 9 multi-cut. */}
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold mb-2">🎛 Output Constraints (untuk override default parser)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <ToggleCard label="🎬 Continuous shot" sub="Video 1 take, no cuts (storyboard mode)" on={!!globalConfig.continuousShot}
              onClick={() => setGlobalConfig({ ...globalConfig, continuousShot: !globalConfig.continuousShot })} />
            <ToggleCard label="🔇 Skip dialog/VO" sub="No spoken lines in video" on={!!globalConfig.skipDialog}
              onClick={() => setGlobalConfig({ ...globalConfig, skipDialog: !globalConfig.skipDialog })} />
            <ToggleCard label="📝 Skip onscreen text" sub="No subtitle/caption overlay" on={!!globalConfig.skipOnscreen}
              onClick={() => setGlobalConfig({ ...globalConfig, skipOnscreen: !globalConfig.skipOnscreen })} />
            <ToggleCard label="🚫 Skip product" sub="No brand product in CTA panel" on={!!globalConfig.skipProduct}
              onClick={() => setGlobalConfig({ ...globalConfig, skipProduct: !globalConfig.skipProduct })} />
          </div>
        </div>
      </section>

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

      {selectedPersonas.map((persona) => (
        <PersonaSection
          key={persona.id}
          persona={persona}
          workspaceRefs={workspaceRefs}
          state={stateByPersona[persona.id] || { naskah: '', refIds: new Set(), showWorkspaceRefs: false, parsed: null, busy: false, shots: [] }}
          onPatch={(patch) => patchPersona(persona.id, patch)}
          globalConfig={globalConfig}
          styleRefs={workspaceRefs.filter((r) => r.kind === 'style' && (globalConfig.styleRefIds || new Set()).has(r.id))}
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

function PersonaSection({ persona, workspaceRefs, styleRefs = [], state, onPatch, globalConfig, activeBrand, workspaceId, userId, onErr, supabase }) {
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
            concept: data.parsed.concept || '',
            panels: panels.map((p) => ({
              n: p.n, title: p.title || '', visual: p.visual || p.scene || '',
              dialog: p.dialog || '', onscreen: p.onscreen || p.purpose || '',
              seconds: p.seconds || 2, shot_type: p.shot_type || '',
            })),
            video_motion: 'Smooth camera transitions through 9 scenes with subtle focus pulls and natural pacing',
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
        shotsInit = items.map((it, i) => ({
          id: `${persona.id}-${i}-${Date.now()}`,
          raw: {
            image_prompt: it.image_prompt || '',
            video_motion: it.video_motion || '',
            dialogue: it.dialogue || '',
            duration: it.duration || 5,
            shot_label: `Shot ${it.shot}`,
          },
          label: `${persona.name} — Shot ${it.shot || i + 1}`,
          image: { status: 'idle' },
          video: { status: 'idle' },
          approved: false,
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
      const productKnowledge = selectedRefs.map((r) => (r.knowledge || '').trim()).filter(Boolean).join('\n')
      const directive = productDirective(productKnowledge || activeBrand?.notes)
      // Combine persona/product refs + global style refs (mood board)
      const characterProductUrls = selectedRefs.map((r) => r.fal_url).filter(Boolean)
      const styleUrls = styleRefs.map((r) => r.fal_url).filter(Boolean)
      const refUrls = [...characterProductUrls, ...styleUrls]

      // Storyboard mode = ONE grid image built from all 9 panels.
      // Per-shot mode = single image from this shot's image_prompt.
      const rawPrompt = shot.raw.panels
        ? buildStoryboardGridPrompt(shot.raw.panels, globalConfig.ar, shot.raw.concept, {
            skipDialog: !!globalConfig.skipDialog,
            skipOnscreen: !!globalConfig.skipOnscreen,
            skipProduct: !!globalConfig.skipProduct,
          })
        : (shot.raw.image_prompt || shot.raw.shot_label)
      // Apply style preset (UGC/animation/3D/cinematic_ad/short_movie/TVC/etc) for higher quality output
      const basePrompt = applyStylePreset(globalConfig.style, rawPrompt)
      // Skip product directive when user opts out — avoids brand packaging injection.
      const noProductHint = globalConfig.skipProduct ? ' NO product, NO brand packaging, NO logo, NO product CTA.' : ''
      const fullPrompt = `${basePrompt}. ${globalConfig.ar} composition. CONTINUITY: keep characters identical to references.${globalConfig.skipProduct ? noProductHint : directive} ${IMG_QUALITY}`
      const imgInput = buildImgInput(globalConfig.imgModel, { prompt: fullPrompt, refUrls, ar: globalConfig.ar })
      const imgResult = await falRun(globalConfig.imgModel, imgInput, { onProgress: (p) => patchShot(idx, { image: { status: p } }), workspaceId })
      const imageUrl = imgResult.images?.[0]?.url
      if (!imageUrl) throw new Error('no image URL returned')
      patchShot(idx, { image: { status: 'done', url: imageUrl } })
    } catch (e) {
      patchShot(idx, { image: { status: 'error', error: String(e?.message || e) } })
    }
  }

  async function genVideoForShot(idx) {
    const shot = state.shots[idx]
    if (!shot || !shot.image?.url) return
    patchShot(idx, { video: { status: 'generating' } })
    try {
      // Video gen also uses combined refs (some models accept reference_urls for char consistency)
      const characterProductUrls = selectedRefs.map((r) => r.fal_url).filter(Boolean)
      const styleUrls = styleRefs.map((r) => r.fal_url).filter(Boolean)
      const refUrls = [...characterProductUrls, ...styleUrls]

      // Storyboard: dialogue = all panel dialogs concatenated; flows across 9 scenes.
      // Per-shot: dialogue = this shot's single line.
      //
      // CONTINUOUS SHOT MODE: when user enables `continuousShot`, revert to v2's
      // minimal prompt — no "multi-scene / 9 panels" language, no dialog
      // concatenation. Just video_motion + stability. Video model interprets the
      // grid as one reference image and produces a continuous take instead of
      // cutting between 9 scenes.
      //
      // The grid image is still used as start frame (carries the visual story),
      // but the *prompt* no longer commands the model to "transition through 9
      // distinct scenes" — that command was the cause of the cuts in v3.
      let motion
      if (shot.raw.panels) {
        const continuous = globalConfig.continuousShot
        const allDialogs = (globalConfig.skipDialog
          ? []
          : shot.raw.panels.map((p) => p.dialog).filter(Boolean)).join(' ')

        if (continuous) {
          // v2-style minimal prompt — let the start frame (grid) carry the visual
          // story; the prompt only adds motion/style direction.
          const flow = (shot.raw.video_motion || 'Natural cinematic motion, smooth continuous take').replace(/9 (panels?|beats?|scenes?|storyboards?)/gi, '').replace(/multi-scene/gi, '')
          motion = allDialogs && !globalConfig.skipDialog
            ? `${flow}. Single continuous take, no cuts. The subject speaks in fluent native ${globalConfig.lang}: "${allDialogs}". ${VID_STABILITY}`
            : `${flow}. Single continuous take, no cuts, no scene changes. ${VID_STABILITY}`
        } else {
          // Original multi-scene behaviour (still works fine if user wants distinct cuts).
          const flow = shot.raw.video_motion || 'Smooth transitions through 9 storyboard scenes'
          motion = allDialogs
            ? `${flow}. Continuous multi-scene sequence flowing through 9 storyboard panels in order. The narrator/subjects speak naturally in ${globalConfig.lang}: "${allDialogs}". ${VID_STABILITY}`
            : `${flow}. Continuous sequence through 9 storyboard panels. ${VID_STABILITY}`
        }
      } else {
        const dialogue = globalConfig.skipDialog ? null : shot.raw.dialogue
        motion = dialogue
          ? `${shot.raw.video_motion}. The subject speaks in fluent native ${globalConfig.lang}: "${dialogue}". ${VID_STABILITY}`
          : `${shot.raw.video_motion || 'Natural cinematic motion'}. ${VID_STABILITY}`
      }
      // Apply style preset to motion as well (animation style, cinematic, etc influence camera + render style)
      motion = applyStylePreset(globalConfig.style, motion)
      const vidInput = buildVidInput(globalConfig.vidModel, {
        prompt: motion, image_url: shot.image.url, reference_urls: refUrls,
        duration: shot.raw.duration || 5, aspect_ratio: globalConfig.ar,
      })
      const vidResult = await falRun(globalConfig.vidModel, vidInput, { onProgress: (p) => patchShot(idx, { video: { status: p } }), workspaceId, duration: shot.raw.duration || 5 })
      const videoUrl = vidResult.video?.url || vidResult.video
      if (!videoUrl) throw new Error('no video URL returned')

      const { data: row, error } = await supabase.from('results').insert({
        workspace_id: workspaceId, persona_id: persona.id, type: 'video', url: videoUrl, label: shot.label, ar: globalConfig.ar,
        group_label: persona.name,
        meta: { image_url: shot.image.url, raw: shot.raw, source: 'generate' },
        created_by: userId,
      }).select('id').single()
      if (error) throw error
      patchShot(idx, { video: { status: 'done', url: videoUrl, result_id: row.id } })

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
            patchShot(idx, { video: { status: 'done', url: videoUrl, result_id: row.id, cloned_audio_url: j.audio_url } })
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
      patchShot(idx, { video: { status: 'error', error: String(e?.message || e) } })
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
            const next = new Set(state.refIds); next.add(newRef.id)
            onPatch({ refIds: next })
          }}
        />

        <div className="flex flex-wrap gap-2">
          <button onClick={parseNaskah} disabled={state.busy || !state.naskah.trim()}
            className="px-4 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold hover:bg-[var(--border)] disabled:opacity-50">
            🤖 Parse with Gemini
          </button>
          {state.shots.length > 0 && (() => {
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
          {imageDoneCount > 0 && (() => {
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
              📝 {globalConfig.mode === 'storyboard' ? 'Storyboard — edit 9 panel, gen grid, approve, gen video' : 'Shots — edit text, gen image, approve, gen video'}
            </div>
            {state.shots.map((shot, i) => (
              shot.raw.panels
                ? <StoryboardEditor key={shot.id} shot={shot} idx={i} ar={globalConfig.ar}
                    onChangeRaw={(key, value) => patchShotRaw(i, key, value)}
                    onChangePanel={(pi, key, value) => patchPanel(i, pi, key, value)}
                    onGenImage={() => genImageForShot(i)}
                    onGenVideo={() => genVideoForShot(i)}
                    onApprove={(v) => patchShot(i, { approved: v })}
                    onRename={(label) => { patchShot(i, { label }); renameResult(shot.video?.result_id, label) }}
                    onSendQC={() => sendToQC(i)}
                    onDelete={() => deleteResult(i, shot.video?.result_id)} />
                : <ShotEditor key={shot.id} shot={shot} idx={i}
                    onChangeRaw={(key, value) => patchShotRaw(i, key, value)}
                    onGenImage={() => genImageForShot(i)}
                    onGenVideo={() => genVideoForShot(i)}
                    onApprove={(v) => patchShot(i, { approved: v })}
                    onRename={(label) => { patchShot(i, { label }); renameResult(shot.video?.result_id, label) }}
                    onSendQC={() => sendToQC(i)}
                    onDelete={() => deleteResult(i, shot.video?.result_id)} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ShotEditor({ shot, idx, onChangeRaw, onGenImage, onGenVideo, onApprove, onRename, onSendQC, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(shot.label || '')
  const imgStatus = shot.image?.status || 'idle'
  const vidStatus = shot.video?.status || 'idle'

  return (
    <div className={`bg-[var(--surface2)] border rounded p-3 ${shot.approved ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
      <div className="flex items-start gap-3">
        {/* Image preview (left) */}
        <div className="w-32 flex-shrink-0">
          <div className="aspect-[9/16] bg-black rounded overflow-hidden border border-[var(--border)] relative">
            {shot.video?.url ? (
              <video src={shot.video.url} controls muted loop playsInline preload="none" className="w-full h-full object-cover" />
            ) : shot.image?.url ? (
              <img src={shot.image.url} alt="" loading="lazy" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[10px] text-[var(--muted)] text-center p-2">
                {imgStatus === 'idle' ? 'no image yet' : imgStatus}
              </div>
            )}
            {imgStatus !== 'idle' && imgStatus !== 'done' && imgStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[9px] bg-black/80 text-white px-1.5 py-0.5 rounded truncate">⏳ {imgStatus}</div>
            )}
            {vidStatus !== 'idle' && vidStatus !== 'done' && vidStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[9px] bg-orange-600 text-white px-1.5 py-0.5 rounded truncate">🎬 {vidStatus}</div>
            )}
            {imgStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[9px] bg-red-700 text-white px-1.5 py-0.5 rounded">⚠ {shot.image.error?.slice(0, 50)}</div>
            )}
            {vidStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[9px] bg-red-700 text-white px-1.5 py-0.5 rounded">⚠ {shot.video.error?.slice(0, 50)}</div>
            )}
          </div>

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

          <FieldRow label="📷 Image Prompt">
            <textarea rows={2} value={shot.raw.image_prompt || ''} onChange={(e) => onChangeRaw('image_prompt', e.target.value)}
              placeholder="English scene + lighting + camera..."
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </FieldRow>
          <FieldRow label="🎥 Video Motion">
            <textarea rows={2} value={shot.raw.video_motion || ''} onChange={(e) => onChangeRaw('video_motion', e.target.value)}
              placeholder="English motion + camera movement, max 20 kata"
              className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
          </FieldRow>
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <FieldRow label="💬 Dialog (di bahasa yang dipilih)">
              <textarea rows={2} value={shot.raw.dialogue || ''} onChange={(e) => onChangeRaw('dialogue', e.target.value)}
                placeholder='"Dialog karakter di sini..."'
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] resize-y" />
            </FieldRow>
            <FieldRow label="⏱ Detik">
              <input type="number" min={1} max={15} value={shot.raw.duration || 5} onChange={(e) => onChangeRaw('duration', parseInt(e.target.value) || 5)}
                className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
            </FieldRow>
          </div>
        </div>
      </div>
    </div>
  )
}

function StoryboardEditor({ shot, idx, ar, onChangeRaw, onChangePanel, onGenImage, onGenVideo, onApprove, onRename, onSendQC, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(shot.label || '')
  const [showPanels, setShowPanels] = useState(true)
  const imgStatus = shot.image?.status || 'idle'
  const vidStatus = shot.video?.status || 'idle'
  const panels = shot.raw.panels || []
  const totalSec = panels.reduce((s, p) => s + (parseInt(p.seconds) || 2), 0)
  const aspectClass = ar === '16:9' ? 'aspect-video' : ar === '1:1' ? 'aspect-square' : 'aspect-[9/16]'

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
            {shot.video?.url ? (
              <video src={shot.video.url} controls muted loop playsInline preload="none" className="w-full h-full object-cover" />
            ) : shot.image?.url ? (
              <img src={shot.image.url} alt="" loading="lazy" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[10px] text-[var(--muted)] text-center p-2">
                {imgStatus === 'idle' ? 'no grid yet — klik 🖼 Gen Grid' : imgStatus}
              </div>
            )}
            {imgStatus !== 'idle' && imgStatus !== 'done' && imgStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[10px] bg-black/80 text-white px-1.5 py-0.5 rounded truncate">⏳ img: {imgStatus}</div>
            )}
            {vidStatus !== 'idle' && vidStatus !== 'done' && vidStatus !== 'error' && (
              <div className="absolute bottom-1 left-1 right-1 text-[10px] bg-orange-600 text-white px-1.5 py-0.5 rounded truncate">🎬 vid: {vidStatus}</div>
            )}
            {imgStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[10px] bg-red-700 text-white px-1.5 py-0.5 rounded">⚠ {shot.image.error?.slice(0, 60)}</div>
            )}
            {vidStatus === 'error' && (
              <div className="absolute inset-x-1 bottom-1 text-[10px] bg-red-700 text-white px-1.5 py-0.5 rounded">⚠ {shot.video.error?.slice(0, 60)}</div>
            )}
          </div>

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

  function onFilePicked(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setPendingFile(f)
    setPLabel('')
    setPKnowledge('')
    setPKind('character')
    setOpening(true)
    e.target.value = ''
  }

  async function savePending() {
    if (!pendingFile) return
    setBusy(true); onErr('')
    try {
      const ext = (pendingFile.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `${workspaceId}/ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, pendingFile, { upsert: false, contentType: pendingFile.type })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
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

        <button type="button" onClick={() => fileRef.current?.click()}
          className="w-[88px] rounded border-2 border-dashed border-[var(--border)] flex flex-col items-center justify-center gap-1 text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          style={{ height: 116 }}>
          <span className="text-2xl">+</span>
          <span className="text-[9px] font-semibold">Upload</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFilePicked} />
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
                    ? 'TEKS KEMASAN: "AceKid", "Activegro", "3+ Years"\nWARNA: kaleng biru-kuning, tutup biru\nATURAN: kaleng tegak, logo hadap kamera\nVARIAN: 130g / 400g'
                    : 'Catatan karakter: ekspresi, pose default, dll.'}
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
      const ext = (f.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `${workspaceId}/style-${Date.now()}-${Math.random().toString(36).slice(2,6)}.${ext}`
      const { error: upErr } = await supabase.storage.from('refs').upload(path, f, { contentType: f.type, cacheControl: '3600' })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
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
