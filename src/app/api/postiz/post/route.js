import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPostizPost } from '@/lib/postiz'
import { getActiveWorkspace } from '@/lib/workspace'

// Vercel Pro: allow up to 60s — butuh waktu buat download media + relay-upload.
// lib/postiz.js sizes its own download/upload timeouts to fail cleanly inside
// this budget; anything that still dies is recovered by /api/cron/reconcile-posts.
export const runtime = 'nodejs' // lib/postiz.js uses Buffer
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

  // Workspace-scope BEFORE fetching so a user can't trigger Postiz posts on
  // another workspace's scheduled_posts (which would burn their Postiz
  // quota AND publish content under their channel creds).
  const wsId = await getActiveWorkspace(supabase, user)
  const { data: sp, error } = await supabase
    .from('scheduled_posts')
    .select('*, results(id, type, url, label), personas(id, name, postiz_channel_id, postiz_channel_label, postiz_platform, postiz_account_id, persona_channels(id, channel_id, channel_label, username, platform, postiz_account_id, is_default))')
    .eq('id', scheduled_post_id).eq('workspace_id', wsId).single()
  if (error || !sp) return NextResponse.json({ ok: false, error: 'scheduled post not found' }, { status: 404 })

  // Workspace-level toggle for TikTok's auto-add-music. Read once and pass
  // through; createPostizPost only applies it on TikTok platform settings.
  const { data: wsRow } = await supabase
    .from('workspaces').select('tiktok_auto_add_music').eq('id', sp.workspace_id).maybeSingle()
  const tiktokAutoAddMusic = !!wsRow?.tiktok_auto_add_music

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
  // Channel label for the drift / wrong-account guards in createPostizPost.
  // Without a label those guards are skipped entirely and a stale id can publish
  // to another persona's account — so we work harder to produce one.
  //
  // In mirror mode we must NOT fall back to the persona's DEFAULT link label:
  // that label describes a different channel and would false-positive as
  // WRONG_ACCOUNT. But we can safely fall back to the link for THIS EXACT
  // channel_id — it is the same channel, just labelled in another table.
  const linkForTarget = sp.target_channel_id
    ? personaLinks.find((l) => String(l.channel_id) === String(sp.target_channel_id))
    : null
  // personas.postiz_channel_label describes the LEGACY personas.postiz_channel_id,
  // so it is only a valid label when we are actually falling back to that legacy
  // id. Using it alongside a persona_channels link would describe a different
  // channel and could trip the wrong-account guard into re-binding the post.
  const channelLabel = sp.target_channel_id
    ? (sp.target_channel_label || linkForTarget?.channel_label || linkForTarget?.username || null)
    : defaultLink
      ? (defaultLink.channel_label || defaultLink.username || null)
      : (sp.personas?.postiz_channel_label || null)
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
    // MUST be scoped to this row's workspace. target_postiz_account_id is written
    // by the client on insert, and RLS on scheduled_posts only checks workspace
    // membership — it never validates that the referenced postiz_account belongs
    // to the same workspace. Without this filter, a member of workspace A could
    // insert a row pointing at workspace B's account id and make the server
    // publish with B's credentials, onto B's social accounts.
    const { data } = await admin.from('postiz_accounts').select('url, api_key')
      .eq('id', accountId).eq('workspace_id', sp.workspace_id).maybeSingle()
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
    const { response: postizResult, binding } = await createPostizPost({
      creds: { url: credsRow.url, key: credsRow.api_key },
      channelId,
      channelLabel,
      content,
      mediaUrl,
      scheduledFor: sp.scheduled_for,
      platform,
      tiktokAutoAddMusic,
    })

    const externalId =
      postizResult?.id
      || postizResult?.posts?.[0]?.id
      || postizResult?.[0]?.id
      || (Array.isArray(postizResult) ? postizResult[0]?.releaseURL : null)
      || null

    const isScheduled = !!sp.scheduled_for
    const baseUpdate = {
      status: isScheduled ? 'scheduled' : 'posted',
      external_id: externalId,
      external_response: postizResult,
      posted_at: isScheduled ? null : new Date().toISOString(),
      error: null,
    }
    // Record where the post ACTUALLY went. Previously a healed binding was only
    // fixed in memory, so the row kept claiming a channel it never used.
    const { error: updErr } = await admin.from('scheduled_posts').update({
      ...baseUpdate,
      target_channel_id: binding.channelId,
      target_channel_label: binding.verifiedLabel || channelLabel || null,
      target_platform: binding.platform || platform || null,
    }).eq('id', sp.id)
    // The post is already live at this point, so a failed status write must not
    // leave the row looking stuck. Most likely cause: migration 0031 (which adds
    // target_channel_label) hasn't been applied yet — retry without the new
    // column so the row still lands on 'posted' instead of stranding in 'posting'.
    if (updErr) {
      console.warn('[postiz] status update failed, retrying without new columns:', updErr.message)
      await admin.from('scheduled_posts').update(baseUpdate).eq('id', sp.id)
    }

    // Persist the heal so the NEXT post doesn't repeat the same lookup and take
    // the same wrong-account risk. Best-effort: a unique (persona_id, channel_id)
    // collision just means the correct link already exists.
    if (binding.healed && linkForTarget?.id) {
      const { error: healErr } = await admin.from('persona_channels').update({
        channel_id: binding.channelId,
        channel_label: binding.verifiedLabel || linkForTarget.channel_label,
        platform: binding.platform || linkForTarget.platform,
      }).eq('id', linkForTarget.id)
      if (healErr) console.warn('[postiz] could not persist healed binding:', healErr.message)
    } else if (binding.healed && !sp.target_channel_id && defaultLink?.id) {
      const { error: healErr } = await admin.from('persona_channels').update({
        channel_id: binding.channelId,
        channel_label: binding.verifiedLabel || defaultLink.channel_label,
        platform: binding.platform || defaultLink.platform,
      }).eq('id', defaultLink.id)
      if (healErr) console.warn('[postiz] could not persist healed binding:', healErr.message)
    }
    if (binding.unverified) {
      console.warn(`[postiz] post ${sp.id} sent to channel ${binding.channelId} WITHOUT a label to verify identity against.`)
    }

    return NextResponse.json({ ok: true, result: postizResult, scheduled: isScheduled, binding })
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 1000)
    await admin.from('scheduled_posts').update({ status: 'failed', error: msg }).eq('id', sp.id)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
