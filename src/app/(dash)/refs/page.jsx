import { createClient } from '@/lib/supabase/server'
import RefsClient from './_components/RefsClient'

export default async function RefsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  const { data: refs } = await supabase
    .from('refs').select('*').eq('workspace_id', ws.id).order('created_at', { ascending: false })

  return <RefsClient workspaceId={ws.id} userId={user.id} initialRefs={refs || []} />
}
