// Style presets, motion library, model lists — ported from legacy

export const STYLES = {
  real_ugc: 'hyperrealistic, shot on iPhone 13 Pro, natural harsh lighting, shallow DOF, candid UGC vlog feel',
  real_cinematic: 'cinematic, anamorphic lens flare, teal-orange color grade, shallow DOF, film grain',
  ads_product: 'premium product commercial photography, studio softbox lighting, glossy reflections, clean seamless background, advertising hero shot, ultra sharp detail',
  ads_lifestyle: 'lifestyle brand advertisement, aspirational mood, warm natural light, authentic candid moment, commercial-grade color',
  '3d_pixar': 'Pixar-style 3D render, subsurface scattering, cinematic lighting, vibrant',
  '3d_realistic': 'photorealistic 3D CGI render, octane render, ray-traced global illumination, hyper-detailed materials',
  '2d_anime': 'anime illustration, large expressive eyes, dramatic, Ghibli aesthetic',
  '2d_cartoon': '2D animation, clean lineart, flat shading, bold outlines, cel-shaded',
  custom: '',
}

export const STYLE_OPTIONS = [
  { v: 'real_ugc', l: '📱 Realistic UGC — iPhone look' },
  { v: 'real_cinematic', l: '🎬 Cinematic — film grade' },
  { v: 'ads_product', l: '📦 Ads — Product Hero' },
  { v: 'ads_lifestyle', l: '✨ Ads — Lifestyle' },
  { v: '3d_pixar', l: '🧊 3D Pixar style' },
  { v: '3d_realistic', l: '🎞 3D Realistic CGI' },
  { v: '2d_anime', l: '🌸 Anime' },
  { v: '2d_cartoon', l: '✏️ Cartoon' },
  { v: 'custom', l: '🛠 Custom (tulis sendiri)' },
]

export const VIDEO_MODELS = [
  { v: 'fal-ai/kling-video/o3/standard/image-to-video', l: 'Kling O3 Standard — ~$0.11/dtk 💰 (audio incl)' },
  { v: 'fal-ai/kling-video/o3/standard/reference-to-video', l: '🎭 Kling O3 Ref-to-Video — ~$0.11/dtk (multi-char)' },
  { v: 'fal-ai/kling-video/v3/standard/image-to-video', l: 'Kling v3 Standard — ~$0.08/dtk 💰 termurah' },
  { v: 'alibaba/happy-horse/image-to-video', l: 'Happy Horse 1.0 — ~$0.14/dtk' },
  { v: 'bytedance/seedance-2.0/fast/image-to-video', l: 'Seedance 2 Fast — ~$0.24/dtk (audio included)' },
  { v: 'alibaba/happy-horse/reference-to-video', l: '🎭 Happy Horse Ref-to-Video — ~$0.14/dtk' },
  { v: 'bytedance/seedance-2.0/fast/reference-to-video', l: '🎭 Seedance 2 Fast Ref-to-Video — ~$0.24/dtk' },
]

// per-second USD rate (720p baseline) — used for cost estimates so users pick the cheap option
export function videoRatePerSec(vidModel, res = '720p') {
  if (!vidModel) return 0.12
  if (vidModel.includes('happy-horse')) return res === '1080p' ? 0.28 : 0.14
  if (vidModel.includes('seedance')) return vidModel.includes('/fast/') ? 0.2419 : 0.3024
  if (vidModel.includes('kling-video')) return vidModel.includes('/o3/') ? 0.112 : 0.084  // o3 audio-on
  return 0.12
}

// true for models that take reference images (image_urls[]) instead of one start frame
export const isRefToVideo = (m) => !!m && m.includes('reference-to-video')

export const IMAGE_MODELS = [
  { v: 'fal-ai/nano-banana-2/edit', l: 'Nano Banana 2 — multi-ref, fast' },
  { v: 'openai/gpt-image-2/edit', l: 'GPT Image 2 Edit — multi-ref + text' },
  { v: 'openai/gpt-image-2', l: 'GPT Image 2 — text in image' },
]

// models that accept multiple reference images (multi-subject consistency)
export const MULTIREF_IMG_MODELS = ['nano-banana', 'gpt-image-2/edit']
export const isMultiRefImg = (m) => MULTIREF_IMG_MODELS.some((k) => m.includes(k))

// CapCut-style caption look presets ("templates")
export const CAPTION_PRESETS = [
  { name: '🔥 TikTok Bold', style: { fontSize: 84, color: '#ffffff', stroke: '#000000', uppercase: true, bg: false, fontFamily: 'Anton', anim: 'pop', position: 'bottom' } },
  { name: '⚡ Hype Yellow', style: { fontSize: 80, color: '#ffd400', stroke: '#000000', uppercase: true, bg: false, fontFamily: 'Montserrat', anim: 'bounce', position: 'center' } },
  { name: '🎬 Bebas Impact', style: { fontSize: 100, color: '#ffffff', stroke: '#000000', uppercase: true, bg: false, fontFamily: 'Bebas Neue', anim: 'slide', position: 'bottom' } },
  { name: '📺 Clean Sub', style: { fontSize: 52, color: '#ffffff', stroke: '#000000', uppercase: false, bg: true, fontFamily: 'Inter', anim: 'fade', position: 'bottom' } },
  { name: '✨ Soft Poppins', style: { fontSize: 62, color: '#ffffff', stroke: '#1a1a1a', uppercase: false, bg: false, fontFamily: 'Poppins', anim: 'pop', position: 'bottom' } },
]

export const CAPTION_ANIMS = [
  { v: 'none', l: 'None' },
  { v: 'pop', l: 'Pop' },
  { v: 'slide', l: 'Slide' },
  { v: 'fade', l: 'Fade' },
  { v: 'bounce', l: 'Bounce' },
]

export const MOTION_PRESETS = {
  Camera: [
    { name: 'Push In', icon: '🎯', prompt: 'camera slowly pushes in toward the subject, smooth dolly movement, cinematic' },
    { name: 'Pull Out', icon: '🔭', prompt: 'camera slowly pulls back revealing the wider scene, smooth dolly out' },
    { name: '360 Orbit', icon: '🌀', prompt: 'camera orbits a full 360 degrees around the subject, smooth circular motion' },
    { name: 'Crash Zoom', icon: '💥', prompt: 'sudden fast crash zoom into the subject, dramatic punch-in, high energy' },
    { name: 'Crane Up', icon: '🏗️', prompt: 'camera cranes upward in a rising reveal shot, majestic sweeping motion' },
    { name: 'Whip Pan', icon: '⚡', prompt: 'fast whip pan with motion blur, dynamic transition energy' },
    { name: 'Handheld', icon: '📱', prompt: 'handheld camera with natural shake, documentary feel, intimate and raw' },
    { name: 'Tracking', icon: '🎬', prompt: 'smooth tracking shot following the subject, steadicam glide' },
    { name: 'Dolly Zoom', icon: '😵', prompt: 'dolly zoom vertigo effect, background warps while subject stays, unsettling' },
    { name: 'Low Angle', icon: '⬆️', prompt: 'dramatic low angle shot looking up at the subject, powerful and imposing' },
    { name: 'Top Down', icon: '🔽', prompt: 'overhead top-down camera angle slowly rotating, god-view composition' },
    { name: 'Slow Tilt', icon: '📐', prompt: 'slow vertical camera tilt revealing the subject head to toe' },
  ],
  Subject: [
    { name: 'Talk to Cam', icon: '🗣️', prompt: 'subject speaks directly to camera with natural gestures, UGC vlog style' },
    { name: 'Walk In', icon: '🚶', prompt: 'subject walks confidently into the frame, natural stride' },
    { name: 'Turn Around', icon: '🔄', prompt: 'subject turns around toward the camera in a slow reveal' },
    { name: 'Product Show', icon: '📦', prompt: 'subject holds and presents the product to camera at a hero angle' },
    { name: 'Reaction', icon: '😲', prompt: 'subject reacts with a genuine emotional expression, candid beat' },
    { name: 'Idle Breathe', icon: '🌬️', prompt: 'subject stands still with subtle natural breathing and micro-movements' },
    { name: 'Hair Flow', icon: '💨', prompt: 'subject hair and clothing flow gently in the wind, elegant slow motion' },
    { name: 'Laugh', icon: '😄', prompt: 'subject laughs naturally and joyfully, warm authentic moment' },
  ],
  Vibe: [
    { name: 'Cinematic', icon: '🎞️', prompt: 'cinematic color grade, shallow depth of field, film grain, anamorphic look' },
    { name: 'Golden Hour', icon: '🌅', prompt: 'warm golden hour lighting, soft glow, dreamy atmosphere' },
    { name: 'Neon Night', icon: '🌃', prompt: 'neon-lit night scene, vibrant colored lighting, moody cyberpunk mood' },
    { name: 'Dreamy Slowmo', icon: '✨', prompt: 'slow motion, ethereal dreamy mood, soft focus, floating light particles' },
    { name: 'Hype Energy', icon: '🔥', prompt: 'high energy fast-paced punchy motion, exciting and dynamic' },
    { name: 'Moody Dark', icon: '🌑', prompt: 'dark moody low-key lighting, dramatic shadows, intense atmosphere' },
    { name: 'Clean Bright', icon: '☀️', prompt: 'clean bright airy lighting, crisp and fresh, commercial polish' },
    { name: 'Rainy Mood', icon: '🌧️', prompt: 'soft rain, wet reflective surfaces, melancholic cinematic atmosphere' },
  ],
}
