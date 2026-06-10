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

// VERIFIED canonical mappings — confirmed by inspecting the fal.ai
// dashboard "Endpoint" field after a real submit. Used by canonicalFalPath()
// at SUBMIT time, so wrong entries here BREAK submission. Only add after
// dashboard verification.
//
// For UNVERIFIED models, leave them out of this map. candidateFalPaths()
// will probe algorithmic derivations + capture authoritative status_url
// from the fal submit response (which works regardless of our guess).
const ALIAS_MAP = {
  // ── Seedance 2 (verified — drops "bytedance/" prefix, normalizes "2.0"→"2") ──
  'bytedance/seedance-2.0/fast/reference-to-video': 'fal-ai/seedance-2/fast/reference-to-video',
  'bytedance/seedance-2.0/fast/image-to-video': 'fal-ai/seedance-2/fast/image-to-video',
  'bytedance/seedance-2.0/fast/text-to-video': 'fal-ai/seedance-2/fast/text-to-video',
  'bytedance/seedance-2.0/pro/reference-to-video': 'fal-ai/seedance-2/pro/reference-to-video',
  'bytedance/seedance-2.0/pro/image-to-video': 'fal-ai/seedance-2/pro/image-to-video',

  // ── xAI Grok Imagine Video (verified — drops middle "grok-imagine-video") ──
  // Both i2v and r2v variants share this exact pattern. Dashboard endpoint
  // shows fal-ai/xai/reference-to-video and fal-ai/xai/image-to-video.
  'xai/grok-imagine-video/reference-to-video': 'fal-ai/xai/reference-to-video',
  'xai/grok-imagine-video/image-to-video': 'fal-ai/xai/image-to-video',
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
 *   - Drop the vendor segment (`bytedance/X/Y` → `fal-ai/X/Y`)
 *   - DROP MIDDLE SEGMENT (`xai/grok-imagine-video/i2v` → `fal-ai/xai/i2v`).
 *     This is the Grok pattern. Without it, Grok variants beyond r2v/i2v
 *     would silently fail to resolve.
 *   - Normalize semver suffix (`seedance-2.0` → `seedance-2`)
 *   - Combinations of the above
 *
 * NOTE — keeping the LAST segment (variant: i2v/r2v/t2v/edit) intact in
 * every candidate. Endpoints differ by variant; never drop it.
 */
function algorithmicCandidates(model) {
  const out = new Set()
  if (!model || typeof model !== 'string') return []
  const parts = model.split('/')

  // ── Base permutations (no version normalization yet) ──
  if (!model.startsWith('fal-ai/')) {
    // Add fal-ai/ prefix as-is.
    out.add(`fal-ai/${model}`)
    // Drop vendor (first segment): a/b/c → fal-ai/b/c
    if (parts.length >= 2) out.add(`fal-ai/${parts.slice(1).join('/')}`)
    // Drop middle segments — keep first + last (Grok pattern).
    // For 3+ segments only; for `a/b/c` produces `fal-ai/a/c`.
    if (parts.length >= 3) {
      const first = parts[0]
      const last = parts[parts.length - 1]
      out.add(`fal-ai/${first}/${last}`)
      // For 4+ segments, also try dropping each interior position.
      for (let i = 1; i < parts.length - 1; i++) {
        const reduced = [...parts.slice(0, i), ...parts.slice(i + 1)].join('/')
        out.add(`fal-ai/${reduced}`)
      }
    }
  } else {
    // Already canonical — also try the alias form (drop fal-ai/) so we
    // can resolve a request that was submitted via alias even though we
    // stored canonical.
    out.add(parts.slice(1).join('/'))
  }

  // ── Version normalization: seedance-2.0 → seedance-2 ──
  // Apply transform then re-run base permutations on the normalized form.
  const normalized = model.replace(/-(\d+)\.0(\b|\/)/g, '-$1$2')
  if (normalized !== model) {
    out.add(normalized)
    const nParts = normalized.split('/')
    if (!normalized.startsWith('fal-ai/')) {
      out.add(`fal-ai/${normalized}`)
      if (nParts.length >= 2) {
        out.add(`fal-ai/${nParts.slice(1).join('/')}`)
      }
      if (nParts.length >= 3) {
        out.add(`fal-ai/${nParts[0]}/${nParts[nParts.length - 1]}`)
      }
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
