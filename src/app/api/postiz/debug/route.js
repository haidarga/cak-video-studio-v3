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
  return NextResponse.json({
    ok: true,
    accounts: accountResults,
    total: allChannels.length,
    ...(checkId ? { checkId, matched: matched ? { id: matched.id, name: matched.name, account: matched.account_label } : null, match: !!matched } : {}),
  })
}
