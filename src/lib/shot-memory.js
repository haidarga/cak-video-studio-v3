// SHOT MEMORY — the continuity brain the Continue / Link / long-form flows carry
// between shots.
//
// THE GAP THIS CLOSES (confirmed by two code-explorer audits): the old
// continuity re-derived environment/wardrobe from the ORIGINAL naskah TEXT,
// completely blind to what the diffusion model actually rendered. If shot 1
// rendered a different outfit/location than the script said, shot 2 never knew.
// There was NO vision analysis of the rendered frame anywhere.
//
// The fix: after a shot renders, a vision model reads its LAST FRAME and emits a
// structured state object (extraction lives in /api/shot-memory/extract). THIS
// file is the pure logic that consumes that state and shapes it into prompt
// context — kept pure so every branch is unit-tested.
//
// Canonical shape:
//   { location, characters: string[], wardrobe: {char: outfit},
//     last_action, props: string[], lighting }

const asArr = (v) =>
  Array.isArray(v) ? v.filter((x) => String(x).trim()).map((x) => String(x).trim())
    : (v && String(v).trim() ? [String(v).trim()] : [])

// A state is only worth carrying if it says something concrete about the scene.
// Character names alone aren't enough — we already know those from the persona.
export function isUsableState(state) {
  if (!state || typeof state !== 'object') return false
  const hasWardrobe = state.wardrobe && typeof state.wardrobe === 'object' &&
    Object.values(state.wardrobe).some((v) => String(v).trim())
  return !!(String(state.location || '').trim() || String(state.last_action || '').trim() || hasWardrobe)
}

// Coerce a raw LLM extraction into the canonical shape; return null if unusable.
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null
  const wardrobe = {}
  if (raw.wardrobe && typeof raw.wardrobe === 'object' && !Array.isArray(raw.wardrobe)) {
    for (const [k, v] of Object.entries(raw.wardrobe)) {
      if (String(v ?? '').trim()) wardrobe[String(k)] = String(v).trim()
    }
  }
  const state = {
    location: String(raw.location || '').trim(),
    characters: asArr(raw.characters),
    wardrobe,
    last_action: String(raw.last_action || '').trim(),
    props: asArr(raw.props),
    lighting: String(raw.lighting || '').trim(),
  }
  return isUsableState(state) ? state : null
}

const wardrobePairs = (state) =>
  (state?.wardrobe && typeof state.wardrobe === 'object')
    ? Object.entries(state.wardrobe).filter(([, v]) => String(v).trim())
    : []

// The context block injected into the NEXT shot's image + video prompt. This is
// what makes the next shot continue from OBSERVED state, not the script.
export function buildContinuityBlock(state) {
  if (!isUsableState(state)) return ''
  const lines = []
  if (state.location) lines.push(`Setting continues: ${state.location}.`)
  const wr = wardrobePairs(state)
  if (wr.length) lines.push(`Wardrobe (keep IDENTICAL to the previous shot): ${wr.map(([c, o]) => `${c} wears ${o}`).join('; ')}.`)
  if (state.characters?.length) lines.push(`Characters present: ${state.characters.join(', ')}.`)
  if (state.props?.length) lines.push(`Props still in the scene: ${state.props.join(', ')}.`)
  if (state.last_action) lines.push(`The previous shot ENDED with: ${state.last_action}. Continue naturally from that exact moment.`)
  if (state.lighting) lines.push(`Lighting: ${state.lighting}.`)
  return `CONTINUITY FROM PREVIOUS SHOT (observed from the actually-rendered frame — this OVERRIDES the script wherever they conflict):\n${lines.join('\n')}`
}

// Merge observed render-state over the static parsed fields: OBSERVED wins for
// environment/wardrobe when present (this is what corrects render drift); keep
// the parsed values otherwise.
export function mergeContinuity(parsed = {}, state) {
  const out = { environment: parsed?.environment || '', wardrobe: parsed?.wardrobe || '' }
  if (!isUsableState(state)) return out
  if (String(state.location || '').trim()) out.environment = state.location.trim()
  const wr = wardrobePairs(state)
  if (wr.length) out.wardrobe = wr.map(([c, o]) => `${c} wears ${o}`).join(', ')
  return out
}

// Compact one-line tag appended to the naskah sent to /api/parse so the next
// segment is written grounded in what was actually on screen.
export function summarizeStateForParse(state) {
  if (!isUsableState(state)) return ''
  const bits = []
  if (state.location) bits.push(`location: ${state.location}`)
  const wr = wardrobePairs(state)
  if (wr.length) bits.push(`wardrobe: ${wr.map(([c, o]) => `${c}=${o}`).join(', ')}`)
  if (state.last_action) bits.push(`last action: ${state.last_action}`)
  return `[CONTINUITY STATE from the previous shot — this was actually on screen, keep it consistent: ${bits.join('; ')}]`
}
