import { NextResponse } from 'next/server'
import { fetchPostizChannels } from '@/lib/postiz'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/workspace'

// GET /api/postiz/channels — sync the user's workspace channels from ALL
// Postiz accounts. Returns merged channel list, each tagged with the source
// account_id + account_label so the UI can show which Postiz a channel came from.
//
// Optional query param ?account_id=<uuid> — fetch from only that account.
export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  // Use admin client to read api_key (RLS allows members to read, but admin
  // sidesteps any JWT-loss-during-render edge cases).
  const admin = createAdminClient()
  const { searchParams } = new URL(req.url)
  const onlyAccountId = searchParams.get('account_id')

  let q = admin.from('postiz_accounts').select('id, label, url, api_key').eq('workspace_id', wsId)
  if (onlyAccountId) q = q.eq('id', onlyAccountId)
  const { data: accounts, error } = await q.order('created_at', { ascending: true })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!accounts || accounts.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'Belum ada Postiz account. Tambahin dulu di /settings → Postiz Accounts.',
      channels: [],
    }, { status: 400 })
  }

  // Fetch from each account in parallel; tag each channel with source account info.
  const results = await Promise.allSettled(accounts.map(async (a) => {
    const channels = await fetchPostizChannels({ url: a.url, key: a.api_key })
    return channels.map((c) => ({
      ...c,
      account_id: a.id,
      account_label: a.label,
    }))
  }))

  const channels = []
  const accountErrors = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') channels.push(...r.value)
    else accountErrors.push({ account: accounts[i].label, error: String(r.reason?.message || r.reason) })
  })

  return NextResponse.json({
    ok: true,
    channels,
    account_count: accounts.length,
    ...(accountErrors.length ? { account_errors: accountErrors } : {}),
  })
}
