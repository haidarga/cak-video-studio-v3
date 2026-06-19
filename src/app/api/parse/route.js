// POST /api/parse — parse naskah pake LLM (workspace-configured), return shot list or storyboard panels.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGeminiJSON } from '@/lib/gemini-server'
import { getActiveWorkspace } from '@/lib/workspace'

export async function POST(req) {
  const { naskah, lang = 'Indonesian', mode = 'shots', ar = '9:16', refLabels = [], brand = null, constraints = {}, shotCount = null, continuation = null } = await req.json()
  if (!naskah?.trim()) return NextResponse.json({ ok: false, error: 'naskah kosong' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)

  const refHint = refLabels.length
    ? `\nAvailable reference labels (use exact names in chars_in_shot when applicable): ${refLabels.join(', ')}`
    : ''
  // Skip brand block when user opts out of product placement — prevents
  // Gemini from cramming product into CTA panel.
  const brandBlock = (brand?.notes && !constraints.skipProduct)
    ? `\nBRAND KNOWLEDGE (respect strictly, never contradict):\n${brand.notes}`
    : ''

  // Build constraint hint block — user-explicit overrides take precedence over
  // default ad-storyboard structure.
  const constraintLines = []
  if (constraints.continuousShot) constraintLines.push('- This is a SINGLE CONTINUOUS take, no cuts. Panels describe MOMENTS within one flowing shot, not separate scenes.')
  if (constraints.skipDialog) constraintLines.push('- NO spoken dialog or VO. Set "dialog" to empty string "" for all panels.')
  if (constraints.skipOnscreen) constraintLines.push('- NO onscreen text or caption overlay. Set "onscreen" to empty string "" for all panels.')
  if (constraints.skipProduct) constraintLines.push('- NO product placement. Do not include any product, package, or brand item in any panel. No "Product Shot" type. Final panel is just a closing moment, not a product CTA.')
  const constraintBlock = constraintLines.length
    ? `\n\nHARD USER CONSTRAINTS (override defaults — respect strictly):\n${constraintLines.join('\n')}`
    : ''

  const isStory = mode === 'storyboard'
  const isDirect = mode === 'direct'
  const shotTypes = constraints.skipProduct
    ? 'Close Up|Medium Shot|Wide Shot'
    : 'Close Up|Medium Shot|Wide Shot|Product Shot'

  // Continuation mode — the caller ("Continue shot/storyboard") passes the FULL
  // naskah + a summary of beats already produced + the model's max clip length.
  // The LLM returns ONLY the next segment, capped to the model duration, so a
  // long script unrolls into a continuous chain of shots.
  const continuationBlock = continuation
    ? `\n\nCONTINUATION MODE — the Script below is the FULL story. These beats have ALREADY been produced as earlier shots:\n${continuation.coveredSummary || '(nothing yet — this is the opening)'}\n\nProduce ONLY the NEXT segment that picks up immediately AFTER the covered beats and moves the story FORWARD. Do NOT repeat covered beats. Do NOT restart from the beginning. ${isStory ? 'Output a storyboard for just this next segment (fewer than 9 panels is fine if little story remains).' : `Cap EACH shot's duration to <= ${continuation.maxDuration || 10}s.`} If the story is already fully covered, produce one short natural closing beat instead of inventing new plot.`
    : ''

  // Visual abstraction layer — parser now extracts VISUAL TOKENS not screenplay
  // prose. Storyboard schema gains:
  //   - shared `environment` field (set + lighting + time-of-day)
  //   - shared `wardrobe` field (outfit per character, extracted from naskah)
  //   - top-level `video_motion` for the whole sequence
  // Direct-video schema: NO image_prompt because we skip the image-gen step
  // entirely. The reference photos uploaded by the user ARE the visual anchor;
  // the model goes straight text+refs -> video via reference-to-video. We still
  // emit environment/wardrobe so the motion prompt has context, plus a
  // beat-by-beat video_motion per shot (this is the only thing the video model
  // sees).
  const schema = isStory
    ? `{
  "concept": "one-line creative concept (English)",
  "environment": "one-line setting + lighting + time-of-day shared across all panels (English, e.g. 'small neighborhood park, late afternoon golden light, scattered passersby')",
  "wardrobe": "outfit description for the subjects, extracted from the naskah if mentioned. Format: 'Character1 wears X. Character2 wears Y.' Empty string if naskah doesn't specify outfits — DO NOT invent.",
  "video_motion": "one-line camera-movement description for the whole sequence (English, max 20 words). If user toggled continuousShot, describe a single fluid take with no cuts.",
  "characters": ["Name1"],
  "panels": [
    {"n":1,"title":"HOOK","visual":"English ACTION + camera angle only — do NOT describe faces or outfit (those are locked)","dialog":"${constraints.skipDialog ? '' : `line in ${lang}`}","onscreen":"${constraints.skipOnscreen ? '' : `short ${lang} caption`}","shot_type":"${shotTypes}","seconds":2,"chars_in_shot":["Name1"]}
    // 9 panels total. Each panel.visual is just the action + framing — no aesthetic words, no lighting words (env handles that), no face/outfit details.
  ]
}`
    : isDirect
      ? `{
  "characters": ["Name1"],
  "environment": "one-line setting + lighting + time-of-day shared across all shots",
  "wardrobe": "outfit description per character, extracted from naskah if mentioned. Empty string if not specified.",
  "shots": [
    {"shot":1,"duration":5,"scene_type":"talking_head|beauty_application|product_reveal|walking_transition|broll|default","video_motion":"English BEAT-STRUCTURED TIMELINE with timestamped sub-shots. Format: '[0-Xs] <action + camera angle>. [X-Ys] <action shift + camera move>. [Y-Zs] <final beat>.' Each beat ~2-3s. Map naskah narrative elements (action, camera moves, mood shifts, character reactions, prop reveals) to specific time ranges. Include camera transitions between beats (push-in / pull-back / cut / pan). DO NOT include caption text or subtext overlays in the timeline — those are added separately in the editor. Focus on what HAPPENS visually + how camera moves.","dialogue":"${constraints.skipDialog ? '' : `line in ${lang}`}","chars_in_shot":["Name1"]}
  ]
}`
      : `{
  "characters": ["Name1"],
  "environment": "one-line setting + lighting + time-of-day shared across all shots",
  "wardrobe": "outfit description per character, extracted from naskah if mentioned. Empty string if not specified.",
  "shots": [
    {"shot":1,"duration":5,"scene_type":"talking_head|beauty_application|product_reveal|walking_transition|broll|default","image_prompt":"English ACTION + camera angle only — do NOT describe faces or outfit","video_motion":"English motion max 20 words","dialogue":"${constraints.skipDialog ? '' : `line in ${lang}`}","chars_in_shot":["Name1"]}
  ]
}`

  // Hard rules applied universally (used to be guard only in per-shot mode).
  const universalRules = [
    'NEVER describe faces in detail (eye color, exact features, hair texture). Character identity is locked by reference photos.',
    'CARDINAL RULE — ADAPT THE NASKAH FAITHFULLY. If the user wrote specific instructions, OBEY them verbatim. Treat the naskah as a brief: every concrete direction in it (camera move, mood, style label, composition cue, action verb, prop, color hint, time-of-day, lighting word) belongs in the appropriate output field. DO NOT generalize away the user\'s specifics. Generic output is a failure.',
    'IMPORTANT — image_prompt vs video_motion are STRUCTURALLY DIFFERENT, do not write the same text into both:',
    '  • image_prompt = ONE FROZEN MOMENT. A single still frame. Describe the PEAK / most cinematic instant of the action — the climax of the scene the video will play through. NEVER list a sequence ("X then Y then Z") in image_prompt — diffusion models render sequences as multi-panel collages / 4-grid storyboards, which is broken. Pick ONE verb in present-continuous tense ("panda aiming the firearm at intruders") not a chain ("breaks door, then aims, then shoots").',
    '  • video_motion = FULL ACTION TIMELINE. Beat-by-beat description of the whole sequence the image-to-video model has to play out. Repeat the verb chain ("first the panda forces the door, then raises the firearm, then fires at the intruders"). Without this the model just freezes the source image.',
    'Mapping for explicit instructions in the naskah → output fields:',
    '  • Camera moves / shakiness / handheld / dolly / pan / push-in / pull-back → video_motion.',
    '  • Camera framing / shot type / angle (close-up, wide, low angle, OTS) → image_prompt.',
    '  • Mood / style / vibe words (candid, intimate, raw, gritty, polished, dreamy, cozy, tense) → BOTH image_prompt and video_motion (so the still and the motion both carry the tone — these are aesthetic, not sequential, so safe to repeat).',
    '  • Color palette / tone hints (pastel, warm, moody, monochrome, vibrant, grainy, found footage) → BOTH (same reason — aesthetic tags, not sequential).',
    '  • Outfit / wardrobe / clothing description → wardrobe field (single source of truth).',
    '  • Set / location / time-of-day / lighting context → environment field.',
    '  • Style references the user names (UGC, iPhone 13 style, BTS doc, music-video, TVC) → BOTH image_prompt and video_motion as a short tag.',
    'COLLAGE FAILURE MODE: if image_prompt ends up containing "then", "lalu", "kemudian", "after", or multiple action verbs joined sequentially, the image model will produce a 2x2 / 3x3 surveillance-grid collage instead of one cohesive frame. STRICT — image_prompt has ONE verb / ONE moment only.',
    'Use VISUAL TOKENS — concrete actions, camera angles, props, named styles. ONLY filter EMPTY adjectives that convey no visual ("beautiful", "stunning", "amazing", "perfect", "epic"). Everything else the user wrote is signal — keep it.',
    'OUTFIT EXTRACTION (strict — single source of truth): scan ONLY the naskah text for explicit clothing words (oversized t-shirt, kemeja batik, daster, jeans, gamis, kerudung, sneakers, formal outfit, casual outfit, pastel colors, etc). Put it in the shared `wardrobe` field. Preserve modifiers the user wrote ("kinda pastel", "smart casual", "all black", "parents formal, kids casual pastel", etc.). STRICT RULES: (1) If the naskah text does NOT contain explicit clothing words, set wardrobe to empty string ""; (2) NEVER infer outfit from persona name, persona description, or reference photo context; (3) NEVER guess or default to "blazer", "shirt", or any generic clothing — empty string is correct when naskah is silent.',
    'OUTPUT TYPE STRICTNESS: every string field in the schema must be a JSON STRING, not an array or object. If the naskah lists multiple outfits, JOIN them into one string ("parents wear formal outfit, kids wear casual pastel"). If multiple camera moves, join with commas. Never return [].',
    'MOTION-STATE EXCEPTION to the collage rule: descriptors of ONE moving instant are SAFE in image_prompt and must be KEPT, not stripped — "in motion", "mid-action", "hands reaching toward", "slight motion blur", "mid-gesture", "caught mid-movement". These describe a single frame that happens to be in motion, NOT a sequence. Only BAN true temporal chains (two+ separate events: "opens the door THEN aims"). Test: one moving condition = keep; two events in order = ban.',
    'LIGHTING DIRECTIONALITY (realism — critical): when the naskah names or implies a light source or time-of-day, PRESERVE its DIRECTION and HARDNESS in the environment field — e.g. "harsh direct sunlight from one side", "strong single window light, hard shadow", "late-afternoon directional sun". Do NOT flatten it into generic "natural light" / "bright lighting" / "well-lit". Hard directional light (single window / sun) is the single biggest realism lever: hard shadows give facial structure, specular highlights read as a real photo. Flat ambient light reads as AI.',
    'SCENE TYPE: for each shot set scene_type to the dominant motion — talking_head (speaking to camera), beauty_application (applying product to face/skin), product_reveal (lifting/showing a product), walking_transition (walking/entering frame), broll (environment/pan, no main subject action), or default. It tunes the motion-realism baseline; pick the closest.',
    'REALISM OVER POLISH: this is candid real-person content, NOT a catalog shoot. Favor unstaged framing and natural moments over perfectly composed, symmetrical, magazine-style shots. Never add "professional", "studio", "perfect", "flawless", "8K", "cinematic" unless the naskah explicitly asks for a polished/cinematic look.',
    refLabels.length ? `Character names MUST come from this list (use exact names in chars_in_shot): ${refLabels.join(', ')}` : null,
  ].filter(Boolean).map((r) => `- ${r}`).join('\n')

  const prompt = `You are a cinematographer translating script into VISUAL TOKENS (not screenplay prose) for a diffusion image/video model.

SPOKEN LANGUAGE: ${lang} — ALL dialog written in fluent native ${lang}.${refHint}${brandBlock}${constraintBlock}

UNIVERSAL RULES:
${universalRules}
${continuationBlock}

TASK: Convert this script into ${
    isStory
      ? 'ONE 3x3 storyboard (9 panels, ~15s total)'
      : isDirect
        ? (shotCount
            ? `EXACTLY ${shotCount} DIRECT VIDEO shot${shotCount > 1 ? 's' : ''} (each 5-10s). Each shot is generated DIRECTLY from text + reference photos — no intermediate still frame.

CRITICAL: video_motion for EACH shot must be a TIMESTAMPED BEAT TIMELINE that maps the naskah's visual narrative. Format example for a 6s shot:

  "[0-2s] Wide shot: Emma raises phone up, child in arms, looking at mirror. Handheld iPhone UGC style. [2-4s] Push-in to medium: Emma smiles softly, child reaches up. Mood lifts. [4-6s] Cut to close-up child's face, eyes widen with curiosity, gentle laugh."

Map every ACTION, CAMERA MOVE, MOOD SHIFT, and CHARACTER REACTION in the naskah to a specific time bracket. DO NOT render caption/subtext/text overlays in the timeline — those are added in the editor post-gen. Focus exclusively on what happens VISUALLY + camera direction.`
            : `as many DIRECT VIDEO shots as the naskah needs (minimum 1, typical 2-5, each 5-10s). Each shot is generated DIRECTLY from text + reference photos — no intermediate still frame.

CRITICAL: video_motion for EACH shot must be a TIMESTAMPED BEAT TIMELINE that maps the naskah's visual narrative. Format example for a 6s shot:

  "[0-2s] Wide shot: Emma raises phone up, child in arms, looking at mirror. Handheld iPhone UGC style. [2-4s] Push-in to medium: Emma smiles softly, child reaches up. Mood lifts. [4-6s] Cut to close-up child's face, eyes widen with curiosity, gentle laugh."

Map every ACTION, CAMERA MOVE, MOOD SHIFT, and CHARACTER REACTION in the naskah to a specific time bracket. DO NOT render caption/subtext/text overlays in the timeline — those are added in the editor post-gen. Focus exclusively on what happens VISUALLY + camera direction.`)
        : shotCount
          ? `EXACTLY ${shotCount} shot${shotCount > 1 ? 's' : ''} (each 3-10s based on action density)`
          : 'as many shots as the naskah naturally demands (minimum 1, typical 3-8, each shot 3-10s). Short naskah = fewer shots, long naskah = more shots. Don\'t pad with filler shots'
  } for a ${ar} video.

Output ONLY valid JSON, no markdown:
${schema}

Script:
${naskah}`

  try {
    const parsed = await callGeminiJSON({
      workspaceId: wsId,
      contents: [{ parts: [{ text: prompt }] }],
      temperature: 0.7,
      maxOutputTokens: 16384,
    })
    return NextResponse.json({ ok: true, parsed })
  } catch (e) {
    // Transient Gemini errors (overload, rate limit) return 200 with ok:false
    // so the browser doesn't log a scary 503/429. UI handles ok:false soft.
    const httpStatus = e?.transient ? 200 : (e?.status || 500)
    return NextResponse.json({ ok: false, error: String(e?.message || e), transient: !!e?.transient }, { status: httpStatus })
  }
}
