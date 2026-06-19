// Scene complexity pre-flight — flags scenes the AI handles poorly BEFORE we
// spend a gen on them (so a Bulk/F-Creator run doesn't silently produce 10
// broken physics videos). Pure + side-effect-free; callers decide whether to
// warn or block.
//
// Tiers from the Content Format Playbook (empirical reliability):
//   1  → 85%+   reliable (talking head, product hold, b-roll)
//   3  → 40-50% risky (single-item placement, unboxing)
//   4  → 15-25% object-inside-object / multi-item packing (the worst)

// Object-inside-object + multi-item packing — AI can't track object state.
const TIER4_PATTERNS = [
  /\bmasuk\w*\s+.+\s+(ke\s+dalam|into|inside)/i,
  /\bpacking\b\s+.+(item|barang|produk)/i,
  /memasukkan/i,
  /\bput\w*\s+.+\s+(inside|into)\s+/i,
  /\bplace\w*\s+.+\s+(into|inside)\s+/i,
  /satu\s+per\s+satu|one\s+by\s+one/i,
]
// Single placement / unboxing / assembly — volume + sequence risk.
const TIER3_PATTERNS = [
  /\b(taruh|letakkan|simpan)\b.+\bke\b/i,
  /unbox|membuka\s+(kotak|box|kemasan)/i,
  /merakit|menyambung|assembl|install/i,
]

export function assessSceneComplexity(videoMotion, imagePrompt = '') {
  const text = `${videoMotion || ''} ${imagePrompt || ''}`
  if (TIER4_PATTERNS.some((p) => p.test(text))) {
    return {
      tier: 4,
      reliability: '15-25%',
      warning: 'Scene "benda masuk ke dalam benda" / multi-item packing terdeteksi — AI gak bisa track object state (teleport/morph/volume violation). Redesign: 1 item, tas yang udah keisi, atau angle overhead.',
    }
  }
  if (TIER3_PATTERNS.some((p) => p.test(text))) {
    return {
      tier: 3,
      reliability: '40-50%',
      warning: 'Scene interaksi objek kompleks — mungkin ada physics failure. Pertimbangkan angle overhead / sederhanain aksinya.',
    }
  }
  return { tier: 1, reliability: '85%+', warning: null }
}

// Bulk/F-Creator helper: returns only the shots that warrant a warning.
export function preflightShots(shots = []) {
  return (shots || [])
    .map((s, i) => ({ index: i + 1, ...assessSceneComplexity(s.video_motion, s.image_prompt) }))
    .filter((r) => r.warning)
}
