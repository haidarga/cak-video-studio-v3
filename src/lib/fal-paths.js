// Canonical fal.ai model path resolver.
//
// THE BUG THIS EXISTS TO PREVENT — fal.ai accepts vendor-prefixed aliases at
// submit time (`bytedance/seedance-2.0/...`, `xai/grok-imagine-video/...`)
// but the queue routing layer ANCHORS request_ids on the canonical path
// (`fal-ai/seedance-2/...`, `fal-ai/xai/...`). Submitting via alias works,
// then polling `/requests/{id}/status` on the same alias returns empty,
// because the request_id exists under canonical only. We hit this with
// Seedance 2 Fast Ref-to-Video — video DONE on the dashboard, UI polled
// 68 times getting `fal: unknown` forever.
//
// Rules going forward — every manual fetch to queue.fal.run MUST resolve
// the model through canonicalFalPath() first. The catalog (VIDEO_MODELS /
// IMAGE_MODELS) keeps aliases for backwards compatibility with stored user
// preferences, but the wire-layer always uses canonical.
//
// If you add a new model and fal returns 404 on status polling: add the
// alias→canonical mapping to ALIAS_MAP. Check fal.ai dashboard for the
// "Endpoint" field — that's the canonical.

const ALIAS_MAP = {
  // Seedance 2 (verified via dashboard endpoint field)
  'bytedance/seedance-2.0/fast/reference-to-video': 'fal-ai/seedance-2/fast/reference-to-video',
  'bytedance/seedance-2.0/fast/image-to-video': 'fal-ai/seedance-2/fast/image-to-video',
  'bytedance/seedance-2.0/fast/text-to-video': 'fal-ai/seedance-2/fast/text-to-video',
  'bytedance/seedance-2.0/pro/reference-to-video': 'fal-ai/seedance-2/pro/reference-to-video',
  'bytedance/seedance-2.0/pro/image-to-video': 'fal-ai/seedance-2/pro/image-to-video',

  // xAI Grok Imagine Video (verified via dashboard endpoint field)
  'xai/grok-imagine-video/reference-to-video': 'fal-ai/xai/reference-to-video',
  'xai/grok-imagine-video/image-to-video': 'fal-ai/xai/image-to-video',

  // xAI Grok Imagine Image (assumed by pattern; verify on first 404)
  'xai/grok-imagine-image/quality/edit': 'fal-ai/xai/grok-imagine-image/quality/edit',

  // Happy Horse (assumed; verify on first 404)
  'alibaba/happy-horse/image-to-video': 'fal-ai/alibaba/happy-horse/image-to-video',
  'alibaba/happy-horse/reference-to-video': 'fal-ai/alibaba/happy-horse/reference-to-video',

  // OpenAI GPT Image 2 (assumed; verify on first 404)
  'openai/gpt-image-2': 'fal-ai/openai/gpt-image-2',
  'openai/gpt-image-2/edit': 'fal-ai/openai/gpt-image-2/edit',
}

// Reverse lookup so we can also normalize when caller passed canonical.
const REVERSE_ALIAS_MAP = {}
for (const [alias, canonical] of Object.entries(ALIAS_MAP)) {
  REVERSE_ALIAS_MAP[canonical] = alias
}

/**
 * Returns the canonical fal.ai model path for queue API calls. If the model
 * is already canonical or unknown, returns it as-is.
 */
export function canonicalFalPath(model) {
  if (!model || typeof model !== 'string') return model
  if (ALIAS_MAP[model]) return ALIAS_MAP[model]
  // Already canonical (or unknown — return as-is, fal will 404 and we'll log).
  return model
}

/**
 * Returns every plausible path for a model — canonical first, then alias if
 * different, then any cross-direction variants. Used by status pollers as a
 * defensive fallback when we're not sure which form the request was
 * registered under (e.g. legacy gen_jobs rows from before normalization).
 */
export function candidateFalPaths(model) {
  if (!model || typeof model !== 'string') return [model]
  const canonical = canonicalFalPath(model)
  const out = [canonical]
  if (model !== canonical) out.push(model)
  // If model itself is canonical, include the known alias too.
  if (REVERSE_ALIAS_MAP[model] && !out.includes(REVERSE_ALIAS_MAP[model])) {
    out.push(REVERSE_ALIAS_MAP[model])
  }
  return out
}
