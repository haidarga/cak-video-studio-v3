import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getPostizPost, getPostizIntegration } from '@/lib/postiz'

// GET /api/postiz/check?scheduled_post_id=xxx
// Re-queries Postiz to find the CURRENT state of a post (QUEUE/PUBLISHED/ERROR)
// + integration details (actual provider, platform). Helpful kalo v3 mark
// 'posted' tapi platform aktualnya gak nongol — Postiz post state ngasih tau
// apakah it's still queued, published (with URL), or errored at platform level.
export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const scheduledPostId = searchParams.get('scheduled_post_id')
  if (!scheduledPostId) return NextResponse.json({ ok: false, error: 'scheduled_post_id required' }, { status: 400 })

  // Pull our row to get external_id (postiz postId) + channel id
  const { data: sp, error } = await supabase
    .from('scheduled_posts')
    .select('id, external_id, external_response, status, personas(postiz_channel_id, postiz_platform)')
    .eq('id', scheduledPostId).single()
  if (error || !sp) return NextResponse.json({ ok: false, error: 'scheduled post not found' }, { status: 404 })

  // Try to dig postId out of external_response (Postiz response shape varies)
  let postId = sp.external_id
  if (!postId && sp.external_response) {
    const r = sp.external_response
    postId = r?.posts?.[0]?.id || r?.[0]?.postId || r?.[0]?.id || r?.postId || null
  }

  const integrationId = sp.personas?.postiz_channel_id

  const [post, integration] = await Promise.all([
    postId ? getPostizPost(postId).catch((e) => ({ error: String(e?.message || e) })) : Promise.resolve(null),
    integrationId ? getPostizIntegration(integrationId).catch((e) => ({ error: String(e?.message || e) })) : Promise.resolve(null),
  ])

  return NextResponse.json({
    ok: true,
    postId,
    integrationId,
    persona_platform_tagged: sp.personas?.postiz_platform || null,
    post,
    integration,
    // Hint utama: actual platform per integration vs yg lu tagged di v3
    integration_actual_platform:
      integration?.providerIdentifier || integration?.platform || integration?.provider || null,
  })
}
