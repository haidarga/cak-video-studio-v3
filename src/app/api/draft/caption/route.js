import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// POST /api/draft/caption — auto-draft a social media caption for a result
// using brand + persona + content context (storyboard concept, dialogs, etc).
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const geminiKey = process.env.GEMINI_KEY
  if (!geminiKey) return NextResponse.json({ ok: false, error: 'GEMINI_KEY belum di-set di Vercel env' }, { status: 500 })

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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 1024, responseMimeType: 'application/json' },
        }),
      }
    )
    const data = await res.json()
    if (data.error) throw new Error(data.error.message)
    if (!data.candidates?.length) throw new Error('Gemini blocked (safety?)')
    let text = data.candidates[0].content.parts[0].text || ''
    text = text.replace(/```json|```/g, '').trim()
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) text = text.slice(first, last + 1)
    const parsed = JSON.parse(text)
    const tags = (parsed.hashtags || [])
      .map((t) => String(t).trim().replace(/^#/, ''))
      .filter(Boolean)
      .map((t) => `#${t}`)
      .join(' ')
    const full = (parsed.caption || '').trim() + (tags ? `\n\n${tags}` : '')
    return NextResponse.json({ ok: true, caption: full, hashtags: parsed.hashtags || [] })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
