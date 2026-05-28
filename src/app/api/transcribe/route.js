import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertBudget } from '@/lib/budget-gate'
import { GEMINI_COSTS } from '@/lib/cost-table'
import { callGeminiJSON } from '@/lib/gemini-server'

// Vercel: butuh waktu buat download video + transcribe
export const maxDuration = 60

// POST /api/transcribe — auto-generate subtitle segments dari video.
// Body: { url } — public URL of video file
// Returns: { ok, segments: [{ start, end, text }] } in seconds.
//
// Uses Gemini 2.5 Flash multimodal: pass video inline + ask for JSON
// segments. Inline limit ~20MB; for now we just fail dengan pesan jelas
// kalau video terlalu besar (most ad videos <20MB).
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const geminiKey = process.env.GEMINI_KEY
  if (!geminiKey) return NextResponse.json({ ok: false, error: 'GEMINI_KEY belum di-set' }, { status: 500 })

  const { url, language } = await req.json()
  if (!url) return NextResponse.json({ ok: false, error: 'url required' }, { status: 400 })

  const wsId = await getActiveWorkspace(supabase, user)
  const gate = await assertBudget(supabase, wsId, { projectedUsd: GEMINI_COSTS.transcribe })
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason, gate }, { status: 402 })

  try {
    // 1. Download video
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) throw new Error(`Download video failed: ${r.status}`)
    const buf = await r.arrayBuffer()
    const sizeMB = buf.byteLength / 1024 / 1024
    if (sizeMB > 18) {
      return NextResponse.json({
        ok: false,
        error: `Video ${sizeMB.toFixed(1)}MB terlalu besar buat Gemini inline (max ~18MB). Trim dulu atau gunakan File API path.`,
      }, { status: 400 })
    }
    const mimeType = r.headers.get('content-type') || 'video/mp4'
    // Base64 inline
    const b64 = Buffer.from(buf).toString('base64')

    // 2. Call Gemini with video + transcription prompt
    const langHint = language ? `bahasa ${language}` : 'bahasa yang ada di video (Indonesia/English/dll)'
    const prompt = `Lu speech recognition system. Transcribe SEMUA dialog/voice over di video ini ${langHint}.

OUTPUT JSON only (no markdown). Array of segments dengan timestamp (detik):
{
  "language": "id" or "en" or "...",
  "segments": [
    { "start": 0.0, "end": 1.5, "text": "Kalimat pertama" },
    { "start": 1.5, "end": 3.2, "text": "Kalimat kedua" }
  ]
}

ATURAN:
- Pisah per natural pause/sentence (1-4 kata per segment ideal buat subtitle TikTok-style)
- Timestamp ACCURATE — ikuti waktu aktual di audio
- Kalau ada musik/SFX tanpa speech, skip
- Kalau gak ada dialog sama sekali, return { "segments": [] }
- Pakai casing natural (gak ALL CAPS)`

    const parsed = await callGeminiJSON({
      workspaceId: wsId,
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: b64 } },
        ],
      }],
      temperature: 0.2,
      maxOutputTokens: 4096,
    })
    const segments = (parsed.segments || []).filter((s) => s && s.text)
    return NextResponse.json({ ok: true, segments, language: parsed.language || null, count: segments.length })
  } catch (e) {
    const httpStatus = e?.transient ? 200 : (e?.status || 500)
    return NextResponse.json({ ok: false, error: String(e?.message || e), transient: !!e?.transient }, { status: httpStatus })
  }
}
