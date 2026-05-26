import { createClient } from '@/lib/supabase/server'
import ResultsClient from './_components/ResultsClient'

export default async function ResultsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  const [{ data: results }, { data: personas }] = await Promise.all([
    supabase.from('results').select('*, personas(id, name, username, avatar_url)')
      .eq('workspace_id', ws.id).order('created_at', { ascending: false }).limit(200),
    supabase.from('personas').select('id, name').eq('workspace_id', ws.id),
  ])

  return <ResultsClient workspaceId={ws.id} initialResults={results || []} personas={personas || []} />
}
