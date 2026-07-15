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
    // detail_hint — fed to the naskah PARSER (not the sanitizer) so it writes
    // image_prompt/environment with real photographic-physics vocabulary
    // instead of generic "candid" language. This is what separates a hand-
    // written pro prompt from a templated one: SPECIFIC light behavior, not
    // just a style label.
    detail_hint: 'If the scene is dim/low-light or nightlife (bar, club, party, dark room): describe REALISTIC ON-CAMERA FLASH PHYSICS explicitly — direct built-in LED flash firing straight at the subject creates harsh frontal lighting, blown-out bright highlights on skin and near-lens clothing, a hard-edged dark shadow cast directly behind the subject onto the wall/background, and a visible color mismatch between the cool white flash and warm/colorful ambient lighting behind. In bright/daylight scenes: describe mild overexposure and crushed shadows from auto-exposure instead. Always weave in: slight motion blur from an unsteady hand, natural unsmoothed skin texture, and an unposed, off-axis body angle.',
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
      '30fps self-recorded phone cadence',
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
    detail_hint: 'Describe the SPECIFIC light source shaping the shot (a window to one side, an overhead kitchen light, overcast daylight through a car window) and how it falls on the face — direction and softness, not just "natural light". Mention the subject in a believable mid-motion state (adjusting hair, mid-sentence mouth shape, weight shifting) rather than a frozen pose, and skin that reads as real (visible pores/texture) without beauty-filter smoothing.',
    tokens: [
      'shot on iPhone 15 Pro',
      'smartphone video',
      'clean handheld',
      // Motion-blur was the missing realism token on the most-used preset
      // (it read crisp+posed, not handheld+candid). Slight blur + mid-motion
      // hides skin smoothness / rigid hands without killing iPhone sharpness.
      'slight natural motion blur from handheld movement',
      'subject in mid-natural-motion',
      'natural daylight',
      '30fps social media recording', // self-recorded cadence, not 24fps cinematic
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
    detail_hint: 'Describe the ACTUAL lighting setup, not just the label "studio lighting": key light angle and size (e.g. large softbox 45° camera-left, low fill ratio for contrast, or high-key even fill for a beauty-brand look), how the background falls off (pure seamless white vs. subtly gradient-lit), and specular highlight behavior on skin/product surfaces. Name the mood the setup creates (crisp/punchy vs. soft/premium).',
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
    detail_hint: 'Describe the SPECIFIC optical signature: the shape and color of the anamorphic flare (horizontal blue-ish streak off a hard highlight), the characteristic oval/stretched bokeh in the background, exact color-grade direction (teal shadows / warm skin, bleach-bypass, desaturated) and the quality + direction of the key light (low warm sun behind the subject, a single practical lamp, etc.) — not just "cinematic".',
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
    detail_hint: 'Describe exactly how light shapes the product surface — a soft overhead light creating a gentle top-to-bottom gradient on a glossy surface, or a rim light separating a matte product from the background — and the material behavior (specular glossy reflections vs. diffuse matte, sharp focus-stacked edges front-to-back). Call out the exact label/text placement staying crisp and legible.',
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
    detail_hint: 'Name the ACTUAL light source that would exist in that real location (window light, overhead fluorescent, a single practical lamp, overcast sky) rather than "natural light" as a generic label, and describe camera movement as purposeful/observational (following the subject, reframing to catch a moment) rather than shaky-for-its-own-sake.',
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
    detail_hint: 'Describe line weight (thin clean outlines vs. bold cel-shading), flat color-fill blocking with no gradients, and how the expression reads through simplified shapes (exaggerated eyebrow/mouth shapes for emotion) rather than photographic facial detail.',
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
    detail_hint: 'Describe subsurface scattering visible on skin/ears when backlit, soft bounce/global-illumination fill light (no harsh single-source shadows), stylised proportions (slightly larger eyes/head, softened features), and material shading consistent with a Pixar-grade render (soft fabric, glossy eyes).',
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
