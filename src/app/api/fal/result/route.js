import { NextResponse } from 'next/server'
import { falResult } from '@/lib/fal-server'
import { createClient } from '@/lib/supabase/server'
import { logUsage } from '@/lib/usage-log'
import { imageCost, videoCost, VIDEO_COSTS_PER_SECOND } from '@/lib/cost-table'

export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const model = searchParams.get('model')
  const request_id = searchParams.get('request_id')
  const workspace_id = searchParams.get('workspace_id') // for usage logging
  const duration = parseFloat(searchParams.get('duration') || '0') // seconds, for video cost
  if (!model || !request_id) return NextResponse.json({ ok: false, error: 'model+request_id required' }, { status: 400 })
  try {
    const result = await falResult(model, request_id)
    // Log usage on successful result. Heuristic: video models have per-second
    // entry in VIDEO_COSTS_PER_SECOND; otherwise treat as image.
    if (workspace_id) {
      const isVideo = !!VIDEO_COSTS_PER_SECOND[model]
      const cost = isVideo ? videoCost(model, duration || 5) : imageCost(model)
      await logUsage({
        workspaceId: workspace_id, userId: user.id,
        kind: isVideo ? 'video_gen' : 'image_gen',
        model, costUsd: cost,
        meta: { request_id, duration },
      })
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
