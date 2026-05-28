import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGemini } from '@/lib/gemini-server'

// POST /api/draft/caption — auto-draft a social media caption for a result
// using brand + persona + content context (storyboard concept, dialogs, etc).
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { result_id } = await req.json()
  if (!result_id) return NextResponse.json({ ok: false, error: 'result_id required' }, { status: 400 })

  // Fetch result + persona (via FK) in one query
  const { data: result, error } = await supabase
    .from('results')
    .select('id, label, type, ar, meta, workspace_id, group_label, persona_id, personas(id, name, username, role_label, postiz_platform, character_prompt, emotional_angle)')
    .eq('id', result_id).single()
  if (error || !result) return NextResponse.json({ ok: false, error: 'result not found' }, { status: 404 })

  const persona = result.personas

  // Get active brand for the workspace
  const { data: ws } = await supabase.from('workspaces').select('active_brand_id').eq('id', result.workspace_id).single()
  let brand = null
  if (ws?.active_brand_id) {
    const { data: b } = await supabase.from('brands').select('name, notes, config').eq('id', ws.active_brand_id).single()
    brand = b
  }

  const platform = (persona?.postiz_platform || 'tiktok').toLowerCase()

  // Pull dialog + concept hints from result.meta if available
  const meta = result.meta || {}
  const concept = meta.raw?.concept || meta.storyboard_concept || ''
  const dialogs = []
  if (Array.isArray(meta.raw?.panels)) meta.raw.panels.forEach((p) => { if (p?.dialog) dialogs.push(p.dialog) })
  if (meta.raw?.dialogue) dialogs.push(meta.raw.dialogue)

  const prompt = `Lu social media manager profesional. Bikin caption viral & engaging buat post berikut. Output JSON only, no markdown.

PLATFORM: ${platform.toUpperCase()}
PERSONA: ${persona?.name || '—'} (@${persona?.username || '—'})${persona?.role_label ? `, ${persona.role_label}` : ''}
${persona?.character_prompt ? `Character: ${persona.character_prompt.slice(0, 300)}` : ''}
${persona?.emotional_angle ? `Emotional angle: ${persona.emotional_angle}` : ''}

BRAND: ${brand?.name || '— no active brand'}${brand?.config?.category ? ` (${brand.config.category})` : ''}
${brand?.config?.tone_of_voice ? `Tone of voice: ${brand.config.tone_of_voice}` : ''}
${brand?.config?.key_messages?.length ? `Key messages: ${brand.config.key_messages.join(' | ')}` : ''}
${brand?.config?.target_audience ? `Target audience: ${brand.config.target_audience.slice(0, 200)}` : ''}
${brand?.notes ? `Guardrails (penting, JANGAN dilanggar): ${brand.notes.slice(0, 500)}` : ''}

KONTEN POST:
Label: ${result.label}
${concept ? `Konsep: ${concept}` : ''}
${dialogs.length ? `Dialog di video: "${dialogs.join(' / ').slice(0, 500)}"` : ''}

ATURAN:
- Caption 2-4 baris max, bahasa Indonesia, natural sesuai persona (jangan kaku/iklan)
- Hook di baris pertama yang bikin scroll berhenti
- Emoji seperlunya (1-3 emoji, jangan spam)
- Sesuai persona character + brand tone
- Hormati guardrails brand (jangan klaim yang gak boleh)
- 4-7 hashtag campur niche + broad
- JANGAN sebut nama brand secara eksplisit di caption KECUALI brand notes minta itu

OUTPUT (JSON only):
{
  "caption": "...",
  "hashtags": ["tag1", "tag2", "tag3"]
}`

  try {
    const rawText = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 2048, responseMimeType: 'application/json' },
    })
    if (!rawText.trim()) throw new Error('Gemini balik kosong')

    // Custom JSON repair — handles unterminated strings + trailing commas etc.
    const parsed = parseCaptionJson(rawText)
    if (!parsed.caption) throw new Error('Gemini gak ngasih caption — output: ' + rawText.slice(0, 200))

    const tags = (parsed.hashtags || [])
      .map((t) => String(t).trim().replace(/^#/, ''))
      .filter(Boolean)
      .map((t) => `#${t}`)
      .join(' ')
    const full = parsed.caption.trim() + (tags ? `\n\n${tags}` : '')
    return NextResponse.json({ ok: true, caption: full, hashtags: parsed.hashtags || [] })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: e?.status || 500 })
  }
}

// Robust parser: tries JSON.parse first, then regex-extract on failure.
// Handles malformed responses (unterminated strings, trailing commas,
// markdown fences) without throwing.
function parseCaptionJson(rawText) {
  let text = rawText.replace(/```json|```/g, '').trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) text = text.slice(first, last + 1)

  // Attempt 1: clean parse
  try { return JSON.parse(text) } catch {}

  // Attempt 2: try to fix common issues — escape stray newlines inside strings
  try {
    const fixed = text.replace(/("[^"]*?")|(\n+)/g, (m, str, nl) => str || ' ')
    return JSON.parse(fixed)
  } catch {}

  // Attempt 3: regex extract caption + hashtags
  const captionMatch = text.match(/"caption"\s*:\s*"((?:[^"\\]|\\.)*)/s)
  const hashtagsBlock = text.match(/"hashtags"\s*:\s*\[([^\]]*)\]/s)
  const caption = captionMatch?.[1]
    ?.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') || ''
  const hashtags = hashtagsBlock
    ? [...hashtagsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : []
  if (caption) return { caption, hashtags }

  // Attempt 4: bare text — use first 280 chars as caption, no hashtags
  return { caption: text.slice(0, 280).trim(), hashtags: [] }
}
