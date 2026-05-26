import { createClient } from '@/lib/supabase/server'
import QCClient from './_components/QCClient'

export default async function QCPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  const [{ data: results }, { data: personas }] = await Promise.all([
    supabase.from('results').select('*, personas(id, name, username, avatar_url, postiz_channel_id)')
      .eq('workspace_id', ws.id).not('qc_status', 'is', null)
      .order('created_at', { ascending: false }),
    supabase.from('personas').select('id, name, username, avatar_url, postiz_channel_id')
      .eq('workspace_id', ws.id).order('created_at', { ascending: false }),
  ])

  return <QCClient workspaceId={ws.id} userId={user.id} initialResults={results || []} personas={personas || []} />
}
