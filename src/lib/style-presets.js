// Style/genre presets for Generate. Each preset:
// - prompt_prefix / prompt_suffix: injected to image_prompt + video_motion
// - negative: things to avoid (where applicable)
// - quality_boosters: appended at end
// - recommended_img_model, recommended_vid_model
// - example: short label

export const STYLE_PRESETS = {
  ugc: {
    label: '📱 UGC / Authentic',
    description: 'Real-person feel, handheld, natural lighting',
    prompt_prefix: 'UGC-style authentic content, ',
    prompt_suffix: ', shot on iPhone 15 Pro, handheld camera, natural daylight, slight imperfections, raw, unedited look, real person aesthetic',
    negative: 'cinematic lighting, professional studio, over-stylized, fashion photography, glossy magazine, color-graded',
    quality_boosters: 'authentic, relatable, genuine moment, soft skin tones, ambient sound',
    recommended_img_model: 'fal-ai/nano-banana-2/edit',
    recommended_vid_model: 'fal-ai/kling-video/v3/standard/image-to-video',
  },
  animation: {
    label: '🎨 2D Animation',
    description: 'Cartoon / illustration style, vibrant',
    prompt_prefix: '2D cartoon animation style, ',
    prompt_suffix: ', flat colors, clean linework, vibrant palette, Studio Ghibli inspired, animated illustration, no photographic detail',
    negative: 'photorealistic, hyperreal, 3D render, realistic skin texture, blurry, sketchy',
    quality_boosters: 'sharp lines, expressive character design, dynamic poses, anime-quality',
    recommended_img_model: 'fal-ai/flux/dev',
    recommended_vid_model: 'fal-ai/kling-video/v3/standard/image-to-video',
  },
  '3d': {
    label: '🎮 3D Render',
    description: 'Pixar/Disney style, polished CG',
    prompt_prefix: '3D rendered Pixar-style animation, ',
    prompt_suffix: ', subsurface scattering, soft volumetric lighting, polished CG render, Unreal Engine 5, ray-traced reflections, depth of field',
    negative: '2D, flat, photorealistic, low-poly, amateur render',
    quality_boosters: 'octane render quality, expressive character animation, cinematic 3D',
    recommended_img_model: 'fal-ai/flux-pro/v1.1-ultra',
    recommended_vid_model: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  },
  cinematic_ad: {
    label: '🎬 Cinematic Ad',
    description: 'High-end commercial production, dramatic lighting',
    prompt_prefix: 'Cinematic premium commercial advertisement, ',
    prompt_suffix: ', ARRI Alexa film camera, anamorphic lens flares, golden hour lighting, shallow depth of field, Hollywood-grade production, color graded',
    negative: 'amateur, low budget, flat lighting, snapshot, casual',
    quality_boosters: '8K cinematic, professional cinematography, dramatic composition, awards-worthy',
    recommended_img_model: 'fal-ai/flux-pro/v1.1-ultra',
    recommended_vid_model: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  },
  short_movie: {
    label: '🎞 Short Movie',
    description: 'Narrative film style, character-driven',
    prompt_prefix: 'Cinematic short film scene, ',
    prompt_suffix: ', 35mm film grain, natural film color science, narrative composition, emotionally engaging, character close-up, Roger Deakins inspired',
    negative: 'commercial advertisement vibe, generic stock footage, social media aesthetic',
    quality_boosters: 'Oscar-worthy cinematography, authentic emotion, period-accurate',
    recommended_img_model: 'fal-ai/flux-pro/v1.1-ultra',
    recommended_vid_model: 'fal-ai/veo3/fast',
  },
  tvc: {
    label: '📺 TVC Broadcast',
    description: 'TV commercial broadcast quality',
    prompt_prefix: 'Television commercial broadcast quality, ',
    prompt_suffix: ', clean composition, product hero shot, broadcast-safe colors, 16:9 framing-aware, professional studio lighting, sharp focus on subject',
    negative: 'social media style, low resolution, vertical-only composition',
    quality_boosters: 'broadcast HD quality, polished, brand-safe',
    recommended_img_model: 'fal-ai/imagen-4-fast/edit',
    recommended_vid_model: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
  },
  product_demo: {
    label: '📦 Product Demo',
    description: 'E-commerce product showcase, clean',
    prompt_prefix: 'Product photography for e-commerce, ',
    prompt_suffix: ', clean white or gradient background, professional product lighting, sharp focus on product details, hero angle, no distractions',
    negative: 'cluttered scene, busy background, person dominating frame, soft focus',
    quality_boosters: 'commercial product photo quality, true-to-life colors',
    recommended_img_model: 'fal-ai/seedream/v4/edit',
    recommended_vid_model: 'fal-ai/kling-video/v3/standard/image-to-video',
  },
  social_short: {
    label: '⚡ Social Short (cheap)',
    description: 'Quick TikTok/Reels — cost-optimized',
    prompt_prefix: 'Short-form social media content, ',
    prompt_suffix: ', vertical 9:16 framing, attention-grabbing first frame, dynamic energy, social media aesthetic',
    negative: 'cinematic widescreen, slow-paced, traditional advertising',
    quality_boosters: 'scroll-stopping, viral-ready composition',
    recommended_img_model: 'fal-ai/nano-banana-2/edit',
    recommended_vid_model: 'fal-ai/kling-video/v3/standard/image-to-video',
  },
}

export const STYLE_KEYS = Object.keys(STYLE_PRESETS)

export function applyStylePreset(presetKey, basePrompt) {
  const preset = STYLE_PRESETS[presetKey]
  if (!preset) return basePrompt
  const parts = [preset.prompt_prefix, basePrompt, preset.prompt_suffix, preset.quality_boosters]
    .filter(Boolean).join('. ')
  const neg = preset.negative ? ` Avoid: ${preset.negative}.` : ''
  return parts + neg
}
