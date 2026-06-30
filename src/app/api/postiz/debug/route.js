import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchPostizChannels } from '@/lib/postiz'
import { getActiveWorkspace } from '@/lib/workspace'

// GET /api/postiz/debug — list integrations from ALL workspace's Postiz accounts.
// Used to debug 'Postiz 404 not_found' on /posts.
// Query: ?channel_id=xxx (optional) — reports whether that id matches any
// integration across any of the workspace's Postiz accounts.
export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const checkId = searchParams.get('channel_id')

  const admin = createAdminClient()
  const { data: accounts } = await admin.from('postiz_accounts')
    .select('id, label, url, api_key').eq('workspace_id', wsId).order('created_at', { ascending: true })
  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ ok: false, error: 'Belum ada Postiz account di workspace.' }, { status: 400 })
  }

  const results = await Promise.allSettled(accounts.map(async (a) => {
    const channels = await fetchPostizChannels({ url: a.url, key: a.api_key })
    return { account: a.label, total: channels.length,
      channels: channels.map((c) => ({ id: c.id, name: c.name, username: c.username, platform: c.platform })) }
  }))
  const allChannels = []
  const accountResults = results.map((r, i) => {
    if (r.status === 'fulfilled') {
      allChannels.push(...r.value.channels.map((c) => ({ ...c, account_id: accounts[i].id, account_label: accounts[i].label })))
      return { account: accounts[i].label, ok: true, total: r.value.total }
    }
    return { account: accounts[i].label, ok: false, error: String(r.reason?.message || r.reason) }
  })

  const matched = checkId ? allChannels.find((c) => String(c.id) === String(checkId)) : null

  // ── Persona → channel binding audit ────────────────────────────────
  // Shows, per persona, which LIVE channel its bound channel_id actually
  // resolves to — and flags when the live channel's name/username does NOT
  // match the stored label. That mismatch is the "Ben uploads land on Rio"
  // bug: a VALID but WRONG channel_id (points to another persona's account).
  const liveById = new Map(allChannels.map((c) => [String(c.id), c]))
  const norm = (s) => String(s || '').toLowerCase().replace(/^@/, '').trim()
  const { data: personas } = await admin
    .from('personas')
    .select('id, name, postiz_channel_id, postiz_channel_label, persona_channels(id, channel_id, channel_label, username, is_default)')
    .eq('workspace_id', wsId).order('name')

  const personaAudit = (personas || []).map((p) => {
    const links = (p.persona_channels || []).map((l) => {
      const live = liveById.get(String(l.channel_id))
      const labelNorm = norm(l.channel_label)
      const liveMatchesLabel = live ? [live.name, live.username].map(norm).includes(labelNorm) : false
      return {
        link_id: l.id,
        is_default: !!l.is_default,
        bound_channel_id: l.channel_id,
        stored_label: l.channel_label,
        live: live ? { id: live.id, name: live.name, username: live.username, account: live.account_label } : null,
        status: !live ? 'DEAD_ID_DRIFT'
          : (labelNorm && !liveMatchesLabel) ? 'WRONG_ACCOUNT'
          : 'OK',
      }
    })
    return { persona_id: p.id, name: p.name, links }
  })
  const problems = personaAudit
    .flatMap((p) => p.links.filter((l) => l.status !== 'OK').map((l) => ({ persona: p.name, ...l })))

  return NextResponse.json({
    ok: true,
    accounts: accountResults,
    total: allChannels.length,
    liveChannels: allChannels.map((c) => ({ id: c.id, name: c.name, username: c.username, platform: c.platform, account: c.account_label })),
    personaAudit,
    problems,
    ...(checkId ? { checkId, matched: matched ? { id: matched.id, name: matched.name, account: matched.account_label } : null, match: !!matched } : {}),
  })
}
