// Cinematic Move presets — library of pre-built camera movement / motion
// prompts that get injected into a shot's video_motion field. Inspired by
// Higgsfield's "Bullet Time / 360° / Push-In" preset library, adapted for
// fal.ai video models (Seedance, Kling, Grok, etc).
//
// Each preset is just a structured prompt fragment. When the user picks a
// preset from the UI, we append `preset.prompt` to the shot's video_motion
// field. No model-side change needed — these are pure prompt engineering.
//
// Categories help group presets in the picker UI without hardcoding order.

export const CINEMATIC_CATEGORIES = [
  { id: 'camera_move', label: '🎥 Camera Moves', desc: 'Push, pull, pan, tilt, orbit' },
  { id: 'time_effect', label: '⏱ Time Effects', desc: 'Bullet time, slow-mo, time freeze' },
  { id: 'reveal', label: '🎬 Reveals', desc: 'Pull-back reveal, drop-in, transitions' },
  { id: 'product', label: '📦 Product Shots', desc: 'Hero shots, e-commerce, 360 spin' },
  { id: 'cinematic', label: '🎞 Cinematic', desc: 'Tracking, dolly, crane, handheld' },
  { id: 'social', label: '📱 Social Media', desc: 'UGC, vertical-first, scroll-stopper' },
]

export const CINEMATIC_PRESETS = [
  // ── Camera Moves ──
  {
    id: 'push_in_dramatic',
    category: 'camera_move',
    label: '🔍 Push-In Dramatic',
    desc: 'Slow zoom toward subject, builds tension',
    prompt: 'Camera slowly pushes in toward the subject, building dramatic tension. Smooth dolly motion, no shake. Subject stays centered. Background subtly blurs as camera moves closer.',
  },
  {
    id: 'pull_back_reveal',
    category: 'reveal',
    label: '📤 Pull-Back Reveal',
    desc: 'Wide reveal from close-up',
    prompt: 'Camera pulls back smoothly from a tight close-up to reveal the full scene. Smooth dolly out. Wide environment context appears gradually. Cinematic reveal motion.',
  },
  {
    id: 'orbit_360',
    category: 'camera_move',
    label: '🔄 360° Orbit',
    desc: 'Smooth full circle around subject',
    prompt: 'Camera orbits 360 degrees around the subject at a steady, cinematic pace. Subject stays centered in frame. Smooth circular motion, no jitter. Reveals subject from every angle.',
  },
  {
    id: 'whip_pan',
    category: 'camera_move',
    label: '💨 Whip Pan',
    desc: 'Fast lateral motion, transition feel',
    prompt: 'Fast horizontal whip pan motion blur, simulating a quick head turn or scene transition. Motion blur during the pan, sharp at start and end.',
  },
  {
    id: 'crane_overhead',
    category: 'camera_move',
    label: '🏗 Crane Overhead',
    desc: 'High-angle descend to subject',
    prompt: 'Crane shot descending from a high overhead angle down to the subject. Smooth vertical motion, subject grows in frame as camera lowers.',
  },
  {
    id: 'handheld_pov',
    category: 'cinematic',
    label: '📷 Handheld POV',
    desc: 'First-person, slight shake, immersive',
    prompt: 'Handheld first-person POV with natural slight camera shake, as if the subject is filming themselves. iPhone-style authentic motion, not stabilized.',
  },
  {
    id: 'dolly_track',
    category: 'cinematic',
    label: '🎞 Dolly Track',
    desc: 'Smooth lateral tracking parallel to subject',
    prompt: 'Camera tracks smoothly parallel to the moving subject. Constant distance maintained. Cinematic dolly-track shot, like a rail-mounted camera.',
  },

  // ── Time Effects ──
  {
    id: 'bullet_time',
    category: 'time_effect',
    label: '🎯 Bullet Time',
    desc: 'Slow 360 around frozen subject',
    prompt: 'Bullet time effect — subject appears frozen mid-action while the camera rotates slowly around them at 360 degrees. Time stands still on the subject, smooth orbital motion.',
  },
  {
    id: 'slow_motion',
    category: 'time_effect',
    label: '🐢 Slow Motion',
    desc: 'Cinematic slow-mo, detail-rich',
    prompt: 'Cinematic slow motion, action plays out at 1/4 speed. Detail-rich, smooth high-frame-rate feel. Every micro-expression and movement visible.',
  },
  {
    id: 'speed_ramp',
    category: 'time_effect',
    label: '⚡ Speed Ramp',
    desc: 'Normal → slow → normal speed shift',
    prompt: 'Speed ramping effect — starts at normal speed, ramps down to slow motion at the key moment, then ramps back to normal. Dramatic emphasis on the peak action.',
  },

  // ── Product Shots ──
  {
    id: 'product_360_spin',
    category: 'product',
    label: '📦 Product 360° Spin',
    desc: 'Slow rotation showcase, e-commerce style',
    prompt: 'Product rotates slowly 360 degrees on its axis on a clean neutral background. Studio lighting, no shadows on subject. E-commerce product showcase style. Smooth turntable motion.',
  },
  {
    id: 'product_hero_macro',
    category: 'product',
    label: '🔬 Product Macro Reveal',
    desc: 'Extreme close-up detail, then pull back',
    prompt: 'Extreme macro close-up of product detail (texture, logo, finish), then smooth pull-back to reveal full product. Showcases craft and detail. Studio lighting, shallow depth of field.',
  },
  {
    id: 'product_drop_in',
    category: 'product',
    label: '🪂 Product Drop-In',
    desc: 'Product enters frame from above with bounce',
    prompt: 'Product drops into frame from above with a slight bounce on landing. Clean white or studio background. Energetic product reveal shot.',
  },
  {
    id: 'product_unbox',
    category: 'product',
    label: '📭 Unboxing POV',
    desc: 'First-person hands opening package',
    prompt: 'First-person POV of hands opening the product package. Natural lighting, hands frame visible. Reveal moment as product is lifted out. UGC unboxing style, authentic.',
  },

  // ── Cinematic ──
  {
    id: 'epic_reveal',
    category: 'cinematic',
    label: '🌅 Epic Reveal',
    desc: 'Wide cinematic establishing shot, slow motion',
    prompt: 'Cinematic wide establishing shot, slow horizontal pan revealing the full environment. Golden hour lighting, epic atmospheric depth. Movie trailer feel.',
  },
  {
    id: 'tracking_shot',
    category: 'cinematic',
    label: '🚶 Tracking Shot',
    desc: 'Follows subject as they walk/move',
    prompt: 'Camera tracks alongside the subject as they walk, keeping them centered in frame. Smooth lateral motion, environment passes behind. Cinematic walking shot.',
  },
  {
    id: 'over_shoulder',
    category: 'cinematic',
    label: '👤 Over-the-Shoulder',
    desc: 'Behind subject looking at what they see',
    prompt: 'Over-the-shoulder shot from behind the subject, showing what they see in front of them. Subject occupies the foreground edge, focus on what they observe.',
  },
  {
    id: 'low_angle_hero',
    category: 'cinematic',
    label: '⬆ Low-Angle Hero',
    desc: 'Looking up at subject, makes them powerful',
    prompt: 'Low-angle hero shot looking up at the subject from below. Subject appears powerful, dominant. Slight upward tilt, sky or ceiling visible above subject.',
  },

  // ── Social Media ──
  {
    id: 'tiktok_hook',
    category: 'social',
    label: '📱 TikTok Hook Open',
    desc: 'Direct-to-camera close-up with motion energy',
    prompt: 'TikTok hook opener: direct-to-camera medium-close shot, subject leans into camera with energy. Vertical 9:16 framing. Strong eye contact. Scroll-stopping presence.',
  },
  {
    id: 'ugc_handheld',
    category: 'social',
    label: '📲 UGC Handheld',
    desc: 'Authentic phone-style handheld, natural light',
    prompt: 'UGC handheld smartphone-style shot, natural slight shake, authentic non-professional feel. Window light or natural daylight. iPhone Pro recording aesthetic.',
  },
  {
    id: 'split_screen',
    category: 'social',
    label: '⬛ Split Screen',
    desc: 'Two parallel actions side by side',
    prompt: 'Split-screen composition with two parallel actions side by side. Both halves move in sync. Vertical division through frame center.',
  },
  {
    id: 'before_after',
    category: 'social',
    label: '↔ Before/After Transition',
    desc: 'Wipe transition from before to after state',
    prompt: 'Before/After transition: starts with the "before" state, then a smooth wipe or fade reveals the "after" state. Clean comparison framing.',
  },

  // ── Reveals ──
  {
    id: 'walk_into_frame',
    category: 'reveal',
    label: '🚶‍♂️ Walk Into Frame',
    desc: 'Empty frame, subject enters from side',
    prompt: 'Camera holds on an empty composed frame. Subject walks into frame from the side, settles into center. Natural entrance, no cut.',
  },
  {
    id: 'door_open_reveal',
    category: 'reveal',
    label: '🚪 Door Open Reveal',
    desc: 'POV opening door to discover scene',
    prompt: 'First-person POV of opening a door to reveal the scene inside. Gradual reveal as door swings open. Anticipation building moment.',
  },
  {
    id: 'curtain_drop',
    category: 'reveal',
    label: '🎭 Curtain Drop',
    desc: 'Veil/curtain pulled to reveal product',
    prompt: 'A curtain or veil drops/pulls away to reveal the product or subject underneath. Dramatic reveal moment, magic-trick feel.',
  },
]

// Helper: pick preset by id
export function getPresetById(id) {
  return CINEMATIC_PRESETS.find((p) => p.id === id) || null
}

// Helper: group presets by category for UI rendering
export function groupPresetsByCategory() {
  const groups = {}
  for (const cat of CINEMATIC_CATEGORIES) groups[cat.id] = { ...cat, presets: [] }
  for (const preset of CINEMATIC_PRESETS) {
    const g = groups[preset.category]
    if (g) g.presets.push(preset)
  }
  return Object.values(groups)
}
