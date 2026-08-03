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

  // Active brand — studio_jobs carry brand_id (set at ingest by matching the
  // brand_name Caketing sends), but the Inbox never used it, so every brand's
  // jobs showed up under every other brand. Executing one from the wrong brand
  // then generated with the wrong brand's personas.
  const { data: ws } = await supabase
    .from('workspaces').select('active_brand_id').eq('id', wsId).maybeSingle()
  const activeBrandId = ws?.active_brand_id || null
  const { data: activeBrand } = activeBrandId
    ? await supabase.from('brands').select('name').eq('id', activeBrandId).maybeSingle()
    : { data: null }

  // Fetch studio_jobs ordered newest first
  const { data: allJobs } = await supabase
    .from('studio_jobs')
    .select('id, title, status, source, source_ref, naskah_text, parsed_shots, persona_mapping, brand_id, brand_name, brief_context, format_meta, error, result_ids, created_at, updated_at')
    .eq('workspace_id', wsId)
    .order('created_at', { ascending: false })

  // Jobs with a NULL brand_id are kept visible on purpose: they predate brand
  // tagging, or Caketing's client name didn't match a Studio brand. Hiding them
  // would make pushed work vanish with no explanation — the UI flags them
  // instead so the mismatch is fixable.
  const jobs = activeBrandId
    ? (allJobs || []).filter((j) => !j.brand_id || j.brand_id === activeBrandId)
    : (allJobs || [])
  const hiddenByBrand = (allJobs || []).length - jobs.length

  // Fetch personas for persona display
  const { data: personas } = await supabase
    .from('personas')
    .select('id, name')
    .eq('workspace_id', wsId)

  const personaMap = new Map((personas || []).map(p => [p.id, p.name]))

  return (
    <InboxClient
      key={activeBrandId || "no-brand"}
      jobs={jobs || []}
      hiddenByBrand={hiddenByBrand}
      activeBrandName={activeBrand?.name || null}
      personaMap={Object.fromEntries(personaMap)}
      workspaceId={wsId}
    />
  )
}
