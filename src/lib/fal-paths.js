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
// THE REAL FIX — fal's submit response includes `status_url` and
// `response_url` that point to the CANONICAL URLs for polling this exact
// request. When we capture those at submit time and persist them with the
// gen_jobs row (or pass them through the queued message), pollers don't
// need to guess any model paths — they hit the exact URL fal told them to.
// This module is the FALLBACK for callers that didn't capture those URLs
// (legacy queued messages, in-line direct submits) — it tries every
// plausible canonical form via a hand-curated ALIAS_MAP plus algorithmic
// derivations covering common transformation patterns.
//
// Rules going forward:
//  1. Prefer using fal-provided status_url/response_url from the submit
//     response. They are AUTHORITATIVE — no guessing.
//  2. When that's not available, use canonicalFalPath() / candidateFalPaths()
//     to derive likely paths.
//  3. Adding a new model? Test once with falStatusFromUrls() — if it works,
//     no action needed. If it returns empty/404, add to ALIAS_MAP after
//     checking fal.ai dashboard for the canonical "Endpoint" field.

const ALIAS_MAP = {
  // ── Seedance 2 (verified via fal dashboard) ──
  'bytedance/seedance-2.0/fast/reference-to-video': 'fal-ai/seedance-2/fast/reference-to-video',
  'bytedance/seedance-2.0/fast/image-to-video': 'fal-ai/seedance-2/fast/image-to-video',
  'bytedance/seedance-2.0/fast/text-to-video': 'fal-ai/seedance-2/fast/text-to-video',
  'bytedance/seedance-2.0/pro/reference-to-video': 'fal-ai/seedance-2/pro/reference-to-video',
  'bytedance/seedance-2.0/pro/image-to-video': 'fal-ai/seedance-2/pro/image-to-video',

  // ── xAI Grok Imagine Video (verified via fal dashboard) ──
  'xai/grok-imagine-video/reference-to-video': 'fal-ai/xai/reference-to-video',
  'xai/grok-imagine-video/image-to-video': 'fal-ai/xai/image-to-video',

  // ── Happy Horse (alibaba) — common alias pattern, fal-ai/ prefix ──
  'alibaba/happy-horse/image-to-video': 'fal-ai/alibaba/happy-horse/image-to-video',
  'alibaba/happy-horse/reference-to-video': 'fal-ai/alibaba/happy-horse/reference-to-video',

  // ── xAI Grok Imagine Image Edit ──
  'xai/grok-imagine-image/quality/edit': 'fal-ai/xai/grok-imagine-image/quality/edit',

  // ── OpenAI GPT Image 2 ──
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
  return model
}

/**
 * Generate algorithmic candidate transformations for an unknown model path.
 * Covers common patterns fal uses when going from public alias to canonical:
 *   - Add `fal-ai/` prefix
 *   - Drop vendor prefix segment (xai/foo/bar → fal-ai/foo/bar; or fal-ai/bar)
 *   - Normalize version dot suffix (X-2.0 → X-2)
 * Returns the list of derived candidates (excluding the input itself).
 */
function algorithmicCandidates(model) {
  const out = new Set()
  if (!model || typeof model !== 'string') return []
  const parts = model.split('/')

  // Prefix with fal-ai/ if not already
  if (!model.startsWith('fal-ai/')) {
    out.add(`fal-ai/${model}`)
    // Also drop the first (vendor) segment: bytedance/X/Y → fal-ai/X/Y
    if (parts.length >= 2) out.add(`fal-ai/${parts.slice(1).join('/')}`)
  } else {
    // If already canonical, try the alias form (drop fal-ai/)
    out.add(parts.slice(1).join('/'))
  }

  // Normalize semver-style suffix: seedance-2.0 → seedance-2
  const normalized = model.replace(/-(\d+)\.0(\b|\/)/g, '-$1$2')
  if (normalized !== model) {
    out.add(normalized)
    if (!normalized.startsWith('fal-ai/')) out.add(`fal-ai/${normalized}`)
    const nParts = normalized.split('/')
    if (nParts.length >= 2 && !normalized.startsWith('fal-ai/')) {
      out.add(`fal-ai/${nParts.slice(1).join('/')}`)
    }
  }

  out.delete(model)
  return Array.from(out)
}

/**
 * Returns every plausible path for a model — canonical first, then alias,
 * then algorithmic derivations. Used by status pollers as a defensive
 * fallback when we're not sure which form the request was registered under.
 *
 * Order matters: most-likely-canonical first so a successful match short-
 * circuits the rest of the probe.
 */
export function candidateFalPaths(model) {
  if (!model || typeof model !== 'string') return [model]
  const out = []
  const seen = new Set()
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p) } }

  // 1) Verified canonical from ALIAS_MAP
  const canonical = canonicalFalPath(model)
  add(canonical)

  // 2) The model as-given (if different from canonical)
  add(model)

  // 3) Verified reverse alias if model itself is canonical
  if (REVERSE_ALIAS_MAP[model]) add(REVERSE_ALIAS_MAP[model])

  // 4) Algorithmic candidates — covers new models not yet in ALIAS_MAP
  for (const c of algorithmicCandidates(model)) add(c)
  for (const c of algorithmicCandidates(canonical)) add(c)

  return out
}
