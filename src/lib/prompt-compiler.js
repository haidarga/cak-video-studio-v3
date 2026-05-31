// Visual Prompt Compiler — the single source of truth for assembling image and
// video prompts from structured inputs.
//
// Why this exists: prior code concatenated style-preset + IMG_QUALITY +
// productDirective + wardrobe + CONTINUITY by hand in GenerateClient.jsx.
// That produced 11 documented contradictions per gen (per workflow audit) —
// e.g. "shot on Samsung A13" + "Professional high-detail photography" in the
// same prompt. The model resolved them randomly and often picked the wrong
// aesthetic.
//
// The compiler enforces three guarantees:
//   1. TOKEN ORDER (L1 = camera, then identity, wardrobe, environment, action,
//      brand, ar, continuity, quality, negatives). Diffusion models pay more
//      attention to early tokens.
//   2. CONTRADICTION SANITIZER (CONTRADICTION_RULES below). Strips phrases that
//      fight the chosen camera / skipProduct / ar / refs context.
//   3. STYLE-AWARE QUALITY. Replaces the old unconditional IMG_QUALITY blob
//      ('Professional high-detail photography, sharp focus, ...') with a
//      preset-appropriate one-liner.

import { getCameraPreset } from './camera-presets.js'

// Contradiction rules — pattern that matches "loser" tokens + conditions
// under which they should be dropped. The sanitizer runs over each prompt
// layer separately so we can drop tokens regardless of where they appeared.
export const CONTRADICTION_RULES = [
  // Pro-photo language can't coexist with phone-cam or animation presets.
  {
    name: 'pro-quality vs casual/animation',
    match: /(Professional high-detail photography|sharp focus|well-balanced composition|high-detail|crisp detail|anatomically correct hands)/gi,
    conflicts_with: ['camera:samsung_a13_candid', 'camera:documentary_handheld', 'camera:animation_2d', 'camera:pixar_3d'],
  },
  // Cinematic language can't coexist with phone-cam or animation.
  {
    name: 'cinematic vs phone/animation',
    match: /(cinematic|ARRI Alexa|anamorphic|color graded|golden hour cinematic|Hollywood-grade|broadcast-safe)/gi,
    conflicts_with: ['camera:samsung_a13_candid', 'camera:iphone_15_clean', 'camera:animation_2d'],
  },
  // Product packaging language must yield to explicit skipProduct.
  {
    name: 'product packaging vs skipProduct',
    match: /(accurate product packaging|legible logo|product packaging EXACTLY|Product label sharp|ALL label text)/gi,
    conflicts_with: ['skipProduct=true'],
  },
  // 16:9 framing instruction collides with vertical/square AR.
  {
    name: '16:9 framing vs vertical/square',
    match: /16:9 framing-aware|widescreen framing/gi,
    conflicts_with: ['ar:9:16', 'ar:1:1'],
  },
  // Vertical framing instruction collides with horizontal AR.
  {
    name: 'vertical framing vs horizontal',
    match: /vertical 9:16( phone aesthetic)?/gi,
    conflicts_with: ['ar:16:9'],
  },
  // Photographic skin-detail tokens kill animation presets.
  {
    name: 'photographic skin vs animation',
    match: /(realistic skin texture|photographic still|natural realistic skin|authentic skin pores)/gi,
    conflicts_with: ['camera:animation_2d', 'camera:pixar_3d'],
  },
  // Wasted tokens — sound buzzwords that don't change pixels at all.
  // Dropped unconditionally regardless of camera preset.
  {
    name: 'wasted award/marketing tokens',
    match: /(ambient sound|scroll-stopping|awards-worthy|Oscar-worthy|Roger Deakins|8K cinematic|No watermark|Hollywood-grade)/gi,
    conflicts_with: ['*'],
  },
  // Continuity claim makes no sense without reference images.
  {
    name: 'continuity vs no-refs',
    match: /(CONTINUITY: keep characters identical to references|Keep character identity consistent with references)/gi,
    conflicts_with: ['refs:empty'],
  },
  // Multi-scene phrasing must yield to explicit continuous-shot intent.
  {
    name: 'multi-scene vs continuousShot',
    match: /(9 (panels?|beats?|scenes?|storyboards?)|multi-scene)/gi,
    conflicts_with: ['continuousShot=true'],
  },
  // 'IGNORE outfit from reference' line is harmful when there is no override —
  // model gets told to randomize the outfit for no reason.
  {
    name: 'ignore-outfit vs no-wardrobe-override',
    match: /IGNORE the outfit shown in (any |the )?reference photo[^.]*\./gi,
    conflicts_with: ['wardrobeOverride:empty'],
  },
]

function ruleTriggered(rule, ctx) {
  return rule.conflicts_with.some((c) => {
    if (c === '*') return true
    if (c === 'skipProduct=true') return ctx.skipProduct
    if (c === 'continuousShot=true') return ctx.continuousShot
    if (c === 'wardrobeOverride:empty') return !ctx.wardrobe
    if (c === 'refs:empty') return !ctx.refsCount
    if (c.startsWith('camera:')) return ctx.cameraId === c.slice(7)
    if (c.startsWith('ar:')) return ctx.ar === c.slice(3)
    return false
  })
}

// Strip conflicting phrases from a single string. Runs all rules in order;
// each match removes only the offending substring (not the whole layer).
export function sanitize(text, ctx) {
  if (!text) return ''
  let out = String(text)
  for (const rule of CONTRADICTION_RULES) {
    if (ruleTriggered(rule, ctx)) {
      out = out.replace(rule.match, '')
    }
  }
  // Cleanup: collapse multi-spaces, orphaned punctuation, leading/trailing junk.
  out = out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/[,.;]\s*[,.;]/g, '.')
    .replace(/^\s*[,.;]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return out
}

// Style-aware quality line. Replaces the old IMG_QUALITY blob.
function pickQuality(cam, media, skipProduct) {
  if (cam.category === 'animation') {
    return media === 'video'
      ? 'Smooth animated motion, consistent character design across frames.'
      : 'Clean stylised render, consistent character design.'
  }
  if (cam.category === 'phone') {
    return media === 'video'
      ? 'Natural handheld motion, real-person realism, no over-processing.'
      : 'Real-person realism, natural skin, no over-processing.'
  }
  // cinema + custom
  const product = skipProduct ? '' : ' Product label sharp and legible.'
  return media === 'video'
    ? `Steady framing, consistent identity.${product}`
    : `Anatomically correct, well-composed.${product}`
}

// Layer order constant — referenced by tests/logs.
export const LAYER_ORDER = [
  'L1_camera',
  'L1b_grid_header',
  'L2_identity',
  'L3_wardrobe',
  'L4_environment',
  'L5_action',
  'L6_brand',
  'L7_format',
  'L8_continuity',
  'L9_quality',
  'L10_negatives',
  'L11_edit_commands',
]

// Detect naskah-explicit style hints that should disable camera preset injection.
// Shared between image + video paths so the trigger logic stays consistent.
function detectStyleOverride(actionStr) {
  const s = String(actionStr || '').toLowerCase()
  return /\b(cctv|security cam|dashcam|body cam|found footage|surveillance|webcam|gopro|drone shot|aerial|bird's? eye|fisheye|vhs|film grain|polaroid|disposable camera|night vision|infrared|thermal|ugc)\b/i.test(s)
    // Phone-model refs: "iphone 13", "samsung a13", "galaxy s22", "pixel 8 pro", "redmi note 12".
    || /\b(iphone|samsung|xiaomi|nokia|pixel|galaxy|redmi|oppo|vivo|huawei|realme)\s+(?:[a-z]+\s*)?\d+/i.test(s)
    || /\b(?:samsung\s+galaxy|galaxy\s+[a-z]\d|note\s*\d|pixel\s*\d)/i.test(s)
}

// ── IMAGE PATH ──
// Full 11-layer compile for STILL FRAME gen (nano-banana-2/edit, gpt-image-2,
// grok-imagine-image, seedream, qwen-image-edit, etc). Layers: camera preset,
// identity, wardrobe, environment, action, brand, AR, continuity, quality,
// negatives, L11 trailing edit imperative.
//
// Owns: camera preset injection, contradiction sanitizer, style-aware quality,
// trailing CHANGE-outfit imperative (recency bias on edit endpoints).
export function compileImagePrompt(spec) {
  const {
    identity = null,
    camera = 'iphone_15_clean',
    environment = null,
    action = null,
    brand = null,
    ar = '9:16',
    skipProduct = false,
    continuousShot = false,
    refsCount = 0,
    gridHeader = null,
    wardrobe = null,
    userPresets = [],
  } = spec

  const cam = getCameraPreset(camera, userPresets)
  const ctx = { cameraId: cam.id, ar, skipProduct, continuousShot, refsCount, wardrobe: !!wardrobe, media: 'image' }

  // If the naskah specifies its own camera/style direction (CCTV, found footage,
  // smartphone X, iPhone XX, etc.), DROP camera preset + quality + negatives.
  // Otherwise the preset fights the user's explicit direction.
  const userOverrodeStyle = detectStyleOverride(action)
  const L1_camera = userOverrodeStyle ? '' : (cam.tokens?.join(', ') || '')
  const L5b_camera_echo = userOverrodeStyle
    ? ''
    : (cam.tokens?.length ? `Throughout, maintain: ${cam.tokens.slice(0, 4).join(', ')}.` : '')
  const L1b_grid = gridHeader || ''
  const L2_identity = identity ? `Subject: ${identity}.` : ''
  // L3 = soft early-token anchor; L11 carries the imperative.
  const L3_wardrobe = wardrobe ? `Wardrobe: ${wardrobe}.` : ''
  const L4_environment = environment ? `Setting: ${environment}.` : ''
  const L5_action = action || ''
  const L6_brand = (!skipProduct && brand) ? `Product: ${brand}.` : ''
  const L7_format = `${ar} composition.`
  const L8_continuity = refsCount ? 'Keep character identity consistent with references.' : ''
  const L9_quality = userOverrodeStyle ? '' : pickQuality(cam, 'image', skipProduct)
  const L10_negatives = (cam.negatives?.length && !userOverrodeStyle)
    ? `Avoid: ${cam.negatives.join(', ')}.`
    : ''

  // L11 — trailing imperative for edit endpoints (recency bias).
  const L11_edit_commands = wardrobe
    ? `CHANGE the subjects' outfit to: ${wardrobe}. Replace the reference photo outfit completely. Keep face, hair, body and identity IDENTICAL — only swap clothing.`
    : ''

  const layers = [L1_camera, L1b_grid, L2_identity, L3_wardrobe, L4_environment, L5_action, L5b_camera_echo, L6_brand, L7_format, L8_continuity, L9_quality]
  // L10 + L11 pass-through raw so sanitizer doesn't strip words from the Avoid:
  // clause or break the imperative verb.
  const cleaned = layers.map((l) => sanitize(l, ctx)).filter(Boolean)
  if (L10_negatives) cleaned.push(L10_negatives)
  if (L11_edit_commands) cleaned.push(L11_edit_commands)
  return cleaned.join('\n')
}

// ── VIDEO PATH ──
// Image-to-video gen takes a still that ALREADY contains identity + wardrobe +
// camera style baked in. Video model's job is to animate that still — so the
// prompt only needs MOTION + ACTION TIMELINE. Camera tokens, quality blob, and
// negatives are noise here: they describe how the FRAME looks (already locked)
// not how it should MOVE.
//
// Owns: minimum context (subject + setting), the action timeline verbatim from
// naskah.video_motion (passed in via `action`), AR, continuity. Nothing else.
//
// Per user directive — "TUGAS ELU CUMAN MASUKIN PRMPTNYA KE FAL.AI": no
// 11-layer compile, no preset injection, no sanitizer rewrites. Just pass
// the naskah motion through.
export function compileVideoPrompt(spec) {
  const {
    identity = null,
    environment = null,
    action = null,
    wardrobe = null,
    ar = '9:16',
    refsCount = 0,
  } = spec

  const lines = []
  if (identity) lines.push(`Subject: ${identity}.`)
  if (wardrobe) lines.push(`Wardrobe: ${wardrobe}.`)
  if (environment) lines.push(`Setting: ${environment}.`)
  if (action) lines.push(action)
  lines.push(`${ar} composition.`)
  if (refsCount) lines.push('Keep character identity consistent with references.')
  return lines.filter(Boolean).join('\n')
}

// @deprecated — use compileImagePrompt / compileVideoPrompt directly.
// Kept as a thin alias so any stale import doesn't crash.
export function compilePrompt(spec) {
  return spec?.media === 'video' ? compileVideoPrompt(spec) : compileImagePrompt(spec)
}
