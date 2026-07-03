// POST /api/shot-memory/extract — JSON { image_url, characters?: string[] }
//
// Reads the LAST FRAME of a just-rendered shot with a vision model (Gemini,
// multimodal — same inline_data path god-mode already uses) and returns a
// structured continuity state: what's actually on screen (location, who's
// present, wardrobe AS RENDERED, last action, props, lighting). The Continue /
// Link / long-form flows carry this into the next shot so continuity tracks the
// RENDER, not just the script. See src/lib/shot-memory.js for how it's consumed.
//
// Best-effort: any failure returns 200 { ok:false } so the caller just skips the
// memory and proceeds — never blocks a generation.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { callGeminiJSON } from '@/lib/gemini-server'
import { normalizeState } from '@/lib/shot-memory'

export const runtime = 'nodejs'
export const maxDuration = 60

const SCHEMA = `{
  "location": "one short phrase: where the scene is (set + time-of-day)",
  "characters": ["names of the people visibly present in THIS frame"],
  "wardrobe": {"CharacterName": "what they wear AS RENDERED — color + garment, e.g. 'white casual t-shirt'"},
  "last_action": "what the subject is doing at this frozen instant (the pose/movement the next shot must continue from)",
  "props": ["notable objects or products held / in the scene"],
  "lighting": "short lighting description"
}`

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 200 })
    const { image_url, characters = [] } = await req.json()
    if (!image_url) return NextResponse.json({ ok: false, error: 'image_url required' }, { status: 400 })

    // Frame → inline_data part (mirrors god-mode agent/route.js:2349-2350).
    let imgRes
    try { imgRes = await fetch(image_url) } catch (e) { throw new Error(`fetch frame failed: ${e.message}`) }
    if (!imgRes.ok) throw new Error(`fetch frame ${imgRes.status}`)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    const ct = imgRes.headers.get('content-type') || ''
    const mime = ct.startsWith('image/') ? ct : 'image/jpeg'

    const known = (characters || []).filter(Boolean).map(String).slice(0, 8)
    const prompt = `You are a film-set continuity supervisor. Look ONLY at this single image — it is the LAST frame of a shot that was just filmed — and report the on-screen state so the NEXT shot can match it EXACTLY.
${known.length ? `Known character names (use these EXACT names for anyone you recognize): ${known.join(', ')}.` : ''}
Report ONLY what is visibly true in THIS frame. Do NOT invent anything not shown; leave a field empty/blank if it isn't visible.
Output ONLY valid JSON, no markdown:
${SCHEMA}`

    const parsed = await callGeminiJSON({
      workspaceId: wsId,
      contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
      temperature: 0.2,
      maxOutputTokens: 1024,
    })
    return NextResponse.json({ ok: true, state: normalizeState(parsed) })
  } catch (e) {
    // Soft-fail (200) — memory is an enhancement, not a gate.
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 })
  }
}
