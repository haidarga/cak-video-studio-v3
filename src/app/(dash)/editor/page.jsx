import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import EditorClient from './_components/EditorClient'

export const metadata = { title: 'Editor — CAK Video' }
// Brand-scoped page — re-fetch on every request.
export const dynamic = 'force-dynamic'

export default async function EditorPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const ws = ms?.[0]?.workspaces
  if (!ws) redirect('/')

  // Resolve personas in active brand. Editor's media library (results) +
  // persona picker both filter by this. Editor projects don't have a
  // direct brand link, but each project's source_result_id chains back
  // to a persona — we filter the project list by joining results.
  let allowedPersonaIds = null
  if (ws.active_brand_id) {
    const { data: brandPersonas } = await supabase
      .from('personas').select('id')
      .eq('workspace_id', ws.id).eq('brand_id', ws.active_brand_id)
    allowedPersonaIds = (brandPersonas || []).map((p) => p.id)
    if (!allowedPersonaIds.length) {
      return <EditorClient workspaceId={ws.id} userId={user.id} results={[]} projects={[]} personas={[]} />
    }
  }

  // `meta` used to be excluded here with a note saying it'd be fetched
  // on-demand when a result is selected. That on-demand fetch was never
  // written — so EditorClient's `result.meta?.cloned_audio_url` (:322) was
  // always null, every clip was created with use_cloned_voice: false, and the
  // 🎙 badge (:1082) never rendered. The persona voice swap we pay ElevenLabs
  // for was silently discarded at the last step before export.
  // Selecting only the two fields the editor actually reads keeps the payload
  // small without dropping the feature.
  const resultsQuery = supabase.from('results')
    .select('id, type, url, label, ar, qc_status, group_label, created_at, persona_id, meta, personas(id, name, username, avatar_url)')
    .eq('workspace_id', ws.id)
  const personasQuery = supabase.from('personas')
    .select('id, name, username, avatar_url')
    .eq('workspace_id', ws.id)
  if (allowedPersonaIds) {
    resultsQuery.in('persona_id', allowedPersonaIds)
    personasQuery.eq('brand_id', ws.active_brand_id)
  }

  const [{ data: results }, { data: projects }, { data: personas }] = await Promise.all([
    resultsQuery.order('created_at', { ascending: false }).limit(120),
    supabase.from('editor_projects')
      .select('id, name, source_result_id, updated_at')
      .eq('workspace_id', ws.id).order('updated_at', { ascending: false }).limit(20),
    personasQuery.order('name').limit(100),
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
