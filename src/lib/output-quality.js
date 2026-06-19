// Output quality scoring — an automated gate so bulk production doesn't ship
// silently-bad output. After a gen, score it on a few realism dimensions; flag
// anything below threshold for review BEFORE it reaches manual QC. This is the
// difference between "QC 350 videos blind" and "QC the 40 the system flagged".
//
// The vision call is injected (`scoreDimension`) so this module is pure +
// testable, and FAIL-SAFE: a dimension that errors is simply skipped, a fully
// failed scoring returns null (never throws, never blocks the pipeline).

export const QUALITY_DIMENSIONS = [
  {
    key: 'skin_realism', weight: 0.25,
    prompt: 'Rate 0-10: does the subject have natural skin texture (visible pores, slight asymmetry) — 10 — or smooth/plastic/retouched — 0?',
  },
  {
    key: 'motion_authenticity', weight: 0.25,
    prompt: 'Rate 0-10: if video, does motion look natural (secondary motion, breathing, weight) — 10 — or robotic/floating — 0? If still image, rate 5.',
  },
  {
    key: 'product_fidelity', weight: 0.30,
    prompt: 'Rate 0-10: if a product is shown, does it stay consistent in shape/label — 10 — or drift/morph/garble — 0? If no product, rate 7.',
  },
  {
    key: 'composition_candid', weight: 0.20,
    prompt: 'Rate 0-10: does this read as a genuine candid moment — 10 — or staged/posed/commercial/too-perfect — 0?',
  },
]

// Weighted average over the dimensions that actually got a numeric score.
export function aggregateScore(scoresByKey) {
  let sum = 0, w = 0
  for (const d of QUALITY_DIMENSIONS) {
    const s = scoresByKey?.[d.key]
    if (typeof s === 'number' && !Number.isNaN(s)) { sum += s * d.weight; w += d.weight }
  }
  return w ? Math.round((sum / w) * 100) / 100 : null
}

export function verdict(overall, threshold = 5) {
  if (overall == null) return { flagged: false, recommendation: null }
  return overall < threshold
    ? { flagged: true, recommendation: `Quality ${overall}/10 di bawah ambang ${threshold} — pertimbangkan re-generate sebelum approve.` }
    : { flagged: false, recommendation: null }
}

// scoreDimension: (url, prompt) => Promise<number 0-10>. Fail-safe + clamped.
export async function scoreOutput(url, scoreDimension, { threshold = 5 } = {}) {
  const scoresByKey = {}
  await Promise.all(QUALITY_DIMENSIONS.map(async (d) => {
    try {
      const s = await scoreDimension(url, d.prompt)
      if (typeof s === 'number' && !Number.isNaN(s)) scoresByKey[d.key] = Math.max(0, Math.min(10, s))
    } catch { /* skip this dimension — partial score is still useful */ }
  }))
  const overall = aggregateScore(scoresByKey)
  return { overall, dimensions: scoresByKey, ...verdict(overall, threshold) }
}
