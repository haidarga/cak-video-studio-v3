import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPostizPost } from '@/lib/postiz'

// Vercel Pro: allow up to 60s — we need time to download media + relay-upload
// to Postiz before creating the post.
export const maxDuration = 60

// POST /api/postiz/post — actually push a scheduled_posts row to Postiz.
// Body: { scheduled_post_id }
// Reads the row, validates persona has postiz_channel_id, downloads media,
// relays it to Postiz /upload, then creates the post with platform-specific
// settings. Updates row with response.
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { scheduled_post_id } = await req.json()
  if (!scheduled_post_id) return NextResponse.json({ ok: false, error: 'scheduled_post_id required' }, { status: 400 })

  const { data: sp, error } = await supabase
    .from('scheduled_posts')
    .select('*, results(id, type, url, label), personas(id, name, postiz_channel_id, postiz_platform)')
    .eq('id', scheduled_post_id).single()
  if (error || !sp) return NextResponse.json({ ok: false, error: 'scheduled post not found' }, { status: 404 })

  // Mirror upload: prefer target_channel_id (per-row override) atas persona's
  // default postiz_channel_id. Sama untuk platform.
  const channelId = sp.target_channel_id || sp.personas?.postiz_channel_id
  const platform = sp.target_platform || sp.personas?.postiz_platform || null
  if (!channelId) {
    return NextResponse.json({ ok: false, error: `Belum ada target channel. Pilih channel di Schedule modal atau link persona ke channel di /posting.` }, { status: 400 })
  }
  const mediaUrl = sp.results?.url
  if (!mediaUrl) {
    return NextResponse.json({ ok: false, error: 'Result gak ada URL (mungkin ke-delete?)' }, { status: 400 })
  }
  const content = sp.caption || sp.results?.label || ''

  // Use admin client so the update bypasses RLS (server-side trust).
  const admin = createAdminClient()
  await admin.from('scheduled_posts').update({ status: 'posting', error: null }).eq('id', sp.id)

  try {
    const postizResult = await createPostizPost({
      channelId,
      content,
      mediaUrl,
      scheduledFor: sp.scheduled_for,
      platform,
    })

    // Try to extract a returned id (Postiz response shape varies by version)
    const externalId =
      postizResult?.id
      || postizResult?.posts?.[0]?.id
      || postizResult?.[0]?.id
      || (Array.isArray(postizResult) ? postizResult[0]?.releaseURL : null)
      || null

    const isScheduled = !!sp.scheduled_for
    await admin.from('scheduled_posts').update({
      status: isScheduled ? 'scheduled' : 'posted',
      external_id: externalId,
      external_response: postizResult,
      posted_at: isScheduled ? null : new Date().toISOString(),
      error: null,
    }).eq('id', sp.id)
    return NextResponse.json({ ok: true, result: postizResult, scheduled: isScheduled })
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 1000)
    await admin.from('scheduled_posts').update({
      status: 'failed',
      error: msg,
    }).eq('id', sp.id)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
