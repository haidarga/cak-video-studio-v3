import { createClient } from '@/lib/supabase/server'
import ScheduledClient from './_components/ScheduledClient'

export default async function ScheduledPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  const [{ data: scheduled }, { data: approved }] = await Promise.all([
    supabase.from('scheduled_posts')
      .select('*, results(id, type, url, label, ar), personas(id, name, username, avatar_url, postiz_channel_id, postiz_platform)')
      .eq('workspace_id', ws.id).order('scheduled_for', { ascending: true, nullsFirst: false }),
    supabase.from('results')
      .select('id, type, url, label, ar, personas(id, name, username, avatar_url, postiz_channel_id, postiz_platform)')
      .eq('workspace_id', ws.id).eq('qc_status', 'approved').order('created_at', { ascending: false }).limit(50),
  ])

  return (
    <ScheduledClient
      workspaceId={ws.id}
      userId={user.id}
      initialScheduled={scheduled || []}
      approvedResults={approved || []}
    />
  )
}
