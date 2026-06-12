// F CREATOR pipeline engine — runs one naskah end-to-end in the browser:
//   parse → gen (per mode, with KONTI chaining) → assemble (AI edit plan +
//   ffmpeg.wasm render + subtitles) → optional voice swap → results row (QC).
//
// Design rules:
// - REUSE Generate's battle-tested prompt machinery (compiler layers, IMAGE
//   ROLES r2v block, rigid-product directive) — copied as lean equivalents,
//   NOT imported from GenerateClient (that's a 2700-line UI component).
// - Every stage reports through onStage(patch) so the UI card updates live
//   and the run is persisted after each stage (resume-safe).
// - A stage failure marks THIS naskah ⚠ and the factory moves on — no
//   silent skips, no batch-killing throws.

import {
  falRun, buildImgInput, buildVidInput, buildStoryboardGridPrompt,
  getVideoMaxDuration,
} from '@/lib/fal-client'
import { compileImagePrompt, compileVideoPrompt } from '../../generate/_lib/prompt-compiler'
import { DEFAULT_CAMERA, getCameraPreset } from '@/lib/camera-presets'
import { productNotesShort } from '@/lib/identity'
import { uploadBlob } from '@/lib/upload-client'
import { compilePlanToProject, probeDurations } from '@/lib/ai-edit-compose'

// ── ffmpeg.wasm MUTEX ──────────────────────────────────────────────────
// ffmpeg.wasm is a SINGLETON with a shared virtual FS and fixed filenames
// (v0.mp4, swap-in.mp4, ta-in.mp4...). Two naskah hitting it concurrently
// corrupt each other's files. Gen stages (fal/Gemini) parallelize freely;
// anything ffmpeg-bound (assemble render, audio extract, frame extract,
// voice mux) takes this lock and queues. Gen is 90% of wall-clock, so the
// queue is rarely felt.
let _ffq = Promise.resolve()
function withFfmpegLock(fn) {
  const run = _ffq.then(fn, fn)
  _ffq = run.catch(() => {})
  return run
}

const toStr = (v) => {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join(', ')
  if (typeof v === 'object') return Object.values(v).map(toStr).filter(Boolean).join(', ')
  return String(v)
}

function uid() { return Math.random().toString(36).slice(2, 10) }

// Per-shot mode can't run reference-to-video (it has a start image); coerce
// to the same family's i2v so the user's model choice survives mode quirks.
const R2V_TO_I2V = {
  'xai/grok-imagine-video/reference-to-video': 'xai/grok-imagine-video/image-to-video',
  'bytedance/seedance-2.0/fast/reference-to-video': 'bytedance/seedance-2.0/fast/image-to-video',
  'alibaba/happy-horse/reference-to-video': 'alibaba/happy-horse/image-to-video',
  'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video': 'fal-ai/kling-video/v3/standard/image-to-video',
  'fal-ai/bytedance/seedance/v1/lite/reference-to-video': 'fal-ai/bytedance/seedance/v1/lite/image-to-video',
}
const I2V_TO_R2V = {
  'xai/grok-imagine-video/image-to-video': 'xai/grok-imagine-video/reference-to-video',
  'xai/grok-imagine-video/v1.5/image-to-video': 'xai/grok-imagine-video/reference-to-video',
  'bytedance/seedance-2.0/fast/image-to-video': 'bytedance/seedance-2.0/fast/reference-to-video',
  'alibaba/happy-horse/image-to-video': 'alibaba/happy-horse/reference-to-video',
  'fal-ai/kling-video/v3/standard/image-to-video': 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video',
  'fal-ai/kling-video/v3/pro/image-to-video': 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video',
  'fal-ai/kling-video/o3/standard/image-to-video': 'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video',
}
export function effectiveVidModel(vidModel, mode) {
  const isRef = vidModel.includes('reference-to-video') || vidModel.includes('ref-to-video')
  if (mode === 'direct' && !isRef) return I2V_TO_R2V[vidModel] || 'xai/grok-imagine-video/reference-to-video'
  if (mode !== 'direct' && isRef) return R2V_TO_I2V[vidModel] || 'xai/grok-imagine-video/image-to-video'
  return vidModel
}

// ── Stage 1: parse naskah → shots (same shapes Generate uses) ─────────
export async function stageParse(item, cfg) {
  const res = await fetch('/api/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      naskah: item.naskah, lang: cfg.lang, mode: cfg.mode, ar: cfg.ar,
      refLabels: cfg.refs.map((r) => r.label).filter(Boolean),
      brand: cfg.brand ? { notes: cfg.brand.notes, config: cfg.brand.config } : null,
      constraints: {
        continuousShot: !!cfg.noCuts,
        skipDialog: !!cfg.noDialog,
        skipOnscreen: !!cfg.noText,
        skipProduct: !!cfg.noProduct,
      },
      // Target duration drives shot math: "20 detik" in the naskah TEXT is
      // a wish the LLM may ignore — this field is the machine contract.
      shotCount: cfg.shotCount
        || (cfg.targetDuration ? Math.max(1, Math.min(8, Math.round(cfg.targetDuration / (cfg.duration || 5)))) : null),
    }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'parse failed')

  if (cfg.mode === 'storyboard') {
    const panels = data.parsed.panels || []
    if (!panels.length) throw new Error('parser balikin 0 panel')
    return [{
      id: uid(),
      raw: {
        concept: toStr(data.parsed.concept),
        environment: toStr(data.parsed.environment),
        wardrobe: toStr(data.parsed.wardrobe),
        video_motion: toStr(data.parsed.video_motion),
        panels: panels.map((p) => ({
          n: p.n, title: p.title || '', visual: p.visual || p.scene || '',
          dialog: p.dialog || '', onscreen: p.onscreen || '', seconds: p.seconds || 2,
          shot_type: p.shot_type || '', chars_in_shot: p.chars_in_shot || [],
        })),
        duration: panels.reduce((s, p) => s + (parseInt(p.seconds) || 2), 0) || 15,
      },
      label: 'Storyboard',
      image: null, video: null,
    }]
  }

  const items = data.parsed.shots || []
  if (!items.length) throw new Error('parser balikin 0 shot')
  const sharedEnv = toStr(data.parsed.environment)
  const sharedWardrobe = toStr(data.parsed.wardrobe)
  // Duration allocation: with a target, each shot gets target/n (clamped
  // 3-15s) so the SUM hits the target — parser's own duration guesses and
  // the per-shot config can't overshoot it anymore (the "naskah bilang 20
  // detik, hasil 30 detik" bug).
  const perShotAlloc = cfg.targetDuration
    ? Math.max(3, Math.min(15, Math.round(cfg.targetDuration / items.length)))
    : null
  return items.map((it, i) => ({
    id: uid(),
    raw: {
      image_prompt: toStr(it.image_prompt),
      video_motion: toStr(it.video_motion),
      dialogue: toStr(it.dialogue),
      environment: sharedEnv,
      wardrobe: sharedWardrobe,
      duration: perShotAlloc || Math.min(it.duration || cfg.duration || 5, cfg.duration || 15),
    },
    label: `Shot ${it.shot || i + 1}`,
    image: null, video: null,
  }))
}

// ── shared prompt context ──────────────────────────────────────────────
function promptCtx(cfg) {
  const characterProductUrls = cfg.refs.map((r) => r.fal_url).filter(Boolean)
  const productKnowledge = cfg.refs.map((r) => String(r.knowledge || '').trim()).filter(Boolean).join('\n')
  const identity = cfg.persona?.character_prompt
    ? `${cfg.persona.name} (${cfg.persona.character_prompt.slice(0, 200)})`
    : null
  const brand = !cfg.noProduct ? productNotesShort(productKnowledge || cfg.brand?.notes) : null
  // Camera preset = L1 of the compiler (highest priority) — THE style lock.
  // Custom presets can carry their own mood-board (style_ref_urls); those
  // ride along as trailing style refs, exactly like Generate does.
  const camera = cfg.cameraPreset || DEFAULT_CAMERA
  const userPresets = cfg.userPresets || []
  const cam = getCameraPreset(camera, userPresets)
  const styleUrls = Array.isArray(cam?.style_ref_urls) ? cam.style_ref_urls.filter(Boolean) : []
  return { characterProductUrls, identity, brand, camera, userPresets, styleUrls }
}

// ── Stage 2a: gen image for one shot ──────────────────────────────────
export async function stageImage(shot, cfg, deps, onProgress) {
  const { characterProductUrls, identity, brand, camera, userPresets, styleUrls } = promptCtx(cfg)
  const isGrid = !!shot.raw.panels
  const gridHeader = isGrid
    ? buildStoryboardGridPrompt(shot.raw.panels, cfg.ar, shot.raw.concept, {
        skipDialog: !!cfg.noDialog, skipOnscreen: !!cfg.noText, skipProduct: !!cfg.noProduct,
      })
    : null
  const fullPrompt = compileImagePrompt({
    camera,
    identity,
    wardrobe: String(shot.raw.wardrobe || '').trim() || null,
    environment: shot.raw.environment || null,
    action: isGrid ? null : (shot.raw.image_prompt || shot.label),
    brand,
    ar: cfg.ar,
    skipProduct: !!cfg.noProduct,
    continuousShot: !!cfg.noCuts,
    refsCount: characterProductUrls.length,
    styleRefsCount: styleUrls.length,
    gridHeader,
    userPresets,
  })
  // Style refs LAST — compiler's "the last N images are style references"
  // claim must be literally true to the model.
  const imgInput = buildImgInput(cfg.imgModel, { prompt: fullPrompt, refUrls: [...characterProductUrls, ...styleUrls], ar: cfg.ar })
  const out = await falRun(cfg.imgModel, imgInput, { onProgress, workspaceId: deps.workspaceId })
  const url = out.images?.[0]?.url
  if (!url) throw new Error('no image URL returned')
  return url
}

// ── Stage 2b: gen video for one shot ──────────────────────────────────
// chainFrameUrl: KONTI — last frame of the previous shot's video (per-shot
// mode uses it as the START FRAME; direct mode appends it as a continuation
// reference). Carries the same IMAGE ROLES + rigid-product directives that
// fixed Generate's r2v drift.
export async function stageVideo(shot, cfg, deps, { imageUrl, chainFrameUrl }, onProgress) {
  const { characterProductUrls, identity, brand, camera, userPresets, styleUrls } = promptCtx(cfg)
  const vidModel = effectiveVidModel(cfg.vidModel, cfg.mode)
  const isRefVid = vidModel.includes('reference-to-video') || vidModel.includes('ref-to-video')
  const isGrid = !!shot.raw.panels

  const userMotion = shot.raw.video_motion
    || (isGrid ? 'Smooth motion through the storyboard moments in order.' : 'Natural cinematic motion.')
  const constrained = cfg.noCuts ? `${userMotion} Single continuous take, no cuts.` : userMotion
  const dialogs = cfg.noDialog ? '' : (isGrid
    ? (shot.raw.panels || []).map((p) => p.dialog).filter(Boolean).join(' ')
    : (shot.raw.dialogue || ''))
  const action = dialogs
    ? `${constrained} The subject speaks in fluent native ${cfg.lang}: "${dialogs}"`
    : constrained

  const motion = compileVideoPrompt({
    camera,
    identity,
    wardrobe: String(shot.raw.wardrobe || '').trim() || null,
    environment: shot.raw.environment || null,
    action,
    brand,
    ar: cfg.ar,
    skipProduct: !!cfg.noProduct,
    continuousShot: !!cfg.noCuts,
    refsCount: characterProductUrls.length + styleUrls.length,
    userPresets,
  })

  let finalMotion = motion
  const vidRefUrls = [...characterProductUrls, ...styleUrls]
  if (isRefVid && chainFrameUrl) vidRefUrls.push(chainFrameUrl)

  if (isRefVid && vidRefUrls.length > 0) {
    // Same structured IMAGE ROLES block that fixed Generate r2v (anti
    // "animate the ref background" / "drop the product" / "ignore no-cuts").
    const roleLines = []
    let imgIdx = 1
    for (const r of cfg.refs) {
      if (!r.fal_url) continue
      if (r.kind === 'product') {
        roleLines.push(`- Image ${imgIdx} = THE PRODUCT (${r.label || 'product'}). It MUST physically appear in the video with accurate shape, colors, ports and label text. If this image shows multiple angles, they are views of ONE single product — NEVER show the multi-angle sheet layout itself in the output.`)
      } else {
        roleLines.push(`- Image ${imgIdx} = character IDENTITY only (face, hair, body, skin tone${r.label ? ` — ${r.label}` : ''}). COMPLETELY IGNORE this image's background, room, location, pose, lighting and composition.`)
      }
      imgIdx++
    }
    for (let s = 0; s < styleUrls.length; s++) {
      roleLines.push(`- Image ${imgIdx} = art style / visual tone reference only — match its aesthetic, do NOT borrow its subjects or location.`)
      imgIdx++
    }
    if (chainFrameUrl) {
      roleLines.push(`- Image ${imgIdx} = final frame of the PREVIOUS shot — the first second of output must continue smoothly from it (same setting, pose flows naturally).`)
    }
    finalMotion = `IMAGE ROLES:
${roleLines.join('\n')}

HARD RULES:
- Build the scene FRESH from the BRIEF below. DO NOT animate any reference image. DO NOT reuse any reference image's background, room, or location — the setting comes ONLY from the brief.
- Every character and product listed above MUST appear in the video as described in the brief.${cfg.noCuts ? `
- SINGLE CONTINUOUS TAKE: one uninterrupted shot, ONE location, NO cuts, NO scene changes, NO camera switches, NO transitions, NO time jumps.` : ''}

BRIEF:
${motion}`
  }
  if (!cfg.noProduct && brand) {
    finalMotion += `

PRODUCT FIDELITY (critical): the product is a RIGID manufactured object — its shape, proportions, port/button layout, colors and label text must stay IDENTICAL to the first frame in EVERY frame. No warping, no morphing, no melting, no re-imagined details, no gibberish text on the label. Keep the product itself mostly static; movement comes from the camera and the person, never from the product deforming.`
  }

  const maxDur = getVideoMaxDuration(vidModel)
  const dur = Math.min(maxDur, shot.raw.duration || cfg.duration || 5)
  // Per-shot start frame priority: KONTI chain frame > shot's own image.
  const startImage = isRefVid ? undefined : (chainFrameUrl || imageUrl)
  const vidInput = buildVidInput(vidModel, {
    prompt: finalMotion,
    image_url: startImage,
    reference_urls: vidRefUrls,
    duration: dur,
    aspect_ratio: cfg.ar,
  })
  const out = await falRun(vidModel, vidInput, { onProgress, workspaceId: deps.workspaceId, duration: dur })
  const url = out.video?.url || out.video
  if (!url) throw new Error('no video URL returned')
  return url
}

// ── KONTI helper: last frame of a video → public URL ──────────────────
export async function chainFrameFromVideo(videoUrl) {
  return withFfmpegLock(async () => {
    const { extractLastFrame } = await import('@/lib/ffmpeg-extract')
    const blob = await extractLastFrame(videoUrl)
    const { url } = await uploadBlob(blob, `fcreator-chain-${Date.now()}.jpg`, 'continuation')
    return url
  })
}

// ── Stage 3: assemble — AI edit plan + subtitles + browser render ─────
export async function stageAssemble(item, videoUrls, cfg, deps, onProgress) {
  onProgress?.('Baca durasi clips...')
  const videos = await probeDurations(videoUrls.map((u, i) => ({ url: u, label: `${item.label} — shot ${i + 1}` })))

  // Single clip + no editing requested → the raw video IS the final.
  const wantsEdit = cfg.autoEdit.transitions || cfg.autoEdit.hook || cfg.autoEdit.subtitle
  if (videos.length === 1 && !wantsEdit) return { url: videoUrls[0], assembled: false }

  onProgress?.('AI nyusun timeline...')
  const composePrompt = [
    `Susun ${videos.length} clip ini JADI SATU video, PERTAHANKAN urutan clip persis seperti diberikan (jangan re-order, jangan drop).`,
    'Trim hanya jika ada dead-air jelas di awal/akhir clip; default pakai full durasi.',
    cfg.autoEdit.transitions ? 'Kasih transisi crossfade 0.4s antar clip.' : 'Transisi: cut polos antar clip.',
    cfg.autoEdit.hook ? `Tambahkan SATU hook text (2-4 kata, bahasa ${cfg.lang}) di 0-2.5 detik pertama, posisi top, style tiktok — angkat dari inti naskah ini: "${item.naskah.slice(0, 200)}"` : 'Jangan tambahkan text overlay apapun.',
    cfg.targetDuration ? `Total durasi final harus sedekat mungkin dengan ${cfg.targetDuration} detik.` : '',
    'Jangan set auto_subtitle (subtitle ditangani sistem terpisah). Jangan tambah text selain yang diminta.',
  ].filter(Boolean).join(' ')
  const res = await fetch('/api/editor/ai-compose', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: composePrompt, videos }),
  })
  const j = await res.json().catch(() => ({ ok: false, error: 'non-json' }))
  if (!j.ok) throw new Error(j.error || 'ai-compose failed')
  j.plan.auto_subtitle = false
  // maxTrimPct caps LLM over-trimming (broken-jump-cut feel) at 25% per end
  const project = compilePlanToProject(j.plan, videos, { ar: cfg.ar, maxTrimPct: 0.25 })
  project.name = item.label

  // Everything from here uses ffmpeg.wasm (audio extract + final render) —
  // single-instance, so concurrent naskah queue on the lock.
  return withFfmpegLock(async () => {
  // Subtitles — deterministic, headless (audio-first transcription).
  if (cfg.autoEdit.subtitle) {
    const { extractAudioForTranscribe } = await import('@/lib/swap-audio')
    const base = project.video_clips
      .filter((c) => (c.track_idx || 0) === 0)
      .sort((a, b) => (a.in_track || 0) - (b.in_track || 0))
    const subs = []
    for (let i = 0; i < base.length; i++) {
      const clip = base[i]
      try {
        onProgress?.(`Subtitle clip ${i + 1}/${base.length}...`)
        let tUrl = clip.src_url
        try {
          const aBlob = await extractAudioForTranscribe(clip.src_url)
          const up = await uploadBlob(aBlob, `fcreator-tr-${Date.now()}-${i}.mp3`, 'transcribe-audio')
          tUrl = up.url
        } catch { /* fall back to video url (small clips pass inline cap) */ }
        const tr = await fetch('/api/transcribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: tUrl }),
        })
        const td = await tr.json().catch(() => ({ ok: false }))
        if (!td.ok || !td.segments?.length) continue
        const offset = clip.in_track || 0
        for (const s of td.segments) {
          subs.push({
            id: uid(), kind: 'text', text: String(s.text || '').toUpperCase(),
            start: offset + (parseFloat(s.start) || 0),
            end: offset + (parseFloat(s.end) || (parseFloat(s.start) || 0) + 1.5),
            track_idx: 1,
            x_pct: 50, y_pct: 75, size: 56, scale: 1, max_width_pct: 90,
            color: '#ffffff', weight: 900,
            bg: 'rgba(0,0,0,0.85)', align: 'center', animation: 'fade',
          })
        }
      } catch { /* subtitle failure is non-fatal — keep assembling */ }
    }
    project.text_clips = [...(project.text_clips || []), ...subs]
  }

  onProgress?.('Render final (ffmpeg)...')
  const { renderProject } = await import('@/lib/editor-render')
  const { blob, ext } = await renderProject(project, (s) => onProgress?.(`Render: ${s}`), { mode: 'mp4' })
  onProgress?.(`Upload ${(blob.size / 1024 / 1024).toFixed(1)}MB...`)
  const { url } = await uploadBlob(blob, `fcreator-${Date.now()}.${ext || 'mp4'}`, 'f-creator')
  return { url, assembled: true }
  })
}

// ── Stage 4 (optional): voice swap to persona cloned voice ────────────
export async function stageVoice(videoUrl, cfg, onProgress) {
  if (!cfg.persona?.voice_id) throw new Error('persona belum punya voice')
  onProgress?.('ElevenLabs S2S...')
  const res = await fetch('/api/voice/convert', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, voice_id: cfg.persona.voice_id }),
  })
  const j = await res.json().catch(() => ({ ok: false, error: 'non-json' }))
  if (!j.ok) throw new Error(j.error || 'voice convert failed')
  onProgress?.('Mux cloned voice...')
  return withFfmpegLock(async () => {
    const { swapAudioInVideo } = await import('@/lib/swap-audio')
    const blob = await swapAudioInVideo(videoUrl, j.audio_url, onProgress)
    const up = await uploadBlob(blob, `fcreator-voiced-${Date.now()}.mp4`, 'f-creator')
    return { url: up.url, cloned_audio_url: j.audio_url }
  })
}

// ── Full pipeline for ONE naskah ───────────────────────────────────────
// onStage(patch) merges into the item card; shouldStop() lets Pause cut in
// between stages (never mid-fal-call — those finish + get persisted).
export async function runNaskahPipeline(item, cfg, deps, onStage, shouldStop) {
  const fail = (stage, e) => {
    onStage({ stage: 'error', error: `${stage}: ${String(e?.message || e).slice(0, 300)}` })
    return false
  }

  // 1. PARSE (skip if resumed past it)
  let shots = item.shots?.length ? item.shots : null
  if (!shots) {
    onStage({ stage: 'parse', detail: 'Parsing naskah...' })
    try { shots = await stageParse(item, cfg) } catch (e) { return fail('parse', e) }
    onStage({ shots, detail: `${shots.length} shot` })
  }
  if (shouldStop()) return false

  const isDirect = cfg.mode === 'direct'

  // 2. IMAGES (per-shot & storyboard; direct skips). KONTI per-shot: only
  // shot 1 needs an image — shots 2+ start from the previous video's last
  // frame (true chain, cheaper + maximum continuity).
  if (!isDirect) {
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].image?.url) continue
      if (cfg.konti && i > 0 && cfg.mode === 'shots') continue
      if (shouldStop()) return false
      onStage({ stage: 'images', detail: `Image ${i + 1}/${shots.length}...` })
      try {
        const url = await stageImage(shots[i], cfg, deps, (p) => onStage({ detail: `Image ${i + 1}: ${p}` }))
        shots[i] = { ...shots[i], image: { url } }
        onStage({ shots: [...shots] })
      } catch (e) { return fail(`image shot ${i + 1}`, e) }
    }
  }

  // 3. VIDEOS — sequential; KONTI extracts last frame between shots.
  let chainFrame = null
  for (let i = 0; i < shots.length; i++) {
    if (shots[i].video?.url) {
      if (cfg.konti) { try { chainFrame = await chainFrameFromVideo(shots[i].video.url) } catch { chainFrame = null } }
      continue
    }
    if (shouldStop()) return false
    onStage({ stage: 'videos', detail: `Video ${i + 1}/${shots.length}...` })
    try {
      const url = await stageVideo(shots[i], cfg, deps, {
        imageUrl: shots[i].image?.url,
        chainFrameUrl: cfg.konti && i > 0 ? chainFrame : null,
      }, (p) => onStage({ detail: `Video ${i + 1}: ${p}` }))
      shots[i] = { ...shots[i], video: { url } }
      onStage({ shots: [...shots] })
      if (cfg.konti && i < shots.length - 1) {
        onStage({ detail: `Extract frame konti ${i + 1}...` })
        try { chainFrame = await chainFrameFromVideo(url) } catch { chainFrame = null }
      }
    } catch (e) { return fail(`video shot ${i + 1}`, e) }
  }

  // 4. ASSEMBLE
  let finalUrl = item.final_url || null
  let assembledMeta = {}
  if (!finalUrl) {
    if (shouldStop()) return false
    onStage({ stage: 'assemble', detail: 'Assembling...' })
    try {
      const out = await stageAssemble(item, shots.map((s) => s.video.url), cfg, deps, (p) => onStage({ detail: p }))
      finalUrl = out.url
      assembledMeta.assembled = out.assembled
      onStage({ final_url: finalUrl })
    } catch (e) { return fail('assemble', e) }
  }

  // 5. VOICE (optional, non-fatal — raw final still lands in QC on failure)
  if (cfg.voiceSwap && cfg.persona?.voice_id && !item.voiced) {
    if (shouldStop()) return false
    onStage({ stage: 'voice', detail: 'Voice swap...' })
    try {
      const v = await stageVoice(finalUrl, cfg, (p) => onStage({ detail: p }))
      finalUrl = v.url
      assembledMeta.cloned_audio_url = v.cloned_audio_url
      onStage({ final_url: finalUrl, voiced: true })
    } catch (e) {
      onStage({ detail: `⚠ voice swap gagal (lanjut tanpa): ${String(e?.message || e).slice(0, 120)}` })
    }
  }

  // 6. RESULTS row → QC
  if (!item.result_id) {
    onStage({ stage: 'qc', detail: 'Setor ke QC...' })
    const { data: row, error } = await deps.supabase.from('results').insert({
      workspace_id: deps.workspaceId,
      persona_id: cfg.persona?.id || null,
      type: 'video', url: finalUrl,
      label: item.label,
      ar: cfg.ar,
      group_label: 'F Creator',
      qc_status: 'pending',
      meta: {
        source: 'f-creator', naskah: item.naskah.slice(0, 500),
        mode: cfg.mode, vid_model: cfg.vidModel, shots: shots.length,
        konti: !!cfg.konti, ...assembledMeta,
      },
      created_by: deps.userId,
    }).select('id').single()
    if (error) return fail('qc insert', error)
    onStage({ result_id: row.id })
  }

  onStage({ stage: 'done', detail: '✓ Siap QC' })
  return true
}
