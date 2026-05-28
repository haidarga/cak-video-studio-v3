// POST /api/parse — parse naskah pake Gemini, return shot list or storyboard panels.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGeminiJSON } from '@/lib/gemini-server'

export async function POST(req) {
  const { naskah, lang = 'Indonesian', mode = 'shots', ar = '9:16', refLabels = [], brand = null } = await req.json()
  if (!naskah?.trim()) return NextResponse.json({ ok: false, error: 'naskah kosong' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const refHint = refLabels.length
    ? `\nAvailable reference labels (use exact names in chars_in_shot when applicable): ${refLabels.join(', ')}`
    : ''
  const brandBlock = brand?.notes
    ? `\nBRAND KNOWLEDGE (respect strictly, never contradict):\n${brand.notes}`
    : ''

  const isStory = mode === 'storyboard'
  const schema = isStory
    ? `{
  "concept": "one-line creative concept",
  "characters": ["Name1"],
  "panels": [
    {"n":1,"title":"HOOK","visual":"English shot+action+lighting","dialog":"line in ${lang}","onscreen":"short ${lang} caption","shot_type":"Close Up|Medium Shot|Wide Shot|Product Shot","seconds":2,"chars_in_shot":["Name1"]}
    // 9 panels total
  ]
}`
    : `{
  "characters": ["Name1"],
  "shots": [
    {"shot":1,"duration":5,"image_prompt":"English scene+lighting+camera, do NOT describe faces","video_motion":"English motion max 20 words","dialogue":"line in ${lang}","chars_in_shot":["Name1"]}
  ]
}`

  const prompt = `You are a TikTok ad director. Convert this script into ${isStory ? 'ONE 3x3 storyboard (9 panels, ~15s total)' : '5-8 shots (4-8s each)'} for a ${ar} video.

SPOKEN LANGUAGE: ${lang} — ALL dialog written in fluent native ${lang}.${refHint}${brandBlock}

Output ONLY valid JSON, no markdown:
${schema}

Script:
${naskah}`

  try {
    const parsed = await callGeminiJSON({
      contents: [{ parts: [{ text: prompt }] }],
      temperature: 0.7,
      maxOutputTokens: 16384,
    })
    return NextResponse.json({ ok: true, parsed })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: e?.status || 500 })
  }
}
