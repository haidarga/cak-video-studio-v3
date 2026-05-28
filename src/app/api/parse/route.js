// POST /api/parse — parse naskah pake LLM (workspace-configured), return shot list or storyboard panels.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGeminiJSON } from '@/lib/gemini-server'
import { getActiveWorkspace } from '@/lib/workspace'

export async function POST(req) {
  const { naskah, lang = 'Indonesian', mode = 'shots', ar = '9:16', refLabels = [], brand = null, constraints = {} } = await req.json()
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
  const shotTypes = constraints.skipProduct
    ? 'Close Up|Medium Shot|Wide Shot'
    : 'Close Up|Medium Shot|Wide Shot|Product Shot'

  // Visual abstraction layer — parser now extracts VISUAL TOKENS not screenplay
  // prose. Storyboard schema gains:
  //   - shared `environment` field (set + lighting + time-of-day)
  //   - shared `wardrobe` field (outfit per character, extracted from naskah)
  //   - top-level `video_motion` for the whole sequence
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
    : `{
  "characters": ["Name1"],
  "environment": "one-line setting + lighting + time-of-day shared across all shots",
  "wardrobe": "outfit description per character, extracted from naskah if mentioned. Empty string if not specified.",
  "shots": [
    {"shot":1,"duration":5,"image_prompt":"English ACTION + camera angle only — do NOT describe faces or outfit","video_motion":"English motion max 20 words","dialogue":"${constraints.skipDialog ? '' : `line in ${lang}`}","chars_in_shot":["Name1"]}
  ]
}`

  // Hard rules applied universally (used to be guard only in per-shot mode).
  const universalRules = [
    'NEVER describe faces in detail (eye color, exact features, hair texture). Character identity is locked by reference photos.',
    'Use VISUAL TOKENS — concrete actions, camera angles, props. Avoid aesthetic adjectives ("beautiful", "cinematic", "professional", "stunning") — those create contradictions downstream.',
    'Set extras (lighting, time-of-day, backdrop) go in the shared `environment` field. Per-panel `visual` is just ACTION + framing.',
    'OUTFIT EXTRACTION: scan the naskah for any wardrobe/clothing description (oversized t-shirt, kemeja batik, casual celana, etc). Put it in the shared `wardrobe` field. If the naskah does NOT mention outfit, set wardrobe to empty string — do NOT invent one. The reference photo handles outfit when wardrobe is empty.',
    refLabels.length ? `Character names MUST come from this list (use exact names in chars_in_shot): ${refLabels.join(', ')}` : null,
  ].filter(Boolean).map((r) => `- ${r}`).join('\n')

  const prompt = `You are a cinematographer translating script into VISUAL TOKENS (not screenplay prose) for a diffusion image/video model.

SPOKEN LANGUAGE: ${lang} — ALL dialog written in fluent native ${lang}.${refHint}${brandBlock}${constraintBlock}

UNIVERSAL RULES:
${universalRules}

TASK: Convert this script into ${isStory ? 'ONE 3x3 storyboard (9 panels, ~15s total)' : '5-8 shots (4-8s each)'} for a ${ar} video.

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
