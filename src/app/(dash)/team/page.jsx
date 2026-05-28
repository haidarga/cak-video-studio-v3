import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import TeamClient from './_components/TeamClient'

export const metadata = { title: 'Team — CAK Video' }

export default async function TeamPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const ws = ms?.[0]?.workspaces
  const myRole = ms?.[0]?.role
  if (!ws) redirect('/')

  // Get all members + invites
  const [{ data: members }, { data: invites }] = await Promise.all([
    supabase.from('workspace_members')
      .select('user_id, role, added_at')
      .eq('workspace_id', ws.id)
      .order('added_at', { ascending: true }),
    supabase.from('workspace_invites')
      .select('id, code, role, created_at, used_at, used_by, expires_at')
      .eq('workspace_id', ws.id)
      .order('created_at', { ascending: false }),
  ])

  return <TeamClient workspaceId={ws.id} workspaceName={ws.name} userId={user.id} myRole={myRole} members={members || []} invites={invites || []} />
}
