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

// Trim brand notes to <=200 chars of visual cues only. Brand "notes" fields
// tend to be marketing copy — most of it is irrelevant to the image model
// (mission statements, target audience, etc). We keep the first sentence
// plus any obvious visual descriptors (colors, shapes, materials).
export function productNotesShort(brand) {
  if (!brand) return null
  const notes = (brand.notes || brand.toString() || '').trim()
  if (!notes) return null
  const firstSentence = notes.split(/[.!?]\s/)[0] || ''
  const visualCues = (notes.match(/(red|blue|green|gold|silver|black|white|matte|glossy|round|square|cylindrical|sachet|bottle|tube|jar|can|pouch|label|logo|kemasan|botol|kaleng|tube|sachet)[^.,]{0,40}/gi) || [])
    .slice(0, 4)
    .map((s) => s.trim())
    .join(', ')
  return [firstSentence, visualCues].filter(Boolean).join('. ').slice(0, 200)
}
