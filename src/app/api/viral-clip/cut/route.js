// POST /api/viral-clip/cut
//
// Cut a long video into platform-target clips (TikTok 60s, Reels 90s,
// Shorts 60s). v3 (Vercel) doesn't have ffmpeg, so we proxy to the v2
// HF Space backend which does. Used by the viral-ad-campaign + viral-
// clip-cutter flows.
//
// Body: {
//   video_url: string         // source video to cut
//   clips: [                  // array of cuts to produce
//     { start: number, duration: number, preset?: 'tiktok'|'reels'|'shorts'|'ig', label?: string }
//   ]
//   result_id?: string        // optional: patch this result row with the
//                              // cut URLs in meta.viral_clips
// }
//
// Returns: { ok, clips: [{ start, duration, preset, label, url, hash }] }
//
// NOTE: v2 backend serves the cut files from its own /clips/<hash>.mp4
// path. Files are cached but not permanent — for archival, the caller
// should re-upload these to R2 via /api/upload. For internal-tool use,
// the v2 cache is usually sufficient.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { assertPublicHttpUrl } from '@/lib/ssrf-guard'

export const runtime = 'nodejs'
export const maxDuration = 60 // ffmpeg cut is fast; 60s covers most batches

const V2_BACKEND = process.env.V2_BACKEND_URL || 'https://cahmul2-cak-video-studio-v2.hf.space'

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    const { video_url, clips, result_id } = await req.json()
    if (!video_url) throw new Error('video_url required')
    assertPublicHttpUrl(video_url, 'video_url') // block SSRF — no fetching internal/metadata hosts
    if (!Array.isArray(clips) || clips.length === 0) throw new Error('clips array required (min 1)')
    if (clips.length > 20) throw new Error('max 20 clips per request')

    const wsId = await getActiveWorkspace(supabase, user)
    if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

    // Process each clip — sequentially since v2 ffmpeg is single-process
    // and parallel requests would just queue at the OS level anyway.
    const results = []
    for (const clip of clips) {
      const start = Math.max(0, parseFloat(clip.start) || 0)
      const preset = clip.preset || null
      const duration = parseFloat(clip.duration) || 60

      const qs = new URLSearchParams({
        url: video_url,
        start: String(start),
        duration: String(duration),
      })
      if (preset) qs.set('preset', preset)

      try {
        const r = await fetch(`${V2_BACKEND}/api/clip-cut?${qs}`)
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.ok) {
          results.push({ ok: false, start, duration, preset, label: clip.label || null, error: j.error || `v2 ${r.status}` })
          continue
        }
        results.push({
          ok: true,
          start, duration: j.duration || duration, preset,
          label: clip.label || null,
          url: j.url, hash: j.hash, source_dur: j.source_dur,
        })
      } catch (e) {
        results.push({ ok: false, start, duration, preset, label: clip.label || null, error: String(e?.message || e) })
      }
    }

    // Optionally patch the source result row with the cut URLs so they
    // show up in QC alongside the original video.
    if (result_id) {
      const { data: row } = await supabase.from('results').select('meta')
        .eq('id', result_id).eq('workspace_id', wsId).maybeSingle()
      if (row) {
        const meta = {
          ...(row?.meta || {}),
          viral_clips: results.filter((c) => c.ok).map((c) => ({
            url: c.url, start: c.start, duration: c.duration, preset: c.preset, label: c.label,
          })),
        }
        await supabase.from('results').update({ meta })
          .eq('id', result_id).eq('workspace_id', wsId)
      }
    }

    return NextResponse.json({
      ok: true,
      source: video_url,
      clips: results,
      count: results.filter((c) => c.ok).length,
      failed: results.filter((c) => !c.ok).length,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
