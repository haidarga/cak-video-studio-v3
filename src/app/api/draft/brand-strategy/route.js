import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const geminiKey = process.env.GEMINI_KEY
  if (!geminiKey) return NextResponse.json({ ok: false, error: 'GEMINI_KEY belum di-set di Vercel' }, { status: 500 })

  const { name, category, guardrails } = await req.json()
  if (!name?.trim()) return NextResponse.json({ ok: false, error: 'brand name required' }, { status: 400 })

  const prompt = `Lu strategist brand profesional. Berdasarkan info brand di bawah, drafting Communication Strategy lengkap.

Brand: ${name}
Kategori: ${category || '—'}
Guardrails / Knowledge:
${guardrails || '—'}

Output JSON only (no markdown), bahasa Indonesia, spesifik & actionable (bukan generic):
{
  "target_audience": "Demografi + perilaku + kebutuhan spesifik, 2-3 kalimat",
  "tone_of_voice": "Gaya bicara brand secara spesifik, 1-2 kalimat",
  "content_pillars": ["3-5 pillar, format: 'Pillar Name: deskripsi singkat'"],
  "key_messages": ["3-5 pesan inti, max 15 kata tiap baris"],
  "campaign_goals": "Tujuan campaign konkret (awareness/conversion/loyalty/etc) + KPI kalau bisa, 1-2 kalimat",
  "competitor_insight": "Gap kompetitor + angle yang bisa diambil brand ini, 1-2 kalimat"
}

PENTING:
- Kalo info brand minim, tetap inferensi cerdas dari nama + kategori
- Output HARUS valid JSON tanpa markdown fence, tanpa narasi tambahan
- Hindari klaim medis/scientific yang gak ada di guardrails`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 4096, responseMimeType: 'application/json' },
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
    const draft = JSON.parse(text)
    return NextResponse.json({ ok: true, draft })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
