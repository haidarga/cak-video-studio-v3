import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { setApiKeys, falUpload } from './lib/api'

const StudioCtx = createContext(null)
export const useStudio = () => useContext(StudioCtx)

const ls = (k, d) => localStorage.getItem(k) || d
const uid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const jget = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] } }

const DEF_VID = 'fal-ai/kling-video/v3/standard/image-to-video'
const DEF_IMG = 'fal-ai/nano-banana-2/edit'

export function StudioProvider({ children }) {
  // ── settings ──
  const [falKey, setFalKey] = useState(() => ls('cak_fal', ''))
  const [geminiKey, setGeminiKey] = useState(() => ls('cak_gemini', ''))
  const [defaultVidModel, setVidModel] = useState(() => ls('cak_vidmodel', DEF_VID))
  const [defaultImgModel, setImgModel] = useState(() => ls('cak_imgmodel', DEF_IMG))
  const [defaultAR, setAR] = useState(() => ls('cak_ar', '9:16'))

  // ── shared Pipeline/Bulk config ──
  const [config, setConfigState] = useState(() => ({
    style: 'real_ugc', customStyle: '', ar: ls('cak_ar', '9:16'), mode: 'cut_to_cut',
    genMode: ls('cak_genmode', 'shots'), // 'shots' | 'storyboard'
    styleRefUrl: ls('cak_styleref', ''),  // optional style reference image (look/mood/color to imitate)
    imgModel: ls('cak_imgmodel', DEF_IMG), vidModel: ls('cak_vidmodel', DEF_VID),
    lang: ls('cak_lang', 'Indonesian'),
  }))
  const setConfig = useCallback((patch) => setConfigState((c) => ({ ...c, ...patch })), [])

  // ── reference images ──
  const [refImages, setRefImages] = useState([])
  // ── template library ──
  const [templates, setTemplates] = useState(() => jget('cak_templates'))
  const [activeTemplateId, setActiveTemplateId] = useState(() => localStorage.getItem('cak_active_template') || null)
  // ── brand library ──
  const [brands, setBrands] = useState(() => jget('cak_brands'))
  const [activeBrandId, setActiveBrandId] = useState(() => localStorage.getItem('cak_active_brand') || null)
  // ── results + toasts ──
  const [results, setResults] = useState(() => jget('cak_results').map((r) => (r.id ? r : { ...r, id: uid('res') })))
  const [resultGroup, setResultGroup] = useState(() => ls('cak_group', ''))
  const [toasts, setToasts] = useState([])
  // navigation + cross-tab handoff
  const [activeTab, setActiveTab] = useState('quick')
  const [postProSource, setPostProSource] = useState(null)
  const [combineSources, setCombineSources] = useState(null)

  useEffect(() => { setApiKeys(falKey, geminiKey) }, [falKey, geminiKey])
  useEffect(() => {
    localStorage.setItem('cak_templates', JSON.stringify(templates))
    localStorage.setItem('cak_active_template', activeTemplateId || '')
  }, [templates, activeTemplateId])
  useEffect(() => {
    localStorage.setItem('cak_brands', JSON.stringify(brands))
    localStorage.setItem('cak_active_brand', activeBrandId || '')
  }, [brands, activeBrandId])
  useEffect(() => { localStorage.setItem('cak_lang', config.lang || 'Indonesian') }, [config.lang])
  useEffect(() => { localStorage.setItem('cak_genmode', config.genMode || 'shots') }, [config.genMode])
  useEffect(() => { localStorage.setItem('cak_styleref', /^https?:/.test(config.styleRefUrl || '') ? config.styleRefUrl : '') }, [config.styleRefUrl])
  // persist results — only ones with real reloadable URLs (skip dead blob:/data:)
  useEffect(() => {
    const keep = results.filter((r) => /^https?:/.test(r.url || '')).slice(0, 60)
    try { localStorage.setItem('cak_results', JSON.stringify(keep)) } catch {}
  }, [results])
  useEffect(() => { localStorage.setItem('cak_group', resultGroup) }, [resultGroup])

  const toast = useCallback((msg, type = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, msg, type }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  const saveSettings = useCallback((s) => {
    setFalKey(s.falKey); setGeminiKey(s.geminiKey)
    setVidModel(s.defaultVidModel); setImgModel(s.defaultImgModel); setAR(s.defaultAR)
    localStorage.setItem('cak_fal', s.falKey)
    localStorage.setItem('cak_gemini', s.geminiKey)
    localStorage.setItem('cak_vidmodel', s.defaultVidModel)
    localStorage.setItem('cak_imgmodel', s.defaultImgModel)
    localStorage.setItem('cak_ar', s.defaultAR)
    toast('Settings saved ✓')
  }, [toast])

  // ── results ──
  const addResult = useCallback((r) => setResults((p) => [{ ...r, id: uid('res'), group: r.group || resultGroup || '', ts: Date.now() }, ...p]), [resultGroup])
  const clearResults = useCallback(() => setResults([]), [])
  const renameResult = useCallback((id, label) => setResults((p) => p.map((r) => (r.id === id ? { ...r, label } : r))), [])
  const moveResultToGroup = useCallback((id, group) => setResults((p) => p.map((r) => (r.id === id ? { ...r, group } : r))), [])
  // QC: send to review queue / update status / remove from queue. qc = {status,notes} | null to remove.
  const setResultQC = useCallback((id, qc) => setResults((p) => p.map((r) => {
    if (r.id !== id) return r
    if (qc === null) { const { qc: _drop, ...rest } = r; return rest }
    return { ...r, qc: { ...(r.qc || { status: 'pending', notes: '' }), ...qc } }
  })), [])
  // send a generated video into the Post-Production editor + jump there
  const sendToPostPro = useCallback((url) => {
    setPostProSource(url)
    setActiveTab('postpro')
    toast('Dikirim ke Post-Production ✓')
  }, [toast])
  // send multiple clips into the unified Editor (Post-Pro) + jump there
  const sendToCombine = useCallback((urls) => {
    setCombineSources(urls)
    setActiveTab('postpro')
    toast(`${urls.length} clip dikirim ke Editor ✓`)
  }, [toast])

  // ── refs ──
  const addRefFromFile = useCallback((file) => {
    const id = uid('ref')
    setRefImages((p) => [...p, { id, file, url: URL.createObjectURL(file), falUrl: null, label: '' }])
    falUpload(file)
      .then((fu) => setRefImages((p) => p.map((r) => (r.id === id ? { ...r, falUrl: fu } : r))))
      .catch(() => {})
    return id
  }, [])
  const updateRefLabel = useCallback((id, label) => {
    setRefImages((p) => p.map((r) => (r.id === id ? { ...r, label } : r)))
  }, [])
  // per-product knowledge attached to a reference image (exact label text, rules, etc.)
  const updateRefKnowledge = useCallback((id, knowledge) => {
    setRefImages((p) => p.map((r) => (r.id === id ? { ...r, knowledge } : r)))
  }, [])
  const removeRef = useCallback((id) => setRefImages((p) => p.filter((r) => r.id !== id)), [])
  const ensureRefsUploaded = useCallback(async () => {
    const pending = refImages.filter((r) => !r.falUrl && r.file)
    for (const ref of pending) {
      try {
        const fu = await falUpload(ref.file)
        setRefImages((p) => p.map((r) => (r.id === ref.id ? { ...r, falUrl: fu } : r)))
        ref.falUrl = fu
      } catch {}
    }
  }, [refImages])

  // ── templates ──
  const getActiveTemplate = useCallback(
    () => templates.find((t) => t.id === activeTemplateId) || null,
    [templates, activeTemplateId]
  )
  const saveTemplate = useCallback((name, analysis) => {
    const t = { id: uid('tpl'), name, analysis }
    setTemplates((p) => [...p, t])
    setActiveTemplateId(t.id)
    toast(`Template "${name}" tersimpan & aktif ✓`)
    return t
  }, [toast])
  const useTemplateById = useCallback((id) => { setActiveTemplateId(id); toast('Template aktif ✓') }, [toast])
  const clearActiveTemplate = useCallback(() => { setActiveTemplateId(null); toast('Template dimatiin') }, [toast])
  const deleteTemplate = useCallback((id) => {
    setTemplates((p) => p.filter((t) => t.id !== id))
    setActiveTemplateId((a) => (a === id ? null : a))
  }, [])
  const renameTemplate = useCallback((id, name) => {
    setTemplates((p) => p.map((t) => (t.id === id ? { ...t, name } : t)))
  }, [])

  // ── brands ──
  const getActiveBrand = useCallback(
    () => brands.find((b) => b.id === activeBrandId) || null,
    [brands, activeBrandId]
  )
  const captureSetup = useCallback(() => ({
    refs: refImages.filter((r) => r.falUrl).map((r) => ({ id: r.id, label: r.label || '', falUrl: r.falUrl, knowledge: r.knowledge || '' })),
    activeTemplateId: activeTemplateId || null,
    config: { ...config },
  }), [refImages, activeTemplateId, config])
  const createBrand = useCallback((name) => {
    const brand = { id: uid('brand'), name, notes: '', ...captureSetup() }
    setBrands((p) => [...p, brand])
    setActiveBrandId(brand.id)
    toast(`Brand "${name}" tersimpan ✓`)
    return brand
  }, [captureSetup, toast])
  const updateActiveBrand = useCallback(() => {
    if (!activeBrandId) { toast('Gak ada brand aktif', 'error'); return }
    const snap = captureSetup()
    setBrands((p) => p.map((b) => (b.id === activeBrandId ? { ...b, ...snap } : b)))
    toast('Brand di-update ✓')
  }, [activeBrandId, captureSetup, toast])
  const applyBrand = useCallback((id, silent) => {
    const b = brands.find((x) => x.id === id)
    if (!b) return
    setActiveBrandId(id)
    setRefImages((b.refs || []).map((r) => ({ id: r.id, file: null, url: r.falUrl, falUrl: r.falUrl, label: r.label || '', knowledge: r.knowledge || '' })))
    setActiveTemplateId(b.activeTemplateId && templates.find((t) => t.id === b.activeTemplateId) ? b.activeTemplateId : null)
    if (b.config) setConfigState((c) => ({ ...c, ...b.config }))
    if (!silent) toast(`Brand "${b.name}" loaded ✓`)
  }, [brands, templates, toast])
  const deleteBrand = useCallback((id) => {
    setBrands((p) => p.filter((b) => b.id !== id))
    setActiveBrandId((a) => (a === id ? null : a))
  }, [])
  const clearBrand = useCallback(() => setActiveBrandId(null), [])
  const saveBrandNotes = useCallback((id, notes) => {
    setBrands((p) => p.map((b) => (b.id === id ? { ...b, notes } : b)))
  }, [])

  // re-apply last active brand once on mount
  useEffect(() => {
    if (activeBrandId && brands.find((b) => b.id === activeBrandId)) applyBrand(activeBrandId, true)
    // eslint-disable-next-line
  }, [])

  const keyStatus = falKey && geminiKey ? 'ok' : falKey ? 'partial' : 'none'

  const value = {
    falKey, geminiKey, defaultVidModel, defaultImgModel, defaultAR, keyStatus, saveSettings,
    config, setConfig,
    refImages, addRefFromFile, updateRefLabel, updateRefKnowledge, removeRef, ensureRefsUploaded,
    templates, activeTemplateId, getActiveTemplate, saveTemplate, useTemplateById, clearActiveTemplate, deleteTemplate, renameTemplate,
    brands, activeBrandId, getActiveBrand, createBrand, updateActiveBrand, applyBrand, deleteBrand, saveBrandNotes, clearBrand,
    results, addResult, clearResults, renameResult, moveResultToGroup, setResultQC, resultGroup, setResultGroup,
    activeTab, setActiveTab, postProSource, setPostProSource, sendToPostPro,
    combineSources, setCombineSources, sendToCombine,
    toasts, toast,
  }
  return <StudioCtx.Provider value={value}>{children}</StudioCtx.Provider>
}
