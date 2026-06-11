import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { callLLMJSON } from '@/lib/llm-server'

// POST /api/editor/ai-compose — prompt-driven edit planner.
// Body: { prompt: string, videos: [{ url, label, duration }] }
// (durations are probed CLIENT-side in QC before calling — the server
// can't cheaply read video metadata, and exact durations let the LLM
// place trims/texts on real timestamps instead of guessing.)
//
// Returns { ok, plan } — a STRUCTURED edit plan, NOT a finished project.
// The client compiles plan → editor project JSON via
// src/lib/ai-edit-compose.js (single source of truth for clip shapes,
// kept client-side beside the editor that consumes it).
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
    const { prompt, videos } = await req.json()
    if (!prompt?.trim()) throw new Error('prompt kosong — deskripsiin mau diedit kayak gimana')
    if (!Array.isArray(videos) || videos.length === 0) throw new Error('no videos selected')

    const videoList = videos.map((v, i) =>
      `  [${i}] "${v.label || 'untitled'}" — ${Number(v.duration || 0).toFixed(1)}s`
    ).join('\n')

    const builder = `You are a VIDEO EDIT PLANNER for a multi-track editor (CapCut-style). The user selected ${videos.length} video clip(s) and described the edit they want. Produce a concrete edit plan.

AVAILABLE CLIPS (index — label — duration):
${videoList}

USER'S EDIT REQUEST (Bahasa Indonesia):
${String(prompt).slice(0, 1500)}

EDITOR CAPABILITIES you can use in the plan:
- Reorder / repeat / drop clips, trim each (trim_start/trim_end in seconds within that clip)
- Per-clip speed (0.5–2), subtle punch-in zoom (1.0–1.4)
- Transition INTO each clip (except the first): cut | crossfade | wipe | dissolve | circle | pixelize | zoomin (duration 0.3–0.8s)
- Text overlays at absolute timeline times (hook text, CTA, captions) — style: tiktok (bold white on black) | clean (no background)
- auto_subtitle: true → the editor will auto-transcribe ALL dialog and add word-level karaoke subtitles AFTER your plan loads. USE THIS instead of writing caption texts yourself whenever the user wants subtitles/captions of the spoken dialog.

PLANNING RULES:
- Timeline times are GLOBAL (after reordering + trims + speed). Compute them carefully.
- Hook text in the first 1.5–3s massively helps retention — add one if the user's intent is social content, unless they say otherwise.
- Don't invent content that needs footage you don't have.
- Keep total under 60s unless user asks longer.
- If user asks something the editor CANNOT do (changing what's IN the footage, e.g. "ganti background jadi pantai"), note it in "notes" — that needs AI video edit (God Mode), not this editor.

Output JSON ONLY:
{
  "project_name": "short name",
  "clips": [
    { "video_index": 0, "trim_start": 0, "trim_end": null, "speed": 1, "zoom": null, "transition": "cut", "transition_duration": 0.4 }
  ],
  "texts": [
    { "text": "HOOK TEXT", "start": 0, "end": 2.5, "position": "top|center|bottom", "style": "tiktok|clean", "size": 54 }
  ],
  "auto_subtitle": true,
  "karaoke": true,
  "notes": "1-2 kalimat Bahasa Indonesia: apa yang lu susun + kenapa"
}`

    const built = await callLLMJSON({
      workspaceId: wsId,
      contents: [{ role: 'user', parts: [{ text: builder }] }],
      temperature: 0.6,
      maxOutputTokens: 2048,
    })
    const plan = built.parsed
    if (!plan || !Array.isArray(plan.clips) || plan.clips.length === 0) {
      throw new Error('AI gagal nyusun edit plan — coba prompt yang lebih spesifik')
    }
    return NextResponse.json({ ok: true, plan })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
