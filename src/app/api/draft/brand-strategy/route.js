import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGeminiJSON } from '@/lib/gemini-server'
import { getActiveWorkspace } from '@/lib/workspace'

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)

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
    const draft = await callGeminiJSON({
      workspaceId: wsId,
      contents: [{ parts: [{ text: prompt }] }],
      temperature: 0.8,
      maxOutputTokens: 4096,
    })
    return NextResponse.json({ ok: true, draft })
  } catch (e) {
    const httpStatus = e?.transient ? 200 : (e?.status || 500)
    return NextResponse.json({ ok: false, error: String(e?.message || e), transient: !!e?.transient }, { status: httpStatus })
  }
}
