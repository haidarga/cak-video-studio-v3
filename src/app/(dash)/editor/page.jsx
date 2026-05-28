import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import EditorClient from './_components/EditorClient'

export const metadata = { title: 'Editor — CAK Video' }

export default async function EditorPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const ws = ms?.[0]?.workspaces
  if (!ws) redirect('/')

  const [{ data: results }, { data: projects }, { data: personas }] = await Promise.all([
    supabase.from('results')
      .select('id, type, url, label, ar, qc_status, group_label, created_at, personas(id, name, username, avatar_url)')
      .eq('workspace_id', ws.id).order('created_at', { ascending: false }).limit(120),
    supabase.from('editor_projects')
      .select('id, name, source_result_id, updated_at')
      .eq('workspace_id', ws.id).order('updated_at', { ascending: false }).limit(20),
    supabase.from('personas')
      .select('id, name, username, avatar_url')
      .eq('workspace_id', ws.id).order('name'),
  ])

  return (
    <EditorClient
      workspaceId={ws.id}
      userId={user.id}
      results={results || []}
      projects={projects || []}
      personas={personas || []}
    />
  )
}
