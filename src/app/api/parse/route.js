// POST /api/parse — parse naskah pake LLM (workspace-configured), return shot list or storyboard panels.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGeminiJSON } from '@/lib/gemini-server'
import { getActiveWorkspace } from '@/lib/workspace'
import { clampPanelsToMaxSeg } from '@/lib/script-segments'

export async function POST(req) {
  const { naskah, lang = 'Indonesian', mode = 'shots', ar = '9:16', refLabels = [], brand = null, constraints = {}, shotCount = null, continuation = null, maxSegmentDuration = 8, cameraPreset = null } = await req.json()
  if (!naskah?.trim()) return NextResponse.json({ ok: false, error: 'naskah kosong' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)

  const refHint = refLabels.length
    ? `\nAvailable reference labels (use exact names in chars_in_shot when applicable): ${refLabels.join(', ')}`
    : ''
  // Brand notes are TONE/ACCURACY context only — NOT a license to insert a
  // product. Without the explicit guard below, "respect strictly" made Gemini
  // cram the brand's product into a CTA panel even when the naskah never
  // mentioned a product (e.g. a Golden Rama *travel* script sprouting a
  // margarine shot). The naskah is authoritative for what appears on screen.
  const brandBlock = (brand?.notes && !constraints.skipProduct)
    ? `\nBRAND CONTEXT (for tone + factual accuracy ONLY — do NOT add any product, package, or brand item to the visuals unless the NASKAH itself explicitly calls for it):\n${brand.notes}`
    : ''

  // Camera preset context — tells the parser WHICH visual style is active so
  // image_prompt/environment get written with real technical specificity
  // (e.g. flash physics for a candid-nightlife phone preset, lighting-rig
  // detail for a studio preset) instead of generic "candid"/"cinematic"
  // labels. Without this the parser writes style-blind prose and the preset's
  // own tokens (applied later, downstream in the compiler) are the ONLY
  // technical detail in the final prompt — much thinner than a hand-written
  // prompt from someone who knows the preset's specific look.
  const cameraBlock = cameraPreset
    ? `\nACTIVE VISUAL STYLE: "${cameraPreset.label}"${cameraPreset.category ? ` (${cameraPreset.category})` : ''}.${cameraPreset.tokens?.length ? ` Style tokens already applied downstream: ${cameraPreset.tokens.slice(0, 10).join(', ')}.` : ''}${cameraPreset.detail_hint ? `\nWrite image_prompt/environment consistent with THIS specific look: ${cameraPreset.detail_hint}` : ''}`
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
  const isLong = mode === 'longform'
  // Per-segment cap = the chosen video model's max clip length (e.g. Veo 8s,
  // Seedance/Kling 15s). The naskah is split so each segment fits in one clip.
  const maxSeg = Math.max(2, Math.min(15, parseInt(maxSegmentDuration) || 8))
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
  const schema = isLong
    ? `{
  "concept": "one-line overall concept of the WHOLE video (English) — the throughline every segment shares",
  "characters": ["Name1"],
  "environment": "one-line setting + lighting + time-of-day shared across segments (English)",
  "wardrobe": "outfit per character extracted from naskah if mentioned, else empty string",
  "segments": [
    {"n":1,"seconds":${maxSeg},"transition":"start","video_motion":"English timestamped beat timeline for THIS segment only. Format '[0-Xs] <action + camera>. [X-Ys] <next beat>.' ~2-3s per beat.","dialog":"${constraints.skipDialog ? '' : `the ${lang} line(s) spoken DURING this segment only (empty if none)`}","chars_in_shot":["Name1"]}
  ]
}`
    : isStory
    ? `{
  "concept": "one-line creative concept (English)",
  "environment": "one-line setting + lighting + time-of-day shared across all panels (English, e.g. 'small neighborhood park, late afternoon golden light, scattered passersby')",
  "wardrobe": "outfit description for the subjects, extracted from the naskah if mentioned. Format: 'Character1 wears X. Character2 wears Y.' Empty string if naskah doesn't specify outfits — DO NOT invent.",
  "video_motion": "one-line camera-movement description for the whole sequence (English, max 20 words). If user toggled continuousShot, describe a single fluid take with no cuts.",
  "characters": ["Name1"],
  "panels": [
    {"n":1,"title":"Brief Scene Title","visual":"REQUIRED, NEVER empty — English: shot type + what the subject is DOING + the EXPRESSION/emotion that matches this panel's dialogue (tired, regretful, surprised, urging). If the naskah is dialog-only with no action, STILL write a sensible talking-head visual with the right emotion + a small natural gesture. Do NOT describe facial structure/identity (locked by refs).","dialog":"${constraints.skipDialog ? '' : `line in ${lang}`}","onscreen":"${constraints.skipOnscreen ? '' : `short ${lang} caption`}","shot_type":"${shotTypes}","seconds":3,"chars_in_shot":["Name1"]}
    // PANEL COUNT = 4, 6, or 9 (clean grid). Cover EVERY beat incl. the final CTA — split a long beat to reach a clean count, never drop one (see TASK for the duration rules). Each panel.visual is just the action + framing — no aesthetic words, no lighting words (env handles that), no face/outfit details.
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
    {"shot":1,"duration":5,"scene_type":"talking_head|beauty_application|product_reveal|walking_transition|broll|default","image_prompt":"English — the FROZEN peak moment, VIVID + specific (this is what makes the shot expressive, not generic): ONE action + camera framing (DEFAULT = natural EYE-LEVEL, straight-on, phone-at-face-height UGC framing; ONLY use a different shot type/angle if the naskah explicitly names one; NEVER invent a low-angle / high-angle / worm's-eye / dutch-tilt) + the EXACT EMOTIONAL EXPRESSION (e.g. tired eyes with a soft genuine smile, eyebrows raised in surprise, a small regretful frown, eyes welling up, mid-laugh) + body language / micro-gesture (hand near chin, shoulders slumped, leaning in) + candid mood. Do NOT describe facial STRUCTURE or identity (eye color, exact features, hair — locked by refs), but DO capture the feeling vividly. Match the emotion to the dialogue/beat.","video_motion":"English motion max 20 words","dialogue":"${constraints.skipDialog ? '' : `line in ${lang}`}","chars_in_shot":["Name1"]}
  ]
}`

  // Hard rules applied universally (used to be guard only in per-shot mode).
  const universalRules = [
    'PRE-FORMATTED STORYBOARDS (CRITICAL): If the naskah is already formatted as a storyboard (e.g. contains "Panel 1", "Visual:", "Audio:", "Kamera:", timestamps), YOU MUST EXACTLY EXTRACT the panels given. DO NOT invent a new story, do not summarize, do not hallucinate a generic script based on the title. Map the user\'s exact visual, camera, and audio instructions directly into the JSON fields. Preserve the user\'s exact dialogue.',
    'NEVER describe faces in detail (eye color, exact features, hair texture). Character identity is locked by reference photos.',
    'EXPRESSION IS NOT IDENTITY — capture it vividly (do NOT strip it). Emotional expression, gaze direction, micro-expression and gesture (tired eyes, soft smile, surprised, regretful, mid-laugh, leaning in, hand to chin) are what make a shot EXPRESSIVE instead of generic/dead. ALWAYS include the shot\'s emotion + body language in image_prompt, matched to the dialogue/beat. Banning "face detail" means structure/identity ONLY (eye color, features), NEVER the emotion.',
    'CARDINAL RULE — ADAPT THE NASKAH FAITHFULLY. If the user wrote specific instructions, OBEY them verbatim. Treat the naskah as a brief: every concrete direction in it (camera move, mood, style label, composition cue, action verb, prop, color hint, time-of-day, lighting word) belongs in the appropriate output field. DO NOT generalize away the user\'s specifics. Generic output is a failure.',
    'NO INVENTED PRODUCTS (critical — the naskah is authoritative for what appears on screen): NEVER add a product, package, bottle, box, brand item, logo, "Product Shot", or product-CTA panel unless the NASKAH TEXT itself explicitly mentions or shows that product. If the script has no product (e.g. a travel, lifestyle, or storytelling piece), then ZERO products appear in ANY shot/panel and there is NO product-reveal or product-CTA — even if a brand name is attached to the job or BRAND CONTEXT is provided. A brand being present is NOT permission to insert its product. When in doubt, leave the product OUT.',
    'IMPORTANT — image_prompt vs video_motion are STRUCTURALLY DIFFERENT, do not write the same text into both:',
    '  • image_prompt = ONE FROZEN MOMENT. A single still frame. Describe the PEAK / most cinematic instant of the action — the climax of the scene the video will play through. NEVER list a sequence ("X then Y then Z") in image_prompt — diffusion models render sequences as multi-panel collages / 4-grid storyboards, which is broken. Pick ONE verb in present-continuous tense ("panda aiming the firearm at intruders") not a chain ("breaks door, then aims, then shoots").',
    '  • video_motion = FULL ACTION TIMELINE. Beat-by-beat description of the whole sequence the image-to-video model has to play out. Repeat the verb chain ("first the panda forces the door, then raises the firearm, then fires at the intruders"). Without this the model just freezes the source image.',
    'Mapping for explicit instructions in the naskah → output fields:',
    '  • Camera moves / shakiness / handheld / dolly / pan / push-in / pull-back → video_motion.',
    '  • Camera framing / shot type / angle (close-up, wide, low angle, OTS) → image_prompt.',
    'DEFAULT CAMERA ANGLE (critical — the #1 cause of "why is it always tilted/looking up"): when the naskah does NOT explicitly name a camera angle, ALWAYS default to a NEUTRAL, NATURAL EYE-LEVEL straight-on framing — camera held at the subject\'s face height, looking level (normal selfie / UGC framing). Do NOT invent dramatic or stylized angles. NEVER add "low angle", "high angle", "worm\'s eye", "bird\'s eye", "dutch tilt", "looking up at", "looking down at", "tilted", or "from below/above" unless those exact words appear in the naskah. A dramatic angle on a candid talking-head reads as wrong/off-balance. Eye-level is the correct default.',
    '  • SUBJECT ORIENTATION ≠ CAMERA ANGLE (critical — "kenapa gak madep depan, malah serong"): camera angle (low/high/eye-level) is WHERE the camera is; subject orientation is WHICH WAY the person FACES. "straight-on view" only sets the CAMERA — it does NOT make the person face the lens. When the naskah says the subject faces front/camera ("tampak depan", "madep/menghadap depan", "menghadap/lihat kamera", "hadap depan", "eye contact", "facing camera/front", "looking at camera"), you MUST encode it EXPLICITLY and DOMINANTLY in image_prompt: the subject\'s FACE and TORSO are squared toward the camera, head up, eyes/gaze directed at the lens. This OVERRIDES the natural pose of any task.',
    '  • ACTION must NOT turn the subject away from a requested facing: if the naskah asks the subject to face the camera AND also performs a downward/inward task (chopping, cooking, typing, reading, writing, applying makeup), keep them FACING THE CAMERA and only their HANDS do the task — phrase it as "<doing task> while facing the camera and glancing up at the lens", NOT "focused on <task>" / "looking down at <task>" / "leaning forward over the <surface>". Do NOT add pose cues that rotate or tilt them away from the requested facing: BAN "looking down at", "head down", "downcast", "focused intently on the task", "slight lean forward over the counter", "turned toward the counter/table", "3/4 turn", "profile", "side view" — UNLESS the naskah explicitly asked for them. The requested facing wins over the task\'s default head-down posture.',
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
    'TECHNICAL SPECIFICITY, NOT GENERIC LABELS (critical — the #1 gap between a prompt that reads as AI and one that reads as a real photo): write environment/image_prompt like a photographer describing an ACTUAL scene, not a mood-board caption. "harsh direct on-camera flash creating blown highlights and a hard shadow behind the subject" beats "flash photography". "large softbox 45° camera-left with low fill" beats "studio lighting". "specular highlights on sweaty skin, motion blur from nearby dancers" beats "energetic nightclub atmosphere". If ACTIVE VISUAL STYLE above includes a detail_hint, follow it closely and reuse its level of physical/technical detail — that is the bar for every shot, not just the first one.',
    'DIALOG PACING (CRITICAL — prevents rushed/sped-up speech): keep each shot\'s spoken line SHORT enough to be said UNHURRIED within its duration — budget ~2 words per second (2s shot = MAX ~4-5 words, 3s = ~6-7, 5s = ~10-12). If the natural line is longer, TRIM it to the essential message — fewer words is ALWAYS better than fast speech. NEVER cram a long sentence into a short clip; split across shots or cut words. A rushed unintelligible voiceover is a failure.',
    'SCENE TYPE: for each shot set scene_type to the dominant motion — talking_head (speaking to camera), beauty_application (applying product to face/skin), product_reveal (lifting/showing a product), walking_transition (walking/entering frame), broll (environment/pan, no main subject action), or default. It tunes the motion-realism baseline; pick the closest.',
    'REALISM OVER POLISH: this is candid real-person content, NOT a catalog shoot. Favor unstaged framing and natural moments over perfectly composed, symmetrical, magazine-style shots. Never add "professional", "studio", "perfect", "flawless", "8K", "cinematic" unless the naskah explicitly asks for a polished/cinematic look.',
    'MOTION = CONTROLLED, ANTI-MORPH (critical for video_motion): write motion that is GENTLE, smooth and physically grounded. AVOID extreme/fast/whip pans, rapid zooms, violent or fast action, fast spins, sudden big camera moves — fast/extreme motion is what makes AI video MORPH, melt and drift. Small deliberate movements > big dramatic ones. Map the naskah\'s action but keep its PACE calm.',
    'PRODUCT/OBJECT MOTION (anti-drift — when a product or object is in the shot): the product is a RIGID manufactured item. Keep it mostly STATIC with stable shape, proportions and label; movement comes from the PERSON or CAMERA, NEVER from the product deforming, melting, morphing, fast-rotating, flipping or transforming. If it is handled, ONLY the hand moves it — the product itself stays rigid. NEVER write "product spins fast / rotates 360 / transforms / morphs". Gentle reveal/hold only.',
    refLabels.length ? `Character names MUST come from this list (use exact names in chars_in_shot): ${refLabels.join(', ')}` : null,
  ].filter(Boolean).map((r) => `- ${r}`).join('\n')

  const prompt = `You are a cinematographer translating script into VISUAL TOKENS (not screenplay prose) for a diffusion image/video model.

SPOKEN LANGUAGE: ${lang} — ALL dialog written in fluent native ${lang}.${refHint}${brandBlock}${cameraBlock}${constraintBlock}

UNIVERSAL RULES:
${universalRules}

CALIBRATION EXAMPLE — this is the BAR for image_prompt/environment detail. Rules alone don't reliably move output quality; match the DENSITY of this example on every shot, not just when the naskah happens to be detailed:
BAD (generic, reads as AI — do NOT write like this): "Woman dancing at a club, energetic candid expression, colorful lighting."
GOOD (technically specific, reads as a real photo — write like this): "Caught off guard mid-dance, looking slightly away from camera. Direct on-camera flash creates harsh frontal light with blown-out highlights on her skin and a hard shadow behind her against the club wall; neon pink and blue ambient lighting bleeds in at the edges, slight motion blur from nearby dancers, natural unsmoothed skin texture."
The GOOD version isn't longer for padding — every clause is a checkable physical detail (light source + its behavior, shadow, motion, texture). That is the bar.
${continuationBlock}

TASK: Convert this script into ${
    isLong
      ? `a LONG-FORM PLAN: split the FULL naskah into sequential SEGMENTS, each <= ${maxSeg}s (each segment = one generated video clip, stitched in order). Rules:
- Cover the ENTIRE naskah in order — no gaps, no repeats.
- USE THE FEWEST SEGMENTS POSSIBLE. Make each segment as LONG as allowed (pack it close to ${maxSeg}s). Every extra segment = another seam where the video looks disjointed, so DON'T over-split. Only start a new segment when (a) the content genuinely exceeds ${maxSeg}s, OR (b) the naskah has a real HARD CUT to a new scene/location/b-roll. A continuous monologue of 12s on a 15s-cap model = ONE segment, not two.
- Split dialog so each segment's spoken line FITS its seconds at ~2 words/sec (unhurried). Trim, never cram.
- transition (CRITICAL — FOLLOW THE NASKAH, never force): first segment = "start". For each later segment, "continuous" if it flows from the SAME shot/scene/action with NO visual cut (next clip starts exactly where the previous ended → seamless handoff); "cut" if the naskah moves to a NEW scene, angle, location, or b-roll (clean hard cut, generated fresh).
- video_motion = a short timestamped beat timeline for THAT segment only.`
      : isStory
      ? `ONE storyboard = ONE video clip, and one clip can be AT MOST ${maxSeg}s long (the model physically cannot render more in a single clip).
- PANEL COUNT must be a CLEAN GRID: 4 (2x2), 6 (2x3), or 9 (3x3) — the SMALLEST clean count that gives each beat you include its own panel. If the beats you include don't land on a clean count, SPLIT the longest one into two panels; never delete a beat to fit the grid. Do NOT invent an extra product/CTA panel the script doesn't have.
- HOW MUCH OF THE SCRIPT TO COVER — read the script's timestamps / stated duration and decide:
  • SCRIPT FITS IN ${maxSeg}s (its total is <= ${maxSeg}s): storyboard the ENTIRE script. Cover EVERY beat including the final closing / CTA line (often the most important — never drop it). The SUM of panel.seconds MUST EQUAL the script's stated total (a "15 detik" script sums to exactly 15). Do NOT undershoot — an 11s storyboard for a 15s script is WRONG.
  • SCRIPT IS LONGER THAN ${maxSeg}s (e.g. a 30s script on a ${maxSeg}s model): storyboard ONLY the beats that fall inside the FIRST ${maxSeg}s of the script, IN ORDER, with panel.seconds summing to about ${maxSeg}s. Do NOT time-compress or cram the WHOLE script into ${maxSeg}s — the LATER beats are generated separately as a CONTINUATION clip. Stop at the natural beat boundary closest to ${maxSeg}s and leave the rest.
  • CONTINUATION MODE is active (see the CONTINUATION MODE block above): storyboard ONLY the NEXT beats that come AFTER the already-covered ones, again capped to ${maxSeg}s. Do NOT restart, do NOT repeat any covered beat.
- Per-panel seconds: 2-5s each.`
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
      // Lowered from 0.7 — this call needs CONSISTENCY (same technical-detail
      // density every time) far more than creative variety. High temperature
      // was the main source of "sometimes great, sometimes generic" output.
      temperature: 0.35,
      // Bumped from 16384 — the TECHNICAL SPECIFICITY rule + calibration
      // example (added to fix generic output) make Gemini write meaningfully
      // longer image_prompt/environment strings per shot. On a 9-panel
      // storyboard that pushed total JSON output past 16384 and got cut off
      // mid-string ("balik bukan JSON valid"). 24576 matches the headroom
      // BulkTab already uses for the same storyboard parse shape.
      maxOutputTokens: 24576,
    })
    // DETERMINISTIC duration guard — the LLM does not reliably obey "sum to
    // <=${maxSeg}s", so enforce it in code. A single clip physically cannot
    // exceed the model cap; clamp here so a 19s/6-panel storyboard on a 15s
    // model becomes exactly 15s, proportions kept, no panel dropped.
    if (isStory && Array.isArray(parsed?.panels) && parsed.panels.length) {
      parsed.panels = clampPanelsToMaxSeg(parsed.panels, maxSeg)
    }
    return NextResponse.json({ ok: true, parsed })
  } catch (e) {
    // Transient Gemini errors (overload, rate limit) return 200 with ok:false
    // so the browser doesn't log a scary 503/429. UI handles ok:false soft.
    const httpStatus = e?.transient ? 200 : (e?.status || 500)
    return NextResponse.json({ ok: false, error: String(e?.message || e), transient: !!e?.transient }, { status: httpStatus })
  }
}
