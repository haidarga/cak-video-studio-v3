// Camera presets — the FIRST-PRIORITY tokens in every generated prompt.
//
// Why this exists: image/video models read tokens in ORDER. Camera identity
// must arrive first or it gets overridden by style suffix / quality boilerplate.
// Each preset bundles:
//   - tokens[]   : visual phrases injected at the top of the prompt
//   - negatives[]: phrases the sanitizer should strip from other layers when
//                  this preset wins (e.g. samsung_a13_candid strips
//                  "Professional high-detail photography")
//   - conflicts_with[]: other preset ids this is incompatible with
//   - dominance  : tiebreaker weight for sanitizer (higher wins)
//   - category   : 'phone' | 'cinema' | 'social' | 'animation' | 'custom'
//   - use_case   : human-readable hint shown in dropdown
//
// Built-ins below are the starting library — user can add/edit workspace
// custom presets via /api/workspace/camera-presets (stored in DB).

export const CAMERA_PRESETS = {
  samsung_a13_candid: {
    id: 'samsung_a13_candid',
    label: 'Samsung A13 candid (UGC)',
    category: 'phone',
    use_case: 'TikTok UGC, real-person testimonial, handheld',
    tokens: [
      // Aggressive UGC anchors — concrete real-world references model recognizes
      'accidental smartphone snapshot uploaded to whatsapp',
      'cheap Samsung Galaxy A-series phone camera quality',
      'casual handheld vertical phone video screenshot',
      'unflattering candid family photo',
      'amateur phone capture sent to family group chat',
      // Aesthetic downgraders
      'low dynamic range, crushed shadows',
      'subtle JPEG compression artifacts',
      'slight motion blur from unstable hand',
      'imperfect framing with subjects off-center',
      'natural skin texture without smoothing',
      'no color grade, no filter, no editing',
      'mild overexposure on bright spots from auto-exposure',
    ],
    negatives: [
      // Concrete anti-references — model recognizes these
      'magazine photoshoot', 'Pinterest aesthetic', 'stock photo',
      'lifestyle brand commercial', 'model agency portfolio',
      'professional family portrait', 'wedding photographer style',
      'food blog photography', 'real estate photography',
      // Standard quality negatives
      'cinematic', 'ARRI Alexa', 'anamorphic',
      'studio lighting', 'softbox', 'ring light',
      'color graded', 'HDR', '8K',
      'sharp focus everywhere', 'well-balanced composition',
      'symmetrical framing', 'rule of thirds composition',
    ],
    conflicts_with: ['cinematic_anamorphic', 'studio_tvc', 'product_macro'],
    dominance: 9,
  },
  iphone_15_clean: {
    id: 'iphone_15_clean',
    label: 'iPhone 15 clean',
    category: 'phone',
    use_case: 'Polished UGC, founder talking head, podcast clip',
    tokens: [
      'shot on iPhone 15 Pro',
      'smartphone video',
      'clean handheld',
      'natural daylight',
      'crisp detail',
      'soft skin tones',
    ],
    negatives: ['ARRI Alexa', 'anamorphic lens flare', 'film grain', 'golden hour cinematic'],
    conflicts_with: ['cinematic_anamorphic'],
    dominance: 7,
  },
  studio_tvc: {
    id: 'studio_tvc',
    label: 'Studio TVC',
    category: 'cinema',
    use_case: 'Premium brand spot, controlled lighting, locked-off',
    tokens: [
      'studio softbox lighting',
      '50mm prime lens',
      'locked-off camera',
      'color-graded',
      'sharp focus',
      'clean seamless backdrop',
    ],
    negatives: ['handheld', 'phone camera', 'motion blur', 'imperfect framing', 'UGC', 'raw unedited'],
    conflicts_with: ['samsung_a13_candid', 'iphone_15_clean'],
    dominance: 8,
  },
  cinematic_anamorphic: {
    id: 'cinematic_anamorphic',
    label: 'Cinematic anamorphic',
    category: 'cinema',
    use_case: 'Hero brand film, narrative ad, festival look',
    tokens: [
      'anamorphic 2.39 aspect',
      'shallow depth of field',
      'golden hour rim light',
      'soft halation',
      'cinematic color grade',
    ],
    negatives: ['phone camera', 'flat lighting', 'UGC', 'vertical 9:16 phone aesthetic'],
    conflicts_with: ['samsung_a13_candid', 'iphone_15_clean'],
    dominance: 8,
  },
  product_macro: {
    id: 'product_macro',
    label: 'Product macro',
    category: 'cinema',
    use_case: 'Product hero shot, e-commerce key visual',
    tokens: [
      '100mm macro lens',
      'product centered',
      'focus stacked',
      'clean white sweep',
      'soft top light',
      'label fully legible',
    ],
    negatives: ['handheld', 'motion blur', 'candid', 'UGC'],
    conflicts_with: ['samsung_a13_candid'],
    dominance: 7,
  },
  documentary_handheld: {
    id: 'documentary_handheld',
    label: 'Documentary handheld',
    category: 'cinema',
    use_case: 'Real-world story, observational style',
    tokens: [
      'observational documentary handheld',
      '35mm lens',
      'natural available light',
      'organic camera movement',
      'minimal color correction',
    ],
    negatives: ['studio softbox', 'locked-off', 'glossy commercial', 'over-stylized'],
    conflicts_with: ['studio_tvc', 'product_macro'],
    dominance: 6,
  },
  animation_2d: {
    id: 'animation_2d',
    label: '2D animation',
    category: 'animation',
    use_case: 'Animated explainer, mascot ad, kid-friendly',
    tokens: [
      '2D cartoon animation',
      'flat colors',
      'clean linework',
      'vector style',
      'no photographic detail',
    ],
    negatives: ['photographic', 'sharp focus', 'realistic skin texture', 'high-detail photography', 'ARRI', 'cinema lens', 'phone camera', 'accurate product packaging'],
    conflicts_with: ['samsung_a13_candid', 'studio_tvc', 'cinematic_anamorphic', 'product_macro', 'documentary_handheld'],
    dominance: 10,
  },
  pixar_3d: {
    id: 'pixar_3d',
    label: 'Pixar-style 3D',
    category: 'animation',
    use_case: 'Family / mascot 3D ad, character-driven CG',
    tokens: [
      'Pixar-style 3D render',
      'stylised character proportions',
      'soft global illumination',
      'subsurface scattering on skin',
    ],
    negatives: ['photographic', 'phone camera', 'UGC', 'film grain', 'documentary'],
    conflicts_with: ['samsung_a13_candid', 'cinematic_anamorphic'],
    dominance: 10,
  },
}

export const DEFAULT_CAMERA = 'iphone_15_clean'

// Legacy style id → camera preset id (back-compat for old projects/personas).
export const LEGACY_STYLE_TO_CAMERA = {
  ugc: 'samsung_a13_candid',
  social_short: 'iphone_15_clean',
  cinematic_ad: 'cinematic_anamorphic',
  tvc: 'studio_tvc',
  animation: 'animation_2d',
  '3d_render': 'pixar_3d',
  product_demo: 'product_macro',
  short_movie: 'documentary_handheld',
}

export function getCameraPreset(id, userPresets = []) {
  // 1. Check workspace custom presets first (user-defined takes precedence)
  const custom = userPresets.find((p) => p.id === id)
  if (custom) return custom
  // 2. Built-in
  if (CAMERA_PRESETS[id]) return CAMERA_PRESETS[id]
  // 3. Legacy style alias
  if (LEGACY_STYLE_TO_CAMERA[id]) return CAMERA_PRESETS[LEGACY_STYLE_TO_CAMERA[id]]
  // 4. Default fallback
  return CAMERA_PRESETS[DEFAULT_CAMERA]
}

// Merge built-ins + user custom for dropdown list.
export function listAllPresets(userPresets = []) {
  const built = Object.values(CAMERA_PRESETS)
  return [
    ...built.map((p) => ({ ...p, _builtin: true })),
    ...userPresets.map((p) => ({ ...p, _builtin: false })),
  ]
}
