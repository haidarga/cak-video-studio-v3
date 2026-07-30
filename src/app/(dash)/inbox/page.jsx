// Inbox — server component page. Fetches studio_jobs for the workspace
// and renders the InboxClient component with pre-fetched data.
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import InboxClient from './InboxClient'

export default async function InboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) redirect('/login')

  // Fetch studio_jobs ordered newest first
  const { data: jobs } = await supabase
    .from('studio_jobs')
    .select('id, title, status, source, source_ref, naskah_text, parsed_shots, persona_mapping, brand_name, brief_context, format_meta, error, result_ids, created_at, updated_at')
    .eq('workspace_id', wsId)
    .order('created_at', { ascending: false })

  // Fetch personas for persona display
  const { data: personas } = await supabase
    .from('personas')
    .select('id, name')
    .eq('workspace_id', wsId)

  const personaMap = new Map((personas || []).map(p => [p.id, p.name]))

  return (
    <InboxClient
      jobs={jobs || []}
      personaMap={Object.fromEntries(personaMap)}
      workspaceId={wsId}
    />
  )
}
