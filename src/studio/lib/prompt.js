import { STYLES } from './constants'

// Strong product-fidelity directive injected into image prompts so packaging stays
// exact: undistorted proportions, logo facing camera, legible correctly-spelled label text.
export function productImageDirective(notes) {
  const n = (notes || '').trim()
  if (!n) return ''
  return ` PRODUCT FIDELITY (critical): reproduce the product packaging EXACTLY as in the reference image — correct shape and proportions (never stretched, squished or distorted), product upright with its front label facing the camera, and ALL label text sharp, legible and correctly spelled. Strictly respect this product knowledge: ${n}`
}

// match detected character names to reference-image labels
export function autoMapRefs(charNames, refImages) {
  const ids = []
  for (const name of charNames || []) {
    const n = String(name || '').toLowerCase().trim()
    if (!n) continue
    const ref = refImages.find((r) => {
      const l = (r.label || '').toLowerCase().trim()
      return l && (l === n || l.includes(n) || n.includes(l))
    })
    if (ref && !ids.includes(ref.id)) ids.push(ref.id)
  }
  return ids
}

// build the Gemini parse prompt — cfg: {mode,style,customStyle,ar}
// ctx: {refLabels, activeTemplate, activeBrand}
export function buildParsePrompt(naskah, cfg, ctx = {}) {
  const { mode, genMode = 'shots', style, customStyle, ar, lang = 'Indonesian' } = cfg
  const { refLabels = [], activeTemplate = null, activeBrand = null } = ctx
  const styleSuffix = style === 'custom' ? customStyle : STYLES[style] || ''
  const refHint = refLabels.length
    ? `\nAvailable reference images (use these EXACT names for chars_in_shot when applicable): ${refLabels.join(', ')}`
    : ''
  const templateBlock = activeTemplate?.analysis
    ? `\n\n══════════════════════════════════════════════════════════════
🎯 STYLE TEMPLATE TO IMITATE (user wants to mimic this reference video):
${JSON.stringify(activeTemplate.analysis, null, 2)}

CRITICAL OVERRIDE: You MUST adapt the user's script to match this template's exact style. Specifically:
- Match estimated_shot_count and shot_pacing (override default 5-8 shot rule)
- Use hook_pattern for shot 1 — replicate the opening approach
- Mirror framing, subject_treatment, camera_style, camera_movement in every video_motion field
- Inject color_grade + lighting into every image_prompt
- Caption_hook MUST follow caption_style — match language_vibe and example_phrases_seen patterns
- Use imitation_recipe as your director's bible
The NASKAH provides the WORDS; the TEMPLATE provides the VISUAL & RHYTHM. Fuse them.
══════════════════════════════════════════════════════════════`
    : ''
  const brandBlock = activeBrand && activeBrand.notes
    ? `\n\n=== BRAND KNOWLEDGE — brand "${activeBrand.name}" (respect strictly, never contradict) ===
${activeBrand.notes}
=== END BRAND KNOWLEDGE ===`
    : ''
  // ── STORYBOARD MODE: split into 3x3 grids, each grid → one 15s video ──
  if (genMode === 'storyboard') {
    return `You are a senior short-form video AD DIRECTOR. Turn this script into one or more professional 3x3 STORYBOARDS for ${ar} video.

VISUAL STYLE / TONE to embody in every panel: ${styleSuffix}
SPOKEN LANGUAGE: ${lang} — ALL dialog, titles, on-screen text MUST be natural, fluent ${lang}.${refHint}${brandBlock}${templateBlock}

HOW TO STRUCTURE:
- Estimate the script's intended total duration (look for cues like "30 detik", "1 menit", "60s"; else estimate from content; min 15s).
- Create ceil(totalDuration / 15) storyboards. Each storyboard = ~15s = EXACTLY 9 sequential beats (a 3x3 grid). Distribute beats chronologically.
- Build a clear narrative arc across the 9 panels: Hook → Problem → Product intro → Demo/usage → Result → Benefits → Testimonial → CTA → Closing tagline (adapt to the script).

EACH PANEL is an object with these fields:
  - "n": 1-9
  - "title": SHORT punchy scene label in ${lang}, ad-storyboard style (e.g. "HOOK – INTRODUCE", "MASALAH – RELATABLE MOMENT", "SOLUSI – PRODUK", "CLOSE UP PRODUK", "MANFAAT", "TESTIMONI", "CLOSING – CALL TO ACTION")
  - "visual": English. Concrete SHOT + ACTION + framing + environment + lighting. Describe what happens, NOT character faces (handled by reference images).${templateBlock ? ' Inject template color_grade + lighting.' : ''}
  - "dialog": the spoken line for this beat in ${lang} (conversational, real). "" if none.
  - "onscreen": short on-screen caption/graphic text in ${lang}, max 6 words. "" if none.
  - "shot_type": camera framing — one of "Close Up", "Medium Shot", "Wide Shot", "Product Shot".
  - "seconds": this beat's screen-time in the final video (integer 1-4). The 9 panels' seconds should sum to roughly the storyboard's ~15s.
  - "purpose": one short ${lang} phrase — the goal of this beat (e.g. "membangun relatable problem").

ALSO per storyboard:
  - "video_motion": English, ≤25 words — animate continuously through the 9 beats in order, smooth transitions.${templateBlock ? ' Match template camera_style.' : ''}
  - "dialogue": ALL spoken lines of this segment combined, in ${lang}.
  - "chars_in_shot": which characters[] appear.

Script:
${naskah}

Output ONLY valid JSON (no markdown, no commentary):
{
  "caption_hook": "...",
  "concept": "one-line creative concept of the whole video",
  "characters": ["Name1","ProductX"],
  "shots": [
    {
      "shot": 1, "duration": 15,
      "panels": [
        {"n":1,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"Medium Shot","seconds":2,"purpose":"..."},
        {"n":2,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":2,"purpose":"..."},
        {"n":3,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":2,"purpose":"..."},
        {"n":4,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":2,"purpose":"..."},
        {"n":5,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":2,"purpose":"..."},
        {"n":6,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":1,"purpose":"..."},
        {"n":7,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":1,"purpose":"..."},
        {"n":8,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":2,"purpose":"..."},
        {"n":9,"title":"...","visual":"...","dialog":"...","onscreen":"...","shot_type":"...","seconds":1,"purpose":"..."}
      ],
      "video_motion": "...", "dialogue": "...", "chars_in_shot": ["Name1"]
    }
  ]
}`
  }

  return `You are a TikTok video director AI. Convert this script into a shot list for ${ar} video.

Style: ${styleSuffix}
Mode: ${mode} (${mode === 'single_take' ? '1 shot 15 seconds' : '5-8 shots 4-8s each'})
SPOKEN LANGUAGE: ${lang} — ALL dialogue and caption text MUST be written in natural, fluent ${lang}.${refHint}${brandBlock}${templateBlock}

RULES:
- characters: array of ALL distinct subjects/objects in the script — people, products, animals, etc. Use simple short names. If reference image names are provided above, REUSE those exact names when they refer to the same entity.
- chars_in_shot: subset of characters[] that ACTUALLY appear in this specific shot. Empty array if it's a pure environment/B-roll shot.
- image_prompt: English only, describe SCENE/ENVIRONMENT/LIGHTING/CAMERA. Never describe character face/hair (handled by reference images).${templateBlock ? ' INCLUDE template color_grade and lighting cues in every image_prompt.' : ''}
- video_motion: English only, max 20 words, cinematic camera + subject motion.${templateBlock ? ' Match template camera_style and camera_movement.' : ''}
- dialogue: the actual spoken line for this shot, written ENTIRELY in ${lang} — natural & conversational. Empty string if no one speaks.
- caption_hook: max 8 words, punchy hook text in ${lang}${templateBlock ? ' — follow template caption_style.' : ''}

Script:
${naskah}

Output ONLY valid JSON (no markdown, no explanation):
{
  "caption_hook": "...",
  "characters": ["Name1","Name2","ProductX"],
  "shots": [
    { "shot": 1, "duration": 5, "image_prompt": "...", "video_motion": "...", "dialogue": "...", "chars_in_shot": ["Name1"] }
  ]
}`
}

// Assemble a precise 3x3 storyboard-sheet image prompt from structured panels.
// Targets an ad-agency pitch-board look: header title + numbered cells + labeled caption blocks.
export function buildStoryboardGridPrompt(panels = [], ar = '9:16', concept = '') {
  const nine = panels.slice(0, 9)
  let t = 0
  const cells = nine.map((p) => {
    const dur = Math.max(1, +p.seconds || 2)
    const range = `${t}-${t + dur} detik`
    t += dur
    const lines = [`Scene ${p.n} (${range}) — ${(p.title || '').toString().trim()}`]
    lines.push(`   Visual: ${(p.visual || p.scene || '').toString().trim()}`)
    if (p.dialog) lines.push(`   Dialog/VO: "${p.dialog.toString().trim()}"`)
    lines.push(`   Keterangan: ${(p.purpose || p.onscreen || '').toString().trim()}`)
    return lines.join('\n')
  }).join('\n')
  const header = (concept || 'STORYBOARD 3x3').toString().trim().toUpperCase()
  return `Design ONE professional STORYBOARD SHEET image — an ad-agency shot-breakdown TABLE — on a clean white background, ${ar} canvas.
LAYOUT (follow exactly):
- A header bar across the very top with the title: "${header}".
- Below it, a 3x3 GRID: 9 equal cells in 3 rows x 3 columns separated by thin grey table lines.
- In EACH cell, top to bottom: (a) a header strip with the SCENE NUMBER in a solid circular badge and its TIME RANGE in bold (e.g. "0-2 detik"); (b) a photographic still of the scene; (c) a small white text block with three labeled lines in tiny clean sans-serif — "Visual:", "Dialog/VO:", and "Keterangan:".
HARD RULES: keep the SAME character(s) — identical faces, wardrobe, hairstyle — and the SAME product packaging CONSISTENT across all relevant cells (use the reference images). Cohesive lighting and color grade across every cell. Crisp, correctly-spelled, legible Indonesian text. Realistic photography in the stills. No watermark.
THE 9 CELLS, in order (left to right, top to bottom):
${cells}`
}

// Gemini Vision call for template analysis (frames = [{base64}])
export async function analyzeFramesWithGemini(frames, geminiKey) {
  const prompt = `You are a senior short-form video analyst (TikTok/Reels/Shorts expert). Reverse-engineer the COMPLETE style template from these chronologically-ordered keyframes (first = beginning, last = end).

Be extremely specific and concrete. If unsure, make your best guess. NEVER use placeholder text like "..." — always commit to a real description.

Return ONLY valid JSON (no markdown fences, no preamble), with this exact schema:
{
  "aesthetic": "one-sentence overall visual identity",
  "mood": "energetic | calm | intimate | dramatic | playful | aspirational | etc.",
  "color_grade": "LUT/grading: warm or cool? saturation? black levels?",
  "lighting": "natural daylight | golden hour | softbox | harsh ring light | etc.",
  "camera_style": "handheld vlog | locked tripod | gimbal | drone | phone selfie | etc.",
  "camera_movement": "static | slow push-in | orbit | whip pan | etc.",
  "framing": "close-up portrait | medium | wide | top-down product | etc.",
  "subject_treatment": "how main subject is presented",
  "shot_pacing": "rhythm — e.g. fast cuts every 1-2s | one continuous 15s take",
  "estimated_total_duration_sec": 15,
  "estimated_shot_count": 6,
  "transitions": "hard cut | whip pan | match cut | crossfade | etc.",
  "hook_pattern": "describe the opening 1-3s in detail",
  "caption_style": {
    "present": true, "font_style": "...", "position": "...", "color": "...",
    "size": "...", "animation": "...", "language_vibe": "...", "example_phrases_seen": []
  },
  "text_overlay_style": "non-caption graphics — emojis, stickers, arrows, logos",
  "audio_implied": "talking head VO | ASMR | trap beat | trending sound | etc.",
  "energy_level": 7,
  "target_audience": "Gen Z TikTok | millennial lifestyle | etc.",
  "key_visual_elements": ["recurring props, products, environments"],
  "imitation_recipe": "concrete director's brief — how an AI should adapt a NEW script into this exact style"
}`
  const parts = [{ text: prompt }]
  for (const f of frames) parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.base64 } })
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: 'application/json' } }),
    }
  )
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)
  if (!data.candidates?.length) throw new Error('Gemini returned no candidates (safety-blocked?)')
  return data.candidates[0].content.parts[0].text || ''
}
