# CAK Video — Prompt Pipeline (naskah → prompt → fal.ai)

Ultra-detailed reference for how a script (`naskah`) becomes the actual prompt sent to fal.ai, across **every mode** and using **every camera preset**. Pulled verbatim from:
- `src/app/api/parse/route.js` — the parser (naskah → structured tokens)
- `src/lib/camera-presets.js` — the camera presets (L1 visual identity)
- `src/app/(dash)/generate/_lib/prompt-compiler.js` — the compiler (structured → final prompt)
- `src/lib/fal-client.js` → `buildStoryboardGridPrompt` — 9 panels → grid image prompt

---

## 0. The pipeline at a glance

```
naskah (you write)
   │
   ▼  POST /api/parse   — Gemini (callGeminiJSON, temp 0.7, maxOutputTokens 16384)
structured JSON         — schema differs per mode (panels / shots)
   │
   ▼  compile            — compileImagePrompt / compileVideoPrompt / buildStoryboardGridPrompt
final prompt string      — layered + contradiction-sanitized
   │
   ▼  buildImgInput / buildVidInput  — per-model fal field names
fal.ai
```

**Two separate brains:**
- **Parser** (`/api/parse`): turns prose into *visual tokens* in the right structured field. It never builds the final prompt — it produces structured data.
- **Compiler** (`prompt-compiler.js`): assembles structured fields into the final prompt, in a fixed token order, and strips self-contradictions.

The split exists because mixing them (the old code) produced ~11 contradictions per gen (e.g. `shot on Samsung A13` + `Professional high-detail photography` in one prompt).

---

## 1. The three modes

| Mode | `mode` value | Parse output | Image step? | Video path |
|------|--------------|--------------|-------------|------------|
| **Per-Shot** | `shots` | N shots, each with `image_prompt` + `video_motion` | ✅ still frame first | image-to-video |
| **Storyboard** | `storyboard` | 9 panels + shared `environment`/`wardrobe`/`video_motion` | ✅ one 3×3 grid image | reference-to-video (grid = sequence map) |
| **Direct** | `direct` | N shots, only `video_motion` timelines | ❌ skipped | text + reference photos → reference-to-video |

- **Per-Shot**: highest control — every shot gets a still you can approve, then animate. Image carries identity/wardrobe/style; video only adds motion.
- **Storyboard**: 9 keyframes in one image (cheap), then animated as ref-to-video. Best for a quick ~15s sequence with locked character.
- **Direct**: no intermediate image. Reference photos ARE the visual anchor; the model goes straight text+refs → video. Used when you trust the refs and want fewer steps.

> God Mode is a **separate surface** (conversational agent, `/api/god-mode/agent`). It does NOT use this naskah parser — the agent picks a tool and builds prompts inline. This doc covers the **Generate** pipeline (naskah-driven).

---

## 2. THE PARSER — `/api/parse`

### 2.1 Request inputs
```
{ naskah, lang='Indonesian', mode='shots', ar='9:16',
  refLabels=[], brand=null, constraints={}, shotCount=null, continuation=null }
```
- `refLabels` — names of the uploaded character/product refs (so `chars_in_shot` uses exact names).
- `brand.notes` — brand knowledge block (skipped if `constraints.skipProduct`).
- `constraints` — the 4 toggles: `continuousShot`, `skipDialog`, `skipOnscreen`, `skipProduct`.
- `shotCount` — force an exact number of shots/segments.
- `continuation` — `{ coveredSummary, maxDuration }` for "Continue shot/storyboard".

### 2.2 The system prompt (verbatim skeleton)
```
You are a cinematographer translating script into VISUAL TOKENS (not screenplay prose)
for a diffusion image/video model.

SPOKEN LANGUAGE: <lang> — ALL dialog written in fluent native <lang>.
<refHint><brandBlock><constraintBlock>

UNIVERSAL RULES:
<universalRules>
<continuationBlock>

TASK: Convert this script into <mode-specific task> for a <ar> video.

Output ONLY valid JSON, no markdown:
<schema>

Script:
<naskah>
```

### 2.3 UNIVERSAL RULES (verbatim — the keyword engine)
These are injected on **every** parse, all modes:

1. **NEVER describe faces** in detail (eye color, exact features, hair texture). Identity is locked by reference photos.
2. **CARDINAL RULE — ADAPT THE NASKAH FAITHFULLY.** If the user wrote specific instructions, OBEY them verbatim. Treat the naskah as a brief: every concrete direction (camera move, mood, style label, composition cue, action verb, prop, color hint, time-of-day, lighting word) belongs in the appropriate output field. DO NOT generalize away the user's specifics. Generic output is a failure.
3. **`image_prompt` vs `video_motion` are STRUCTURALLY DIFFERENT — never write the same text into both:**
   - **`image_prompt` = ONE FROZEN MOMENT.** A single still. Describe the PEAK/most cinematic instant. NEVER list a sequence ("X then Y then Z") — diffusion models render sequences as multi-panel collages. ONE verb in present-continuous ("panda aiming the firearm at intruders"), not a chain.
   - **`video_motion` = FULL ACTION TIMELINE.** Beat-by-beat description of the whole sequence the image-to-video model plays out. Repeat the verb chain ("first the panda forces the door, then raises the firearm, then fires").
4. **Mapping for explicit naskah instructions → output fields:**
   - Camera moves / shakiness / handheld / dolly / pan / push-in / pull-back → `video_motion`
   - Camera framing / shot type / angle (close-up, wide, low angle, OTS) → `image_prompt`
   - Mood / style / vibe (candid, intimate, raw, gritty, polished, dreamy, cozy, tense) → **BOTH** `image_prompt` and `video_motion`
   - Color palette / tone (pastel, warm, moody, monochrome, vibrant, grainy, found footage) → **BOTH**
   - Outfit / wardrobe / clothing → `wardrobe` field (single source of truth)
   - Set / location / time-of-day / lighting → `environment` field
   - Style references the user names (UGC, iPhone 13 style, BTS doc, music-video, TVC) → **BOTH** as a short tag
5. **COLLAGE FAILURE MODE:** if `image_prompt` contains "then", "lalu", "kemudian", "after", or multiple sequential verbs, the image model produces a 2×2 / 3×3 surveillance-grid collage. STRICT — `image_prompt` has ONE verb / ONE moment only.
6. **Use VISUAL TOKENS** — concrete actions, camera angles, props, named styles. ONLY filter EMPTY adjectives that convey no visual ("beautiful", "stunning", "amazing", "perfect", "epic"). Everything else is signal — keep it.
7. **OUTFIT EXTRACTION (strict — single source of truth):** scan ONLY the naskah text for explicit clothing words (oversized t-shirt, kemeja batik, daster, jeans, gamis, kerudung, sneakers, formal outfit, casual outfit, pastel colors, etc). Preserve modifiers ("kinda pastel", "smart casual", "all black"). RULES: (1) if naskah has NO explicit clothing words → `wardrobe = ""`; (2) NEVER infer outfit from persona name/description/reference photo; (3) NEVER guess "blazer"/"shirt"/generic — empty string is correct when naskah is silent.
8. **OUTPUT TYPE STRICTNESS:** every schema string field must be a JSON STRING, not array/object. Multiple outfits → JOIN into one string. Multiple camera moves → join with commas. Never return `[]`.
9. (if refs) Character names MUST come from the ref label list.

### 2.4 Constraint blocks (the 4 toggles)
Appended as **HARD USER CONSTRAINTS** when toggled:
- `continuousShot` → "This is a SINGLE CONTINUOUS take, no cuts. Panels describe MOMENTS within one flowing shot, not separate scenes."
- `skipDialog` → "NO spoken dialog or VO. Set `dialog` to empty string for all panels."
- `skipOnscreen` → "NO onscreen text or caption overlay. Set `onscreen` to empty string."
- `skipProduct` → "NO product placement. No product/package/brand item in any panel. No Product Shot type. Final panel is a closing moment, not a product CTA." (also drops the brand block + removes `Product Shot` from allowed `shot_type`)

### 2.5 Continuation mode (Continue shot/storyboard)
When `continuation` is passed, this block is appended:
```
CONTINUATION MODE — the Script below is the FULL story. These beats have ALREADY
been produced as earlier shots:
<coveredSummary>

Produce ONLY the NEXT segment that picks up immediately AFTER the covered beats and
moves the story FORWARD. Do NOT repeat covered beats. Do NOT restart.
<storyboard: output a storyboard for just this next segment>
<shots: cap EACH shot's duration to <= maxDuration s>
If the story is already fully covered, produce one short natural closing beat.
```
This is how a long naskah unrolls into a continuous chain (the "1 naskah bisa lanjut" feature).

### 2.6 OUTPUT SCHEMAS (verbatim templates)

**Storyboard** (`mode='storyboard'`):
```json
{
  "concept": "one-line creative concept (English)",
  "environment": "one-line setting + lighting + time-of-day shared across all panels (English, e.g. 'small neighborhood park, late afternoon golden light, scattered passersby')",
  "wardrobe": "outfit description for the subjects, extracted from the naskah if mentioned. Format: 'Character1 wears X. Character2 wears Y.' Empty string if naskah doesn't specify — DO NOT invent.",
  "video_motion": "one-line camera-movement description for the whole sequence (English, max 20 words). If continuousShot, describe a single fluid take with no cuts.",
  "characters": ["Name1"],
  "panels": [
    {"n":1,"title":"HOOK","visual":"English ACTION + camera angle only — do NOT describe faces or outfit","dialog":"line in <lang>","onscreen":"short <lang> caption","shot_type":"Close Up|Medium Shot|Wide Shot|Product Shot","seconds":2,"chars_in_shot":["Name1"]}
    // 9 panels total. Each panel.visual = action + framing only — no aesthetic/lighting/face/outfit words.
  ]
}
```

**Direct** (`mode='direct'`):
```json
{
  "characters": ["Name1"],
  "environment": "one-line setting + lighting + time-of-day shared across all shots",
  "wardrobe": "outfit per character, from naskah if mentioned. Empty string if not specified.",
  "shots": [
    {"shot":1,"duration":5,"video_motion":"English BEAT-STRUCTURED TIMELINE with timestamped sub-shots. Format: '[0-Xs] <action + camera angle>. [X-Ys] <action shift + camera move>. [Y-Zs] <final beat>.' Each beat ~2-3s. Map naskah elements (action, camera moves, mood shifts, reactions, prop reveals) to specific time ranges. Include camera transitions (push-in / pull-back / cut / pan). DO NOT include caption text — added in editor.","dialogue":"line in <lang>","chars_in_shot":["Name1"]}
  ]
}
```

**Per-Shot** (`mode='shots'`, the default):
```json
{
  "characters": ["Name1"],
  "environment": "one-line setting + lighting + time-of-day shared across all shots",
  "wardrobe": "outfit per character, from naskah if mentioned. Empty string if not specified.",
  "shots": [
    {"shot":1,"duration":5,"image_prompt":"English ACTION + camera angle only — do NOT describe faces or outfit","video_motion":"English motion max 20 words","dialogue":"line in <lang>","chars_in_shot":["Name1"]}
  ]
}
```

### 2.7 TASK line per mode (verbatim)
- **Storyboard**: "Convert this script into ONE 3x3 storyboard (9 panels, ~15s total) for a `<ar>` video."
- **Direct** (with `shotCount`): "EXACTLY N DIRECT VIDEO shots (each 5-10s). Each generated DIRECTLY from text + reference photos — no intermediate still." + a CRITICAL block requiring a timestamped beat timeline, with this example:
  ```
  "[0-2s] Wide shot: Emma raises phone up, child in arms, looking at mirror. Handheld iPhone UGC style.
   [2-4s] Push-in to medium: Emma smiles softly, child reaches up. Mood lifts.
   [4-6s] Cut to close-up child's face, eyes widen with curiosity, gentle laugh."
  ```
- **Direct** (no `shotCount`): "as many DIRECT VIDEO shots as the naskah needs (min 1, typical 2-5, each 5-10s)" + same beat-timeline block.
- **Per-Shot** (with `shotCount`): "EXACTLY N shots (each 3-10s based on action density)".
- **Per-Shot** (no `shotCount`): "as many shots as the naskah naturally demands (min 1, typical 3-8, each 3-10s). Short naskah = fewer shots. Don't pad with filler."

---

## 3. CAMERA PRESETS — the L1 master tokens (every preset)

Camera preset = the strongest layer (L1), the visual identity. Each has positive `tokens`, `negatives` (anti-prompt), a `category` (drives the quality line + sanitizer), and a `dominance` (how hard it pushes). `DEFAULT_CAMERA = iphone_15_clean`.

### 📱 PHONE category

**1. `samsung_a13_candid` — "Samsung A13 candid (UGC)"** · dominance **9** · *TikTok UGC, real-person testimonial, handheld*
```
TOKENS:
  accidental smartphone snapshot uploaded to whatsapp
  cheap Samsung Galaxy A-series phone camera quality
  casual handheld vertical phone video screenshot
  unflattering candid family photo
  amateur phone capture sent to family group chat
  low dynamic range, crushed shadows
  subtle JPEG compression artifacts
  slight motion blur from unstable hand
  imperfect framing with subjects off-center
  natural skin texture without smoothing
  no color grade, no filter, no editing
  mild overexposure on bright spots from auto-exposure
NEGATIVES:
  magazine photoshoot, Pinterest aesthetic, stock photo, lifestyle brand commercial,
  model agency portfolio, professional family portrait, wedding photographer style,
  food blog photography, real estate photography, cinematic, ARRI Alexa, anamorphic,
  studio lighting, softbox, ring light, color graded, HDR, 8K, sharp focus everywhere,
  well-balanced composition, symmetrical framing, rule of thirds composition
CONFLICTS WITH: cinematic_anamorphic, studio_tvc, product_macro
```

**2. `iphone_15_clean` — "iPhone 15 clean"** · dominance **7** · *Polished UGC, founder talking head, podcast clip*
```
TOKENS:  shot on iPhone 15 Pro, smartphone video, clean handheld,
         natural daylight, crisp detail, soft skin tones
NEGATIVES: ARRI Alexa, anamorphic lens flare, film grain, golden hour cinematic
CONFLICTS WITH: cinematic_anamorphic
```

### 🎬 CINEMA category

**3. `studio_tvc` — "Studio TVC"** · dominance **8** · *Premium brand spot, controlled lighting, locked-off*
```
TOKENS:  studio softbox lighting, 50mm prime lens, locked-off camera,
         color-graded, sharp focus, clean seamless backdrop
NEGATIVES: handheld, phone camera, motion blur, imperfect framing, UGC, raw unedited
CONFLICTS WITH: samsung_a13_candid, iphone_15_clean
```

**4. `cinematic_anamorphic` — "Cinematic anamorphic"** · dominance **8** · *Hero brand film, narrative ad, festival look*
```
TOKENS:  anamorphic 2.39 aspect, shallow depth of field, golden hour rim light,
         soft halation, cinematic color grade
NEGATIVES: phone camera, flat lighting, UGC, vertical 9:16 phone aesthetic
CONFLICTS WITH: samsung_a13_candid, iphone_15_clean
```

**5. `product_macro` — "Product macro"** · dominance **7** · *Product hero shot, e-commerce key visual*
```
TOKENS:  100mm macro lens, product centered, focus stacked, clean white sweep,
         soft top light, label fully legible
NEGATIVES: handheld, motion blur, candid, UGC
CONFLICTS WITH: samsung_a13_candid
```

**6. `documentary_handheld` — "Documentary handheld"** · dominance **6** · *Real-world story, observational style*
```
TOKENS:  observational documentary handheld, 35mm lens, natural available light,
         organic camera movement, minimal color correction
NEGATIVES: studio softbox, locked-off, glossy commercial, over-stylized
CONFLICTS WITH: studio_tvc, product_macro
```

### 🎨 ANIMATION category

**7. `animation_2d` — "2D animation"** · dominance **10** · *Animated explainer, mascot ad, kid-friendly*
```
TOKENS:  2D cartoon animation, flat colors, clean linework, vector style, no photographic detail
NEGATIVES: photographic, sharp focus, realistic skin texture, high-detail photography,
           ARRI, cinema lens, phone camera, accurate product packaging
CONFLICTS WITH: samsung_a13_candid, studio_tvc, cinematic_anamorphic, product_macro, documentary_handheld
```

**8. `pixar_3d` — "Pixar-style 3D"** · dominance **10** · *Family / mascot 3D ad, character-driven CG*
```
TOKENS:  Pixar-style 3D render, stylised character proportions, soft global illumination,
         subsurface scattering on skin
NEGATIVES: photographic, phone camera, UGC, film grain, documentary
CONFLICTS WITH: samsung_a13_candid, cinematic_anamorphic
```

### Preset resolution (`getCameraPreset`)
1. Workspace custom presets (user-defined) win first.
2. Built-in `CAMERA_PRESETS[id]`.
3. Legacy alias → built-in (`LEGACY_STYLE_TO_CAMERA`): `ugc→samsung_a13_candid`, `social_short→iphone_15_clean`, `cinematic_ad→cinematic_anamorphic`, `tvc→studio_tvc`, `animation→animation_2d`, `3d_render→pixar_3d`, `product_demo→product_macro`, `short_movie→documentary_handheld`.
4. Fallback → `iphone_15_clean`.

---

## 4. THE COMPILER — structured → final prompt

### 4.1 IMAGE path — `compileImagePrompt` (11 layers)
Diffusion models weight early tokens more, so order matters. Each layer is built, then most layers run through the sanitizer, then joined with `\n`.

```
L1   <camera.tokens joined by ", ">                       ← visual identity, highest priority
L1b  <gridHeader>                                          (storyboard only)
L2   Subject: <identity>.
L3   Wardrobe: <wardrobe>.                                 (soft early anchor)
L4   Setting: <environment>.
L5   <action>                                              (the image_prompt / one frozen moment)
L5b  Throughout, maintain: <first 4 camera tokens>.
L6   CRITICAL PRODUCT FIDELITY: render the product EXACTLY as described, identical across
     every shot. <brand>. Product label text must be sharp, legible, correctly spelled.
     Do NOT substitute or vary the product.                (only if brand && !skipProduct)
L7   <ar> composition.
L8   Keep character identity consistent with references.   (only if refsCount > 0)
L8b  STYLE REFERENCE: the last N image(s) are style references — match their color palette,
     lighting, rendering style, and overall aesthetic. Do NOT copy characters, faces, or
     specific objects from them. Use them ONLY as visual mood/style guide.   (only if styleRefsCount > 0)
L9   <quality line — style-aware, see 4.4>
L10  Avoid: <camera.negatives [+ anti-text terms if skipOnscreen]>.
L11  CHANGE the subjects' outfit to: <wardrobe>. Replace the reference photo outfit
     completely. Keep face, hair, body and identity IDENTICAL — only swap clothing.   (only if wardrobe; trailing imperative for /edit endpoints, recency bias)
```
- Layers L1–L9 are sanitized (contradiction-stripped). **L8b, L10, L11 are pass-through raw** (so the sanitizer doesn't eat "color palette" / "well-balanced composition" / negatives / the outfit imperative).
- `skipOnscreen` appends to negatives: `on-screen text, captions, subtitles, watermark, logos, letters, written words, gibberish text, signage` — stops the FIRST FRAME carrying text that i2v would animate.
- Character vs style refs are counted separately so the model doesn't treat the style image's people as characters. **Caller MUST order refUrls as `[character/product refs..., style refs...]`** so "the last N images" is literally true.

### 4.2 VIDEO path — `compileVideoPrompt` (minimal)
The still already baked in identity + wardrobe + camera style, so the video prompt only carries MOTION. Lines (filtered, joined by `\n`):
```
<camera.tokens joined>.   ← ONLY in Direct mode (no still to carry style; a 2D/animation/stylized
                            preset is otherwise ignored and the model defaults to photoreal 3D)
Subject: <identity>.
Wardrobe: <wardrobe>.
Setting: <environment>.
<action>                  ← the video_motion timeline, verbatim from naskah
<ar> composition.
Keep character identity consistent with references.   (if refsCount)
Absolutely no on-screen text, captions, subtitles, watermarks, logos, letters, numbers, or
any written words anywhere in the frame.               (if noText)
```
No camera-echo, no quality blob, no negatives — those describe the frame (already locked), not the motion.

### 4.3 STORYBOARD GRID — `buildStoryboardGridPrompt(panels, ar, concept, constraints)`
9 panels → ONE composite image prompt:
```
Single composite image, <ar> canvas, 3x3 grid layout (3 rows × 3 columns) of 9 sequential
photographic stills. Tiny scene number (1-9) in top-left corner of each cell. NO text labels,
NO captions, NO time stamps under the photos — clean raw photos only.
CRITICAL CONSISTENCY: every character must look IDENTICAL across all 9 panels — same face shape,
same proportions, same outfit, same color palette, same art style. This is one continuous scene
shown in 9 keyframes, NOT 9 different versions of the character.
<productRule>

The 9 stills, in order (left-to-right, top-to-bottom):
Cell 1: <shot_type lowercased> — <visual> (overheard: "<dialog>") [caption: <onscreen>]
Cell 2: ...
... up to Cell 9
```
- `productRule` = "No product or brand packaging in any cell — lifestyle moments only." (skipProduct) **or** "Product appears in cells marked Product Shot only."
- `(overheard: ...)` only if `!skipDialog && dialog`. `[caption: ...]` only if `!skipOnscreen && onscreen`.
- Layout intentionally "raw photos + tiny corner number" (ChatGPT-style), NOT an ad-agency table with text labels.
- The CONSISTENCY sentence exists because the #1 storyboard failure is the character morphing across the 9 panels.

### 4.4 Quality line per category (`pickQuality`)
Replaces the old unconditional `IMG_QUALITY` blob:
| Category | image | video |
|----------|-------|-------|
| `animation` | `Clean stylised render, consistent character design.` | `Smooth animated motion, consistent character design across frames.` |
| `phone` | `Real-person realism, natural skin, no over-processing.` | `Natural handheld motion, real-person realism, no over-processing.` |
| `cinema` / custom | `Anatomically correct, well-composed.` (+ ` Product label sharp and legible.` unless skipProduct) | `Steady framing, consistent identity.` (+ product) |

---

## 5. THE SANITIZER — contradiction rules (`CONTRADICTION_RULES`)

Each layer string is scanned; if a rule is triggered by context, the matching substring is removed (not the whole layer), then whitespace/punctuation is cleaned up.

| Rule | Removes (regex match) | Triggered when |
|------|----------------------|----------------|
| pro-quality vs casual/animation | `Professional high-detail photography, sharp focus, well-balanced composition, high-detail, crisp detail, anatomically correct hands` | camera ∈ {samsung_a13, documentary_handheld, animation_2d, pixar_3d} |
| cinematic vs phone/animation | `cinematic, ARRI Alexa, anamorphic, color graded, golden hour cinematic, Hollywood-grade, broadcast-safe` | camera ∈ {samsung_a13, iphone_15, animation_2d} |
| product packaging vs skipProduct | `accurate product packaging, legible logo, product packaging EXACTLY, Product label sharp, ALL label text` | `skipProduct = true` |
| 16:9 framing vs vertical/square | `16:9 framing-aware, widescreen framing` | ar ∈ {9:16, 1:1} |
| vertical framing vs horizontal | `vertical 9:16 (phone aesthetic)?` | ar = 16:9 |
| photographic skin vs animation | `realistic skin texture, photographic still, natural realistic skin, authentic skin pores` | camera ∈ {animation_2d, pixar_3d} |
| wasted award/marketing tokens | `ambient sound, scroll-stopping, awards-worthy, Oscar-worthy, Roger Deakins, 8K cinematic, No watermark, Hollywood-grade` | **always** (`*`) |
| continuity vs no-refs | `CONTINUITY: keep characters identical to references, Keep character identity consistent with references` | `refsCount = 0` |
| multi-scene vs continuousShot | `9 (panels/beats/scenes/storyboards), multi-scene` | `continuousShot = true` |
| ignore-outfit vs no-override | `IGNORE the outfit shown in (any/the)? reference photo...` | `wardrobe` empty |

Context object: `{ cameraId, ar, skipProduct, continuousShot, refsCount, wardrobe: !!wardrobe, media }`.

---

## 6. WORKED EXAMPLES (naskah → parsed → final prompt)

### 6.1 Per-Shot (image-to-video)
**Naskah:** *"Cewek santai di kamar sore hari, baju oversized hitam, handheld iPhone, dia senyum ke kamera lalu ngangkat produk skincare. Vibe candid cozy."* · camera `iphone_15_clean` · ar `9:16`

**Parse →**
```json
{ "environment": "bedroom, warm late-afternoon light",
  "wardrobe": "oversized black t-shirt",
  "shots": [{ "shot":1, "duration":5,
    "image_prompt": "medium shot, young woman smiling warmly at handheld camera, cozy candid",
    "video_motion": "[0-2s] handheld iPhone, she smiles at camera. [2-4s] push-in to medium, she lifts the skincare product. [4-5s] product close-up.",
    "dialogue": "..." }] }
```
**compileImagePrompt →**
```
shot on iPhone 15 Pro, smartphone video, clean handheld, natural daylight, crisp detail, soft skin tones
Subject: <persona identity>.
Wardrobe: oversized black t-shirt.
Setting: bedroom, warm late-afternoon light.
medium shot, young woman smiling warmly at handheld camera, cozy candid
Throughout, maintain: shot on iPhone 15 Pro, smartphone video, clean handheld, natural daylight.
9:16 composition.
Keep character identity consistent with references.
Real-person realism, natural skin, no over-processing.
Avoid: ARRI Alexa, anamorphic lens flare, film grain, golden hour cinematic.
CHANGE the subjects' outfit to: oversized black t-shirt. Replace the reference photo outfit completely. Keep face, hair, body and identity IDENTICAL — only swap clothing.
```
**compileVideoPrompt** (animates the still) →
```
Subject: <identity>.
Wardrobe: oversized black t-shirt.
Setting: bedroom, warm late-afternoon light.
[0-2s] handheld iPhone, she smiles at camera. [2-4s] push-in to medium, she lifts the skincare product. [4-5s] product close-up.
9:16 composition.
Keep character identity consistent with references.
```

### 6.2 Storyboard
**Naskah:** product intro, 9 beats, `samsung_a13_candid`, No product OFF. Parse returns `concept`, `environment`, `wardrobe`, `video_motion`, and 9 `panels`. **buildStoryboardGridPrompt** wraps them into the 3×3 grid prompt (§4.3) for ONE image. The image is then fed as the reference (sequence map) to a reference-to-video model, ~15s. To extend past the model's cap, "Continue" pulls the next naskah segment (§2.5) and chains.

### 6.3 Direct
**Naskah:** founder testimonial. camera `iphone_15_clean`. No image step. Parse returns shots with timestamped `video_motion` only. **compileVideoPrompt** runs WITH camera tokens (Direct includes L1) → reference-to-video straight from text + uploaded refs.

---

## 7. Per-model field mapping (compiler output → fal input)

After compiling the prompt string, `buildImgInput` / `buildVidInput` (and God Mode's `buildVideoInputForModel`) route it into the right field names per model family — the #1 422 trap:
- Image edit models → `image_urls` (array) + `prompt`.
- Grok ref-to-video → `reference_image_urls` (NOT `image_urls`).
- Seedance ref-to-video → `image_urls` (array).
- Kling i2v → `start_image_url`; Kling ref → `elements: [{ frontal_image_url }]`.
- LTX → `num_frames` (8n+1 @ 24fps), no `duration` field.

See `src/lib/god-mode-builders.js` (`buildVideoInputForModel`) and `src/lib/fal-client.js` (`buildVidInput`/`buildImgInput`) for the full per-model branches. These are covered by `god-mode-builders.test.js`.

---

*Generated from source 2026-06-19. If the code changes, re-derive — this is a point-in-time snapshot.*
