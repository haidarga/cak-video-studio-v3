// Identity helpers — anchor character + product descriptions in prompts so
// the model has consistent referents across shots / panels.

// Compose a one-line identity sentence from a list of character names + the
// persona records keyed by name (or id). Used as the L2_identity layer in
// the prompt compiler.
//
// Example output: "Emma (28yo Indonesian woman, shoulder-length black hair,
// warm tan skin) and Anak Emma (4yo Indonesian girl, pigtails)"
export function buildIdentitySentence(charsInShot = [], personas = []) {
  if (!Array.isArray(charsInShot) || charsInShot.length === 0) return null
  const byName = {}
  const byId = {}
  personas.forEach((p) => {
    if (p.name) byName[p.name] = p
    if (p.id) byId[p.id] = p
  })
  const parts = charsInShot.map((ref) => {
    const p = byName[ref] || byId[ref] || personas.find((x) => x.name === ref)
    if (!p) return ref // fall back to bare name if persona not found
    const desc = (p.character_prompt || '').trim()
    return desc ? `${p.name} (${desc.slice(0, 200)})` : p.name
  }).filter(Boolean)
  return parts.length ? parts.join(' and ') : null
}

// Build a product brief for image gen. Caller passes EITHER a brand
// object (with .notes) OR a concatenated product knowledge string.
// Returns up to ~500 chars of relevant content.
//
// Previously this truncated to 200 chars + cherry-picked a hardcoded list
// of visual keywords (red/blue/black/sachet/...). For products with rich
// spec (UGREEN: GaN, 65W, 2x USB-C, 1x USB-A, foldable plug, matte
// black, 5x3x2 cm), that 200-char + keyword filter DROPPED dimensions,
// port counts, model numbers, brand text — everything the model needs
// to render the product correctly. Result: drift across shots.
//
// New behavior:
//   1. Cap at 500 chars (was 200) — still trimmed enough to not blow
//      the diffusion token budget, but room for one paragraph of spec.
//   2. No keyword filter — preserve user's literal description. The
//      model is better at extracting visual cues from natural language
//      than our regex was at second-guessing what's "visual".
//   3. Collapse whitespace + dedupe lines so concatenated knowledge
//      from multiple refs doesn't have repeated boilerplate.
export function productNotesShort(brand) {
  if (!brand) return null
  const raw = (typeof brand === 'string' ? brand : (brand.notes || brand.description || '')).trim()
  if (!raw) return null

  // Normalize whitespace; dedupe identical lines (multi-ref concat often
  // repeats the same brand boilerplate).
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const seen = new Set()
  const unique = []
  for (const l of lines) {
    const key = l.toLowerCase()
    if (!seen.has(key)) { seen.add(key); unique.push(l) }
  }
  const cleaned = unique.join('. ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 500)
}
