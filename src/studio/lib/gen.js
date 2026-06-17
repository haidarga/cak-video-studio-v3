import { falRun, falUpload, buildVidInput, buildImgInput } from './api'
import { STYLES } from './constants'
import { productImageDirective } from './prompt'
import { applySeed, randomSeed } from '@/lib/model-seed'

// headless image gen (no DOM) — mutates shot.imageUrl, returns it
export async function headlessGenImage(shot, cfg, refImages) {
  if (cfg.imgModel === 'none') return shot.imageUrl
  const styleSuffix = cfg.style === 'custom' ? cfg.customStyle : STYLES[cfg.style] || ''
  const sel = shot.refIds?.length ? refImages.filter((r) => shot.refIds.includes(r.id)) : refImages
  const refUrls = sel.map((r) => r.falUrl || r.url).filter((u) => u && !u.startsWith('blob:') && !u.startsWith('data:'))
  const productKnowledge = sel.map((r) => (r.knowledge || '').trim()).filter(Boolean).join('\n')
  const styleNote = cfg.styleRefUrl ? ' STYLE REFERENCE: the final reference image is a style guide — match its overall aesthetic, lighting, mood and color grade, NOT its content or subjects.' : ''
  const refUrlsAll = cfg.styleRefUrl ? [...refUrls, cfg.styleRefUrl] : refUrls
  // IMAGE ROLES — bind each ref so the model doesn't blend/redesign. A ref
  // carrying product `knowledge` is treated as the product. Filter matches
  // refUrls above so role numbers line up with the image_urls sent to fal.
  const roleLines = []
  let rIdx = 1
  for (const r of sel) {
    const u = r.falUrl || r.url
    if (!u || u.startsWith('blob:') || u.startsWith('data:')) continue
    if ((r.knowledge || '').trim()) {
      roleLines.push(`- Image ${rIdx} = THE PRODUCT (${r.label || 'product'}): reproduce its EXACT shape, ports/buttons/plugs, colors and ALL label text. Do NOT redesign or invent extra holes/ports/plugs. Multiple angles = ONE single product.`)
    } else {
      roleLines.push(`- Image ${rIdx} = character IDENTITY only (face, hair, body${r.label ? ` — ${r.label}` : ''}). Ignore its background and pose.`)
    }
    rIdx++
  }
  const imageRoles = roleLines.length ? `IMAGE ROLES (each reference image has a specific job — follow exactly):\n${roleLines.join('\n')}\n\n` : ''
  const fullPrompt = imageRoles + `${shot.image_prompt}. ${styleSuffix}. ${cfg.ar} composition. CONTINUITY: maintain exact visual style and character appearance from references.${productImageDirective(productKnowledge || cfg.brandNotes)}${styleNote}`
  const seed = cfg.seedLock ? cfg.seed : randomSeed()
  const result = await falRun(cfg.imgModel, applySeed(cfg.imgModel, buildImgInput(cfg.imgModel, { prompt: fullPrompt, refUrls: refUrlsAll, ar: cfg.ar }), seed))
  shot.imageUrl = result.images?.[0]?.url
  if (!shot.imageUrl) throw new Error('no image returned')
  return shot.imageUrl
}

// headless video gen — mutates shot.videoUrl, returns it
// reference-to-video models pull reference images directly (no start frame needed)
// Kling v3 falls back to using first ref as start frame if no shot.imageUrl
export async function headlessGenVideo(shot, cfg, refImages = []) {
  const isRef2v = cfg.vidModel.includes('reference-to-video')
  const isKlingV3 = cfg.vidModel.includes('kling-video/') && !cfg.vidModel.includes('reference-to-video')
  const prompt = shot.video_motion || 'Natural cinematic motion.'
  // gather refs once (used in multiple paths)
  let refUrls = []
  if (isRef2v || isKlingV3) {
    const sel = shot.refIds?.length ? refImages.filter((r) => shot.refIds.includes(r.id)) : refImages
    refUrls = sel.map((r) => r.falUrl).filter(Boolean)
  }
  let input
  if (isRef2v) {
    if (!refUrls.length) throw new Error('reference-to-video needs reference images')
    input = buildVidInput(cfg.vidModel, { prompt, reference_urls: refUrls, duration: shot.duration, aspect_ratio: cfg.ar, resolution: cfg.res })
  } else if (isKlingV3 && !shot.imageUrl) {
    // Kling fallback — no per-shot image, use first ref as start frame, rest as elements
    if (!refUrls.length) throw new Error('Kling: need a start image or at least one reference image')
    input = buildVidInput(cfg.vidModel, { prompt, image_url: refUrls[0], reference_urls: refUrls.slice(1), duration: shot.duration, aspect_ratio: cfg.ar, resolution: cfg.res })
  } else {
    let startImageUrl = shot.imageUrl
    if (!startImageUrl) throw new Error('no start image')
    if (startImageUrl.startsWith('blob:') || startImageUrl.startsWith('data:')) {
      const blob = await (await fetch(startImageUrl)).blob()
      startImageUrl = await falUpload(blob, 'frame.jpg')
    }
    input = buildVidInput(cfg.vidModel, { prompt, image_url: startImageUrl, reference_urls: refUrls, duration: shot.duration, aspect_ratio: cfg.ar, resolution: cfg.res })
  }
  const seed = cfg.seedLock ? cfg.seed : randomSeed()
  const result = await falRun(cfg.vidModel, applySeed(cfg.vidModel, input, seed))
  shot.videoUrl = result.video?.url || result.video
  if (!shot.videoUrl) throw new Error('no video returned — fal: ' + JSON.stringify(result).slice(0, 240))
  return shot.videoUrl
}
