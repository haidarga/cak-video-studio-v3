import { createClient } from '@/lib/supabase/server'
import PostingClient from './_components/PostingClient'

export default async function PostingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  const { data: personas } = await supabase
    .from('personas')
    .select('id, name, username, role_label, avatar_url, postiz_channel_id, postiz_channel_label, postiz_platform')
    .eq('workspace_id', ws.id)
    .order('created_at', { ascending: false })

  return (
    <PostingClient
      workspaceId={ws.id}
      initialPersonas={personas || []}
    />
  )
}
