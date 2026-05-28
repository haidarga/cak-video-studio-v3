import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST /api/invites/redeem { code } — user redeem invite code to join workspace
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { code } = await req.json()
  if (!code) return NextResponse.json({ ok: false, error: 'code required' }, { status: 400 })

  const admin = createAdminClient()
  const { data: invite } = await admin.from('workspace_invites').select('*').eq('code', code.trim()).maybeSingle()
  if (!invite) return NextResponse.json({ ok: false, error: 'Code gak valid' }, { status: 404 })
  if (invite.used_by) return NextResponse.json({ ok: false, error: 'Code udah dipakai' }, { status: 400 })
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ ok: false, error: 'Code udah expired' }, { status: 400 })
  }

  // Add user as workspace member
  const { error: memErr } = await admin.from('workspace_members').insert({
    workspace_id: invite.workspace_id, user_id: user.id, role: invite.role,
  })
  if (memErr && !memErr.message.includes('duplicate')) {
    return NextResponse.json({ ok: false, error: memErr.message }, { status: 500 })
  }

  // Mark invite as used
  await admin.from('workspace_invites').update({ used_by: user.id, used_at: new Date().toISOString() }).eq('id', invite.id)

  // Get workspace for display
  const { data: ws } = await admin.from('workspaces').select('id, name').eq('id', invite.workspace_id).single()

  return NextResponse.json({ ok: true, workspace: ws, role: invite.role })
}
