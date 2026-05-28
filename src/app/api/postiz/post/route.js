import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPostizPost } from '@/lib/postiz'

// Vercel Pro: allow up to 60s — butuh waktu buat download media + relay-upload.
export const maxDuration = 60

// POST /api/postiz/post — actually push a scheduled_posts row to Postiz.
// Body: { scheduled_post_id }
// Picks the right Postiz creds via target_postiz_account_id (per-row override)
// or persona's postiz_account_id. Single-account compat fallback: first account
// of the workspace.
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { scheduled_post_id } = await req.json()
  if (!scheduled_post_id) return NextResponse.json({ ok: false, error: 'scheduled_post_id required' }, { status: 400 })

  const { data: sp, error } = await supabase
    .from('scheduled_posts')
    .select('*, results(id, type, url, label), personas(id, name, postiz_channel_id, postiz_platform, postiz_account_id, persona_channels(channel_id, channel_label, platform, postiz_account_id, is_default))')
    .eq('id', scheduled_post_id).single()
  if (error || !sp) return NextResponse.json({ ok: false, error: 'scheduled post not found' }, { status: 404 })

  // Channel resolution priority:
  //   1. target_channel_id (per-row mirror override) — most specific
  //   2. persona's default channel from persona_channels (is_default=true)
  //   3. persona's first channel from persona_channels
  //   4. persona's legacy postiz_channel_id (single-link backward compat)
  const personaLinks = sp.personas?.persona_channels || []
  const defaultLink = personaLinks.find((l) => l.is_default) || personaLinks[0]
  const channelId = sp.target_channel_id || defaultLink?.channel_id || sp.personas?.postiz_channel_id
  const platform = sp.target_platform || defaultLink?.platform || sp.personas?.postiz_platform || null
  const accountId = sp.target_postiz_account_id || defaultLink?.postiz_account_id || sp.personas?.postiz_account_id
  if (!channelId) {
    return NextResponse.json({ ok: false, error: `Belum ada target channel. Pilih channel di Schedule modal atau link persona ke channel di /posting.` }, { status: 400 })
  }
  const mediaUrl = sp.results?.url
  if (!mediaUrl) {
    return NextResponse.json({ ok: false, error: 'Result gak ada URL (mungkin ke-delete?)' }, { status: 400 })
  }
  const content = sp.caption || sp.results?.label || ''

  const admin = createAdminClient()

  // Resolve creds — by account_id if available, else fall back to workspace's
  // first account (single-Postiz legacy behaviour).
  let credsRow
  if (accountId) {
    const { data } = await admin.from('postiz_accounts').select('url, api_key').eq('id', accountId).maybeSingle()
    credsRow = data
  }
  if (!credsRow) {
    const { data } = await admin.from('postiz_accounts').select('url, api_key')
      .eq('workspace_id', sp.workspace_id).order('created_at', { ascending: true }).limit(1).maybeSingle()
    credsRow = data
  }
  if (!credsRow) {
    await admin.from('scheduled_posts').update({
      status: 'failed', error: 'Workspace gak punya Postiz account. Tambahin di /settings → Postiz Accounts.',
    }).eq('id', sp.id)
    return NextResponse.json({ ok: false, error: 'Workspace gak punya Postiz account. Tambahin di /settings.' }, { status: 400 })
  }

  await admin.from('scheduled_posts').update({ status: 'posting', error: null }).eq('id', sp.id)

  try {
    const postizResult = await createPostizPost({
      creds: { url: credsRow.url, key: credsRow.api_key },
      channelId,
      content,
      mediaUrl,
      scheduledFor: sp.scheduled_for,
      platform,
    })

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
    await admin.from('scheduled_posts').update({ status: 'failed', error: msg }).eq('id', sp.id)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
