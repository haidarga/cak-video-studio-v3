// Estimated per-call cost in USD. Approximate — actual cost dari fal.ai bisa
// sedikit beda based on resolution / duration / extras. Use buat budget
// estimation + display sebelum user klik gen.

export const IMAGE_COSTS = {
  'fal-ai/nano-banana-2/edit': 0.04,
  'fal-ai/nano-banana/edit': 0.03,
  'fal-ai/imagen-4-fast/edit': 0.025,
  'fal-ai/seedream/v4/edit': 0.05,
  'fal-ai/qwen-image-edit-plus': 0.03,
  'fal-ai/flux-pro/v1.1-ultra': 0.06,
  'fal-ai/flux/dev': 0.025,
  // Add more as needed; default below
  _default: 0.03,
}

// Per-second cost untuk video gen — multiply by duration
export const VIDEO_COSTS_PER_SECOND = {
  'fal-ai/kling-video/v3/standard/image-to-video': 0.08,
  'fal-ai/kling-video/o3/standard/image-to-video': 0.11,
  'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': 0.12,
  'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video': 0.12,
  'alibaba/happy-horse/image-to-video': 0.14,
  'fal-ai/bytedance/seedance/v1/lite/reference-to-video': 0.16,
  'fal-ai/bytedance/seedance/v1/lite/image-to-video': 0.16,
  'bytedance/seedance-2.0/fast/image-to-video': 0.24,
  'fal-ai/bytedance/seedance/v1/pro/image-to-video': 0.25,
  'fal-ai/veo3/fast': 0.20,
  'fal-ai/veo3': 0.50,
  _default: 0.10,
}

export function imageCost(model) {
  return IMAGE_COSTS[model] ?? IMAGE_COSTS._default
}
export function videoCost(model, durationSec = 5) {
  const perSec = VIDEO_COSTS_PER_SECOND[model] ?? VIDEO_COSTS_PER_SECOND._default
  return perSec * durationSec
}

// Gemini Flash 2.5 pricing (approx)
export const GEMINI_COSTS = {
  parse: 0.001,
  caption_draft: 0.001,
  transcribe: 0.01,        // higher karena video inline = more tokens
}

export function fmtCost(n) {
  if (n == null) return '—'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}
