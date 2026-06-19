// Shared UGC-realism helpers — the single source of truth used by BOTH the
// Generate pipeline (prompt-compiler.js) and God Mode (agent/route.js). Pure,
// no imports, so it's safe to share without coupling the two surfaces.
//
// These encode the empirical findings: concrete skin imperfection beats "natural
// skin", DIRECTIONAL light beats flat ambient, and motion needs a persistent
// biomechanics baseline (blur + secondary motion + grounding + breathing +
// easing) that is CAMERA-AWARE (handheld for phone, smooth for cinema, none for
// animation) so it never contradicts the look.

// ── Skin ─────────────────────────────────────────────────────────────
export const PHONE_SKIN = 'Visible skin pores especially on nose and cheeks, mild facial asymmetry, natural skin oiliness on T-zone, faint under-eye shadow, no beauty filter, no skin smoothing.'

// Context add-on from the scene's environment/time-of-day.
export function skinContext(environment) {
  const env = String(environment || '').toLowerCase()
  if (/outdoor|sunny|beach|pantai|pool|kolam|taman/.test(env)) return ' Sunburn flush across nose and cheeks, sun-kissed glow, freckles surfacing in direct light.'
  if (/morning|pagi|sunrise|bangun tidur/.test(env)) return ' Slight puffiness under eyes, natural just-woke morning skin.'
  return ''
}

// The skin clause (imperfection + context) — wrap with "Real-person realism." etc per surface.
export function phoneSkinClause(environment) {
  return `${PHONE_SKIN}${skinContext(environment)}`
}

// ── Lighting (directional > flat ambient) ────────────────────────────
const LIGHTING_KEYWORDS = ['sunlight', 'sun ', 'window light', 'harsh light', 'directional', 'golden hour', 'overcast', 'candlelight', 'neon', 'backlight', 'rim light', 'sinar matahari', 'cahaya jendela', 'window']
// `category` may be a string ('phone'|'cinema'|'animation') OR a preset object.
export function enrichLighting(environment, category) {
  const cat = typeof category === 'string' ? category : category?.category
  // Skip animation (clean frames) AND cinema — every cinema preset already
  // defines its own lighting in L1 tokens (studio softbox / golden hour rim /
  // soft top light / natural available light), so injecting window light here
  // would fight the preset's intent. Directional enrichment is a PHONE fix
  // (phone presets don't carry a lighting token, and flat ambient is the enemy).
  if (cat === 'animation' || cat === 'cinema') return ''
  const env = String(environment || '').toLowerCase()
  if (!env) return ''
  if (LIGHTING_KEYWORDS.some((k) => env.includes(k))) return '' // already specified — respect it
  if (/outdoor|taman|pantai|pool|kolam|beach|jalan(an)?/.test(env)) return 'Bright outdoor natural light, strong directional sunlight, hard shadow from overhead sun defining facial structure.'
  if (/pagi|morning|sunrise/.test(env)) return 'Soft morning window light from one side, gentle directional shadow, warm natural skin tones.'
  if (/sore|afternoon|evening|senja|petang|dusk/.test(env)) return 'Warm late-afternoon directional light, golden long shadows, warm amber skin tone.'
  return 'Strong natural light from a nearby window casting a directional shadow on the face, single-source lighting creating natural depth — not flat ambient light.'
}

// ── Motion realism (camera-aware) ────────────────────────────────────
const PHONE_MOTION_BY_SCENE = {
  beauty_application: 'Hands in motion with natural blur during application, genuine contact with the skin (not floating), hair responding to head movement.',
  talking_head: 'Slight natural motion blur as the subject speaks and gestures; hair and shoulders with natural secondary motion; subtle breathing and occasional blink; natural easing in and out of every move, nothing robotic.',
  product_reveal: 'Brief motion blur as the product enters frame, settling into clear focus; natural arm arc with visible weight; the product stays RIGID — only the hand moves it, the product itself never deforms.',
  walking_transition: 'Natural stride with arm swing and grounded foot contact, secondary motion in hair and clothing, camera following naturally with organic deceleration.',
  broll: 'Handheld camera movement with natural acceleration and deceleration, motion blur in the direction of the pan, subtle camera breathing.',
  default: 'Slight natural motion blur from handheld movement; secondary motion in hair and clothing; subtle breathing and weight shift; natural easing, nothing stops abruptly.',
}
const CINEMA_MOTION = 'Smooth controlled camera movement (gimbal/dolly), steady framing, subtle secondary motion in hair and clothing, natural easing — no handheld shake.'

export function inferSceneType(action) {
  const a = String(action || '').toLowerCase()
  if (/apply|makeup|skincare|blend|lipstick|foundation|oles|usap wajah/.test(a)) return 'beauty_application'
  if (/walk|enters frame|transition|berjalan|jalan|masuk frame/.test(a)) return 'walking_transition'
  if (/\bpan\b|b-?roll|establishing|environment shot/.test(a)) return 'broll'
  if (/product|reveal|angkat|tunjuk|hold up|demonstrate|showcase/.test(a)) return 'product_reveal'
  if (/speak|talk|dialogue|bicara|ngomong|smile|senyum|\bnod\b|look at camera/.test(a)) return 'talking_head'
  return 'default'
}

// category: 'phone' (default/UGC) | 'cinema' | 'animation'.
// sceneType (optional): when the PARSER tagged the scene (reliable), pass it to
// skip the brittle regex inference. Falls back to inferSceneType(action).
export function motionRealismFor(action, category = 'phone', sceneType = null) {
  if (category === 'animation') return ''
  if (category === 'cinema') return CINEMA_MOTION
  const st = (sceneType && PHONE_MOTION_BY_SCENE[sceneType]) ? sceneType : inferSceneType(action)
  return PHONE_MOTION_BY_SCENE[st] || PHONE_MOTION_BY_SCENE.default
}

// God Mode has no camera-preset system, so infer the look from the prompt text
// to pick the right realism flavor (and never inject phone skin pores into an
// animation/3D request, or handheld shake into a cinematic one).
export function inferCategoryFromText(text) {
  const t = String(text || '').toLowerCase()
  if (/\b(2d|cartoon|anime|animation|animated|pixar|claymation|3d render|cgi render|illustration|vector)\b/.test(t)) return 'animation'
  if (/cinematic|anamorphic|arri|film look|movie still|studio (lighting|softbox)|tvc|commercial spot|hollywood/.test(t)) return 'cinema'
  return 'phone'
}
