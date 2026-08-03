// The generation constraint toggles, in one place.
//
// They live on globalConfig in /generate, but the Studio Inbox needs to set them
// too — clicking "Eksekusi All Batch" used to launch a 21-shot run using
// whatever the constraints happened to default to, which is how a batch came out
// with dialogue or on-screen text nobody wanted. The Inbox now picks them up
// front and passes them through the URL.
//
// Shared so the two surfaces cannot drift apart on key names or defaults.

export const GEN_CONSTRAINTS = [
  { key: 'continuousShot', label: '🎬 No cuts', hint: 'satu take, tanpa potongan kamera' },
  { key: 'skipDialog', label: '🔇 No dialog', hint: 'gak ada omongan — B-roll / visual doang' },
  { key: 'skipOnscreen', label: '📝 No text', hint: 'gak ada teks/caption kebakar di video' },
  { key: 'skipProduct', label: '📦 No product', hint: 'produk gak dipaksa nongol di frame' },
  { key: 'autoVoiceSwap', label: '🎙 Auto voice swap', hint: '~$0.30/video dialog · pakai voice persona' },
  { key: 'seedLock', label: '🔒 Seed konsisten', hint: 'hasil re-gen mirip, gak ngacak' },
]

const KEYS = GEN_CONSTRAINTS.map((c) => c.key)

// Serialize to a compact URL value: only the ENABLED keys, comma separated.
// Returns '' when nothing is on — callers should still send the param so the
// receiver can tell "explicitly all off" from "not specified at all".
export function serializeConstraints(config = {}) {
  return KEYS.filter((k) => !!config[k]).join(',')
}

// Parse back. `null`/`undefined` means the caller said nothing, so return null
// and let the existing defaults stand — NOT an object of all-false, which would
// silently switch off defaults like autoVoiceSwap.
export function parseConstraints(raw) {
  if (raw === null || raw === undefined) return null
  const on = new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))
  const out = {}
  for (const k of KEYS) out[k] = on.has(k)
  return out
}

// Starting state for the Inbox modal — mirrors GenerateClient's own defaults so
// the toggles show what would actually happen if the user changes nothing.
export function defaultConstraints() {
  return {
    continuousShot: false,
    skipDialog: false,
    skipOnscreen: false,
    skipProduct: false,
    autoVoiceSwap: true,
    seedLock: false,
  }
}
