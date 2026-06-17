// Estimated per-call cost in USD. Approximate — actual cost dari fal.ai bisa
// sedikit beda based on resolution / duration / extras. Use buat budget
// estimation + display sebelum user klik gen.

export const IMAGE_COSTS = {
  'fal-ai/nano-banana-2/edit': 0.04,
  'openai/gpt-image-2': 0.06,
  'openai/gpt-image-2/edit': 0.06,
  'fal-ai/nano-banana/edit': 0.03,
  'fal-ai/imagen-4-fast/edit': 0.025,
  'fal-ai/seedream/v4/edit': 0.05,
  'fal-ai/qwen-image-edit-plus': 0.03,
  'fal-ai/flux-pro/v1.1-ultra': 0.06,
  'fal-ai/flux/dev': 0.025,
  // Grok Imagine Edit — $0.05 output (1k) + ~$0.01 per input image.
  // Estimate assumes 2 input refs (character + product) for budget calc.
  'xai/grok-imagine-image/quality/edit': 0.07,
  // Add more as needed; default below
  _default: 0.03,
}

// Per-second cost untuk video gen — multiply by duration
export const VIDEO_COSTS_PER_SECOND = {
  'xai/grok-imagine-video/image-to-video': 0.07,
  'xai/grok-imagine-video/reference-to-video': 0.07,
  'xai/grok-imagine-video/text-to-video': 0.07,        // 720p $0.07/s, 480p $0.05/s
  'xai/grok-imagine-video/v1.5/image-to-video': 0.14,  // 720p $0.14/s, 480p $0.08/s (+$0.01/input img)
  'fal-ai/kling-video/v3/standard/text-to-video': 0.13, // $0.084 audio off / $0.126 audio on
  'alibaba/happy-horse/text-to-video': 0.14,           // 720p; 1080p $0.28/s
  'bytedance/seedance-2.0/text-to-video': 0.31,        // 720p $0.3034/s; 1080p $0.682/s
  // LTX-2.3 — priced per megapixel ($0.0024075/MP of W×H×frames). At 720p ≈
  // $0.054/s, at 576p ≈ $0.034/s. Estimate is conservative (budget gate uses
  // default 5s since LTX input has no `duration` field, only num_frames).
  'fal-ai/ltx-2.3-quality/text-to-video': 0.06,
  // Wan 2.7 — $0.10/s @720p, $0.15/s @1080p (we default 720p in God Mode).
  'fal-ai/wan/v2.7/image-to-video': 0.10,
  'fal-ai/wan/v2.7/text-to-video': 0.10,
  // Video EDIT models (per second of OUTPUT; input charged too on some)
  'xai/grok-imagine-video/edit-video': 0.08,           // 720p $0.07 out + $0.01 in
  'xai/grok-imagine-video/extend-video': 0.08,         // same pricing as edit-video
  'alibaba/happy-horse/video-edit': 0.28,              // 720p $0.14 in + $0.14 out; 1080p $0.56
  'fal-ai/kling-video/v3/standard/image-to-video': 0.08,
  'fal-ai/kling-video/o3/standard/image-to-video': 0.11,
  'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': 0.12,
  'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video': 0.12,
  'alibaba/happy-horse/image-to-video': 0.14,
  'alibaba/happy-horse/reference-to-video': 0.14,
  'fal-ai/bytedance/seedance/v1/lite/reference-to-video': 0.16,
  'fal-ai/bytedance/seedance/v1/lite/image-to-video': 0.16,
  'bytedance/seedance-2.0/fast/image-to-video': 0.24,
  'bytedance/seedance-2.0/fast/reference-to-video': 0.24,
  'fal-ai/bytedance/seedance/v1/pro/image-to-video': 0.25,
  'fal-ai/kling-video/v3/pro/image-to-video': 0.28,
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
