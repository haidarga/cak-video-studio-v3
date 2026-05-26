import { useState, useRef } from 'react'
import { useStudio } from '../store'
import { falRun, falUpload, buildVidInput, buildImgInput, callGemini, extractJSON, withRetry, sleep } from '../lib/api'
import { buildParsePrompt, autoMapRefs, buildStoryboardGridPrompt, productImageDirective } from '../lib/prompt'
import { STYLE_OPTIONS, VIDEO_MODELS, IMAGE_MODELS, STYLES, isMultiRefImg, videoRatePerSec } from '../lib/constants'
import TemplateSummary from '../components/TemplateSummary'
import RefManager from '../components/RefManager'
import StyleRefPicker from '../components/StyleRefPicker'
import { apiUrl } from '../lib/backend'

const AR_OPTS = ['9:16', '16:9', '1:1']
const RES_OPTS = ['720p', '1080p']
const LANGS = ['Indonesian', 'English', 'Javanese', 'Sundanese', 'Malay', 'Spanish', 'Arabic', 'Mandarin', 'Hindi', 'Portuguese']

export default function PipelineTab() {
  const S = useStudio()
  const { config, setConfig } = S
  const [naskah, setNaskah] = useState('')
  const [shots, setShots] = useState([])
  const [detected, setDetected] = useState([])
  const [parsing, setParsing] = useState(false)
  const [res, setRes] = useState('720p')
  const [log, setLog] = useState([])
  const shotsRef = useRef([])
  shotsRef.current = shots

  const pushLog = (m) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${m}`])
  const patchShot = (id, patch) => setShots((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  async function runParse() {
    if (!naskah.trim()) { S.toast('Tulis naskah dulu bro', 'error'); return }
    setParsing(true); setLog([])
    const at = S.getActiveTemplate()
    if (at) pushLog('🎯 Template ACTIVE — niru: ' + at.name)
    pushLog('🤖 Calling Gemini 2.5 Flash...')
    try {
      const prompt = buildParsePrompt(naskah.trim(), config, {
        refLabels: S.refImages.map((r) => r.label).filter(Boolean),
        activeTemplate: at, activeBrand: S.getActiveBrand(),
      })
      const parsed = extractJSON(await callGemini(prompt, { json: true, onLog: pushLog, maxTokens: 24576 }))
      setDetected(Array.isArray(parsed.characters) ? parsed.characters : [])
      const isStoryParse = config.genMode === 'storyboard'
      const list = (parsed.shots || []).map((s, i) => {
        const panels = Array.isArray(s.panels) ? s.panels : []
        const image_prompt = isStoryParse && panels.length
          ? buildStoryboardGridPrompt(panels, config.ar, parsed.concept)  // assemble precise grid prompt from structured panels
          : String(s.image_prompt || '').trim()
        return {
          ...s, id: 'sh_' + Date.now() + '_' + i,
          shot: s.shot || i + 1,
          panels, image_prompt,
          video_motion: String(s.video_motion || '').trim(),
          dialogue: String(s.dialogue || ''),
          duration: Math.max(2, Math.min(20, +s.duration || (isStoryParse ? 15 : 5))),
          images: [], imageUrl: null, imgModel: '', videoUrl: null, status: 'idle', statusLabel: 'idle',
          chars_in_shot: Array.isArray(s.chars_in_shot) ? s.chars_in_shot : [],
          refIds: autoMapRefs(s.chars_in_shot || [], S.refImages),
        }
      })
      if (!list.length) throw new Error('Gemini gak balikin shot — coba Parse ulang')
      setShots(list)
      const noPrompt = list.filter((s) => !s.image_prompt).length
      if (noPrompt) pushLog(`⚠️ ${noPrompt} shot image_prompt-nya kosong — cek manual sebelum generate`)
      pushLog(`✅ Parsed ${list.length} shots`)
    } catch (e) {
      pushLog('❌ ' + e.message)
      S.toast('Parse failed: ' + e.message, 'error')
    }
    setParsing(false)
  }

  async function genImage(shot) {
    const model = shot.imgModel || config.imgModel
    if (model === 'none') { S.toast(`Shot ${shot.shot}: pilih image model dulu`, 'error'); return }
    if (!shot.image_prompt?.trim()) { S.toast(`Shot ${shot.shot}: image prompt kosong`, 'error'); return }
    patchShot(shot.id, { status: 'running', statusLabel: 'nyiapin reference...' })
    try {
      await S.ensureRefsUploaded() // pastiin semua ref udah ke-upload ke fal sebelum generate
      const styleSuffix = config.style === 'custom' ? config.customStyle : STYLES[config.style] || ''
      const sel = shot.refIds?.length ? S.refImages.filter((r) => shot.refIds.includes(r.id)) : S.refImages
      const refUrls = sel.map((r) => r.falUrl).filter(Boolean)
      if (S.refImages.length && !refUrls.length) {
        pushLog(`⚠️ Shot ${shot.shot}: reference gak kepake — gambar bisa beda dari karakter lo`)
      }
      if (!isMultiRefImg(model) && refUrls.length > 1) {
        pushLog(`⚠️ Shot ${shot.shot}: ${model.split('/')[0]} cuma pake 1 reference (ada ${refUrls.length}). Multi-subjek? pake Nano Banana 2 / GPT Image 2 Edit.`)
      }
      const brand = S.getActiveBrand()
      // product knowledge from the refs linked to this shot (each product carries its own); fall back to brand notes
      const productKnowledge = sel.map((r) => (r.knowledge || '').trim()).filter(Boolean).join('\n')
      // optional style reference image — appended last, used for look/mood only
      const styleNote = config.styleRefUrl ? ' STYLE REFERENCE: the final reference image is a style guide — match its overall aesthetic, lighting, mood and color grade, NOT its content or subjects.' : ''
      const refUrlsAll = config.styleRefUrl ? [...refUrls, config.styleRefUrl] : refUrls
      const fullPrompt = `${shot.image_prompt}. ${styleSuffix}. ${config.ar} composition. CONTINUITY: maintain exact visual style and character appearance from references.${productImageDirective(productKnowledge || brand?.notes)}${styleNote}`
      patchShot(shot.id, { statusLabel: 'generating image...' })
      const runImg = () => falRun(model, buildImgInput(model, { prompt: fullPrompt, refUrls: refUrlsAll, ar: config.ar }), pushLog)
      const result = await withRetry(runImg, 2, 2500)
      const imageUrl = result.images?.[0]?.url
      if (!imageUrl) throw new Error('no image returned')
      const modelLabel = (IMAGE_MODELS.find((m) => m.v === model)?.l || model).split(' ')[0]
      setShots((p) => p.map((s) => (s.id === shot.id
        ? { ...s, images: [...(s.images || []), { url: imageUrl, model: modelLabel }], imageUrl, status: 'done', statusLabel: `image ready (${(s.images || []).length + 1} variant)` }
        : s)))
      S.toast(`Shot ${shot.shot} image done ✓`)
    } catch (e) {
      patchShot(shot.id, { status: 'error', statusLabel: 'image failed' })
      pushLog(`❌ Shot ${shot.shot}: ${e.message}`)
      S.toast('Image gen failed: ' + e.message, 'error')
    }
  }

  async function genVideo(shot) {
    const isRef2v = config.vidModel.includes('reference-to-video')
    const isKlingV3 = config.vidModel.includes('kling-video/') && !config.vidModel.includes('reference-to-video')
    // can we skip Gen Image and start from refs? — true for ref2v models AND Kling (uses first ref as start frame)
    const canSkipImage = isRef2v || (isKlingV3 && S.refImages.length > 0)
    if (!canSkipImage && !shot.imageUrl) { S.toast('Generate / pilih image dulu', 'error'); return }
    patchShot(shot.id, { status: 'running', statusLabel: canSkipImage && !shot.imageUrl ? 'nyiapin reference...' : 'generating video...' })
    try {
      const dlg = (shot.dialogue || '').trim()
      const lang = config.lang || 'Indonesian'
      const motionPrompt = dlg
        ? `${shot.video_motion}. The subject speaks directly to camera in fluent, native ${lang} (NOT English), lips moving in sync, saying exactly: "${dlg}"`
        : shot.video_motion
      // gather refs upfront — needed for ref2v, Kling-fallback, and as `elements` in i2v Kling
      let refUrls = []
      if (isRef2v || isKlingV3) {
        await S.ensureRefsUploaded()
        const sel = shot.refIds?.length ? S.refImages.filter((r) => shot.refIds.includes(r.id)) : S.refImages
        refUrls = sel.map((r) => r.falUrl).filter(Boolean)
      }
      let input
      if (isRef2v) {
        if (!refUrls.length) throw new Error('Reference-to-video butuh minimal 1 reference image — link ref ke shot ini dulu')
        patchShot(shot.id, { statusLabel: 'generating video...' })
        input = buildVidInput(config.vidModel, { prompt: motionPrompt, reference_urls: refUrls, duration: shot.duration, aspect_ratio: config.ar, resolution: res })
      } else if (isKlingV3 && !shot.imageUrl) {
        // Kling fallback — no Gen Image yet, use first ref as start frame, rest as character elements
        if (!refUrls.length) throw new Error('Butuh start image atau reference image — Gen Image dulu atau link ref ke shot')
        patchShot(shot.id, { statusLabel: 'generating video pake ref...' })
        input = buildVidInput(config.vidModel, { prompt: motionPrompt, image_url: refUrls[0], reference_urls: refUrls.slice(1), duration: shot.duration, aspect_ratio: config.ar, resolution: res })
      } else {
        // standard i2v with an explicit start frame; Kling also gets refs as `elements`
        let startImageUrl = shot.imageUrl
        if (startImageUrl.startsWith('blob:') || startImageUrl.startsWith('data:')) {
          const blob = await (await fetch(startImageUrl)).blob()
          startImageUrl = await falUpload(blob, 'frame.jpg')
        }
        input = buildVidInput(config.vidModel, { prompt: motionPrompt, image_url: startImageUrl, reference_urls: refUrls, duration: shot.duration, aspect_ratio: config.ar, resolution: res })
      }
      const result = await withRetry(() => falRun(config.vidModel, input, pushLog), 2, 3000)
      const videoUrl = result.video?.url || result.video
      if (!videoUrl) throw new Error('no video returned — fal: ' + JSON.stringify(result).slice(0, 240))
      patchShot(shot.id, { videoUrl, status: 'done', statusLabel: 'video ready' })
      S.addResult({ url: videoUrl, type: 'video', label: `Shot ${shot.shot}`, ar: config.ar })
      S.toast(`Shot ${shot.shot} video done ✓`)
    } catch (e) {
      patchShot(shot.id, { status: 'error', statusLabel: 'video failed' })
      pushLog(`❌ Shot ${shot.shot}: ${e.message}`)
      S.toast('Video gen failed: ' + e.message, 'error')
    }
  }

  // storyboard → 1 full video: each panel → clean full-frame image → clip → server stitches in order/timing
  async function genFullVideo(shot) {
    if (!shot.panels?.length) { S.toast('Ini bukan storyboard', 'error'); return }
    patchShot(shot.id, { status: 'running', statusLabel: 'nyiapin...' })
    try {
      await S.ensureRefsUploaded()
      const sel = shot.refIds?.length ? S.refImages.filter((r) => shot.refIds.includes(r.id)) : S.refImages
      const refUrls = sel.map((r) => r.falUrl).filter(Boolean)
      const productKnowledge = sel.map((r) => (r.knowledge || '').trim()).filter(Boolean).join('\n')
      const styleSuffix = config.style === 'custom' ? config.customStyle : STYLES[config.style] || ''
      const brand = S.getActiveBrand()
      const styleNote = config.styleRefUrl ? ' STYLE REFERENCE: the final reference image is a style guide — match its aesthetic, lighting and color grade, NOT its content.' : ''
      const refUrlsAll = config.styleRefUrl ? [...refUrls, config.styleRefUrl] : refUrls
      const lang = config.lang || 'Indonesian'
      const panels = shot.panels.slice(0, 9)
      const clips = []
      for (const p of panels) {
        patchShot(shot.id, { statusLabel: `scene ${p.n}/${panels.length}: gambar...` })
        const imgPrompt = `${p.visual}. ${styleSuffix}. ${config.ar} composition. CONTINUITY: keep characters & product identical to references.${productImageDirective(productKnowledge || brand?.notes)}${styleNote}`
        const imgRes = await withRetry(() => falRun(config.imgModel, buildImgInput(config.imgModel, { prompt: imgPrompt, refUrls: refUrlsAll, ar: config.ar })), 2, 2000)
        const imgUrl = imgRes.images?.[0]?.url
        if (!imgUrl) throw new Error(`scene ${p.n}: gambar gagal`)
        patchShot(shot.id, { statusLabel: `scene ${p.n}/${panels.length}: video...` })
        const dlg = (p.dialog || '').trim()
        // calmer camera on product/close-up beats → far less text warping & artifacts
        const st = (p.shot_type || '').toLowerCase()
        const motionHint = (st.includes('close') || st.includes('product'))
          ? 'Minimal, slow and steady camera; the product stays still, undistorted and in sharp focus.'
          : 'Natural, smooth motion; stable framing.'
        const motion = dlg
          ? `${p.visual}. ${motionHint} The subject speaks directly to camera in fluent native ${lang}: "${dlg}"`
          : `${p.visual}. ${motionHint}`
        const vidRes = await withRetry(() => falRun(config.vidModel, buildVidInput(config.vidModel, { prompt: motion, image_url: imgUrl, duration: 5, aspect_ratio: config.ar, resolution: res }), pushLog), 2, 3000)
        const vidUrl = vidRes.video?.url || vidRes.video
        if (!vidUrl) throw new Error(`scene ${p.n}: video gagal`)
        clips.push({ url: vidUrl, trim: Math.max(1, Math.min(5, +p.seconds || 2)) })
      }
      patchShot(shot.id, { statusLabel: 'nyambung jadi 1 video...' })
      const { jobId } = await (await fetch(apiUrl('/api/stitch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips }) })).json()
      let localFile = null
      for (let i = 0; i < 160; i++) {
        await sleep(3000)
        const st = await (await fetch(apiUrl('/api/stitch/' + jobId))).json()
        if (st.status === 'done') { localFile = apiUrl('/api/stitch/' + jobId + '/file'); break }
        if (st.status === 'error') throw new Error('stitch: ' + st.error)
      }
      if (!localFile) throw new Error('stitch timeout')
      // upload the stitched result to fal so it persists & is reusable in Editor/Results
      patchShot(shot.id, { statusLabel: 'upload hasil...' })
      const blob = await (await fetch(localFile)).blob()
      const finalUrl = await falUpload(blob, `storyboard_${shot.shot}_full.mp4`)
      patchShot(shot.id, { status: 'done', statusLabel: `video full jadi (${panels.length} scene) ✓`, videoUrl: finalUrl })
      S.addResult({ url: finalUrl, type: 'video', label: `Storyboard ${shot.shot} — full video`, ar: config.ar })
      S.toast('Video full jadi ✓')
    } catch (e) {
      patchShot(shot.id, { status: 'error', statusLabel: 'gagal bikin video full' })
      pushLog('❌ ' + e.message)
      S.toast('Gagal: ' + e.message, 'error')
    }
  }

  const runAllImages = async () => { for (const s of shotsRef.current) { await genImage(shotsRef.current.find((x) => x.id === s.id)) } }
  const runAllVideos = async () => {
    const r2v = config.vidModel.includes('reference-to-video')
    for (const s of shotsRef.current) {
      const cur = shotsRef.current.find((x) => x.id === s.id)
      if (!cur) continue
      if (!r2v && !cur.imageUrl) continue                 // i2v needs a start frame; ref2v doesn't
      await genVideo(cur)
    }
  }

  const toggleRef = (shotId, refId) => setShots((p) => p.map((s) => {
    if (s.id !== shotId) return s
    const ids = s.refIds || []
    return { ...s, refIds: ids.includes(refId) ? ids.filter((x) => x !== refId) : [...ids, refId] }
  }))

  const at = S.getActiveTemplate()
  const isRef2v = config.vidModel.includes('reference-to-video')
  const isKlingV3 = config.vidModel.includes('kling-video/') && !config.vidModel.includes('reference-to-video')
  const isStory = config.genMode === 'storyboard'

  return (
    <div className="pane active">
      <div className="grid2">
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {at && (
            <div style={{ padding: '12px 14px', background: 'linear-gradient(135deg,rgba(255,60,60,.12),rgba(255,122,60,.08))', border: '1px solid rgba(255,60,60,.25)', borderRadius: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13 }}>🎯 Niru template: <strong>{at.name}</strong></span>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost btn-sm" onClick={() => S.setActiveTab('template')} style={{ padding: '3px 9px' }}>Atur</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 9, lineHeight: 1.5 }}>
                Tulis naskah di bawah → <strong>Parse</strong>. Hasilnya niru hook/format/elemen ini, tapi pake topik &amp; karakter LO:
              </div>
              <TemplateSummary analysis={at.analysis} compact />
            </div>
          )}
          <div className="card">
            <div className="section-title">Naskah / Script</div>
            <textarea rows={8} value={naskah} onChange={(e) => setNaskah(e.target.value)}
              placeholder="Tulis naskah lo disini... bisa Indonesia atau English." />
          </div>

          <div className="card">
            <div className="section-title">Pipeline Settings</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label>Generation Mode</label>
                <div className="pill-group">
                  {[['shots', '🎬 Per-Shot'], ['storyboard', '🗂️ Storyboard 3×3']].map(([v, l]) => (
                    <div key={v} className={'pill' + (config.genMode === v ? ' active' : '')} onClick={() => setConfig({ genMode: v })}>{l}</div>
                  ))}
                </div>
                {isStory && (
                  <div style={{ fontSize: 10.5, color: 'var(--muted2)', marginTop: 6, lineHeight: 1.45 }}>
                    🗂️ Naskah → grid 3×3 (9 scene, format tabel). <strong>Gen Grid</strong> bikin board-nya, <strong>Gen Video</strong> pake grid itu sebagai start frame → 1 video (1x generate, hemat).
                  </div>
                )}
              </div>
              {!isStory && (
                <div>
                  <label>Mode</label>
                  <div className="pill-group">
                    {[['cut_to_cut', 'Cut to Cut'], ['single_take', 'Single Take (15s)']].map(([v, l]) => (
                      <div key={v} className={'pill' + (config.mode === v ? ' active' : '')} onClick={() => setConfig({ mode: v })}>{l}</div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label>Style</label>
                <select value={config.style} onChange={(e) => setConfig({ style: e.target.value })}>
                  {STYLE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
              {config.style === 'custom' && (
                <div><label>Custom Style Suffix</label>
                  <input type="text" value={config.customStyle} onChange={(e) => setConfig({ customStyle: e.target.value })} placeholder="e.g. watercolor, warm tones..." /></div>
              )}
              <StyleRefPicker />
              <div>
                <label>Aspect Ratio <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— berlaku ke semua shot</span></label>
                <div className="pill-group">
                  {AR_OPTS.map((a) => <div key={a} className={'pill' + (config.ar === a ? ' active' : '')} onClick={() => setConfig({ ar: a })}>{a}</div>)}
                </div>
              </div>
              <div>
                <label>Resolution <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— resolusi video</span></label>
                <div className="pill-group">
                  {RES_OPTS.map((r) => <div key={r} className={'pill' + (res === r ? ' active' : '')} onClick={() => setRes(r)}>{r}</div>)}
                </div>
              </div>
              <div>
                <label>🗣️ Bahasa Dialog &amp; Caption</label>
                <select value={config.lang} onChange={(e) => setConfig({ lang: e.target.value })}>
                  {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label>Image Generator <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— default, bisa di-override per shot</span></label>
                <select value={config.imgModel} onChange={(e) => setConfig({ imgModel: e.target.value })}>
                  {IMAGE_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                  <option value="none">Skip (manual)</option>
                </select>
              </div>
              <div>
                <label>Video Generator</label>
                <select value={config.vidModel} onChange={(e) => setConfig({ vidModel: e.target.value })}>
                  {VIDEO_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
                {isRef2v && (
                  <div style={{ fontSize: 10.5, color: '#fcd34d', marginTop: 6, lineHeight: 1.45 }}>
                    🎭 Mode Reference-to-Video — video langsung pake reference image (gak butuh Gen Image). Pastiin ref udah ke-link ke tiap shot.
                  </div>
                )}
                {!isRef2v && isKlingV3 && (
                  <div style={{ fontSize: 10.5, color: 'var(--muted2)', marginTop: 6, lineHeight: 1.45 }}>
                    💡 Kling v3 nerima reference image juga — kalau ref udah aktif, Gen Video bisa langsung tanpa Gen Image dulu (Kling pake ref pertama sebagai start frame, sisanya jadi character elements).
                  </div>
                )}
              </div>
            </div>
          </div>

          <RefManager />

          <button className="btn" onClick={runParse} disabled={parsing} style={{ width: '100%', justifyContent: 'center', padding: 13 }}>
            {parsing ? '⏳ Parsing...' : '🤖 Parse with Gemini'}
          </button>
        </div>

        {/* RIGHT */}
        <div>
          {!shots.length ? (
            <div className="card hero-card">
              <div className="empty-state" style={{ minHeight: 'auto', padding: '18px 10px' }}>
                <div className="es-icon">🎬</div>
                <h3>Naskah → Shot List Otomatis</h3>
                <p>Tulis naskah di kiri, parse dengan Gemini — bakal jadi shot-by-shot lengkap.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="section-title" style={{ marginBottom: 12 }}>
                {isStory ? 'Storyboards' : 'Shot List'} <span className="badge badge-blue">{shots.length} {isStory ? 'grids' : 'shots'}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }} title="Estimasi biaya video (durasi total × rate model)">
                  ≈ ${(shots.reduce((a, s) => a + (s.duration || 5), 0) * videoRatePerSec(config.vidModel, res)).toFixed(2)} video
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  {!isRef2v && <button className="btn btn-ghost btn-sm" onClick={runAllImages}>{isStory ? '🗂️ All Grids' : '🖼️ All Images'}</button>}
                  <button className="btn btn-sm" onClick={runAllVideos}>🎬 All Videos</button>
                </div>
              </div>
              {!!detected.length && (
                <div style={{ marginBottom: 12, padding: 10, background: 'var(--surface2)', borderRadius: 8, fontSize: 11 }}>
                  <span style={{ color: 'var(--muted)' }}>💡 Detected: </span>
                  {detected.map((c) => <span key={c} className="badge badge-blue" style={{ marginRight: 4 }}>{c}</span>)}
                </div>
              )}
              {shots.map((shot) => (
                <div key={shot.id} className="shot-card">
                  <div className="shot-header">
                    <div className="shot-num">{shot.shot}</div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{isStory ? 'Storyboard' : 'Shot'} {shot.shot}</span>
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <input type="number" min={2} max={20} value={shot.duration}
                        onChange={(e) => patchShot(shot.id, { duration: Math.max(2, Math.min(20, +e.target.value || 5)) })}
                        title="Durasi shot ini"
                        style={{ width: 50, padding: '3px 5px', fontSize: 12, textAlign: 'center' }} />
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>detik</span>
                    </span>
                    <span className={'status-dot ' + (shot.status === 'done' ? 'done' : shot.status === 'running' ? 'running' : shot.status === 'error' ? 'error' : 'pending')} style={{ marginLeft: 8 }} />
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{shot.statusLabel}</span>
                  </div>
                  {/* storyboard 3x3 panel breakdown */}
                  {isStory && !!shot.panels?.length && (
                    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', fontWeight: 600 }}>9 Panel — alur storyboard</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5 }}>
                        {shot.panels.slice(0, 9).map((p) => (
                          <div key={p.n} style={{ background: 'var(--surface2)', borderRadius: 6, padding: '6px 8px', fontSize: 10, lineHeight: 1.4, position: 'relative' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ flexShrink: 0, width: 16, height: 16, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{p.n}</span>
                              <span style={{ color: 'var(--text)', fontWeight: 700, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.2px' }}>{p.title || ''}</span>
                            </div>
                            <div style={{ color: 'var(--muted2)', marginTop: 3 }}>{p.visual || p.scene}</div>
                            {!!p.dialog && <div style={{ color: '#93c5fd', marginTop: 3, fontStyle: 'italic' }}>💬 {p.dialog}</div>}
                            {!!p.onscreen && <div style={{ color: '#fcd34d', marginTop: 2 }}>🅣 {p.onscreen}</div>}
                            {!!p.purpose && <div style={{ color: 'var(--muted)', marginTop: 2, fontSize: 9 }}>🎯 {p.purpose}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="shot-body">
                    <div>
                      <label>{isStory ? 'Grid Prompt (3×3 image)' : 'Image Prompt'}</label>
                      <textarea rows={3} style={{ fontSize: 12 }} value={shot.image_prompt}
                        onChange={(e) => patchShot(shot.id, { image_prompt: e.target.value })} />
                    </div>
                    <div>
                      <label>Video Motion</label>
                      <textarea rows={3} style={{ fontSize: 12 }} value={shot.video_motion}
                        onChange={(e) => patchShot(shot.id, { video_motion: e.target.value })} />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label>💬 Dialog {config.lang ? `(${config.lang})` : ''}</label>
                      <textarea rows={2} style={{ fontSize: 12 }} value={shot.dialogue || ''}
                        onChange={(e) => patchShot(shot.id, { dialogue: e.target.value })}
                        placeholder="Kalimat yang diucapin karakter di shot ini..." />
                      <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 4, lineHeight: 1.45 }}>
                        Disuntik ke prompt video pas Gen Video — model video yang support audio bakal bikin karakternya ngomong beneran.
                      </div>
                    </div>
                  </div>
                  {!!S.refImages.length && (
                    <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', background: '#0d0d0d' }}>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', fontWeight: 600 }}>Refs for this shot</div>
                      {!(shot.refIds || []).length && (
                        <div style={{ fontSize: 10.5, color: '#fcd34d', marginBottom: 6, lineHeight: 1.45 }}>
                          ⚠️ Belum ada ref ke-link — karakter shot ini bisa beda. Klik ref di bawah biar konsisten.
                        </div>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {S.refImages.map((r) => {
                          const on = (shot.refIds || []).includes(r.id)
                          return (
                            <div key={r.id} onClick={() => toggleRef(shot.id, r.id)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px 3px 3px', border: `1px solid ${on ? 'var(--accent)' : 'var(--border2)'}`, borderRadius: 20, fontSize: 11, cursor: 'pointer', background: on ? '#1a0000' : 'transparent', color: on ? 'var(--accent)' : 'var(--muted)' }}>
                              <img src={r.url} alt="" style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'cover' }} />
                              <span>{r.label || 'unnamed'}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* MEDIA — image model, generate, variant picker, video */}
                  <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {!isRef2v && (
                        <>
                          <select value={shot.imgModel || config.imgModel}
                            onChange={(e) => patchShot(shot.id, { imgModel: e.target.value })}
                            title="Image model buat shot ini"
                            style={{ width: 'auto', fontSize: 11, padding: '6px 8px' }}>
                            {IMAGE_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                            <option value="none">Skip (manual)</option>
                          </select>
                          <button className="btn btn-ghost btn-sm" onClick={() => genImage(shot)} disabled={shot.status === 'running'}>
                            {shot.images?.length ? (isStory ? '🔄 Regen Grid' : '🔄 Regen Image') : (isStory ? '🗂️ Gen Grid' : '🖼️ Gen Image')}
                          </button>
                        </>
                      )}
                      <button className="btn btn-sm" onClick={() => genVideo(shot)}
                        disabled={shot.status === 'running' || (!isRef2v && !shot.imageUrl && !(isKlingV3 && S.refImages.length > 0))}>
                        🎬 Gen Video
                      </button>
                    </div>

                    {!!shot.images?.length && (
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', fontWeight: 600 }}>
                          {shot.images.length} variant — klik buat pilih yang dipake
                        </div>
                        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                          {shot.images.map((im, idx) => {
                            const on = im.url === shot.imageUrl
                            return (
                              <div key={idx} onClick={() => patchShot(shot.id, { imageUrl: im.url })}
                                title={'Variant ' + (idx + 1) + ' · ' + im.model}
                                style={{ position: 'relative', cursor: 'pointer', borderRadius: 8, flexShrink: 0, outline: on ? '2.5px solid var(--accent)' : '2.5px solid transparent' }}>
                                <img src={im.url} alt="" style={{ width: 96, height: 124, objectFit: 'cover', borderRadius: 8, display: 'block', opacity: on ? 1 : 0.6 }} />
                                <span style={{ position: 'absolute', top: 3, left: 3, fontSize: 9, fontWeight: 700, background: 'rgba(0,0,0,.78)', color: '#fff', borderRadius: 4, padding: '1px 5px' }}>{im.model}</span>
                                {on && <span style={{ position: 'absolute', bottom: 3, right: 3, fontSize: 11, background: 'var(--accent)', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {shot.videoUrl && (
                      <video src={shot.videoUrl} controls muted loop style={{ width: 160, height: 90, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
          {!!log.length && (
            <div className="log-box" style={{ marginTop: 12 }}>
              {log.map((l, i) => <div key={i} className="log-line">{l}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
