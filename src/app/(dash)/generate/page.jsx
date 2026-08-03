import { createClient } from '@/lib/supabase/server'
import GenerateClient from './_components/GenerateClient'
import { getPresetById } from '@/lib/cinematic-presets'

export const dynamic = 'force-dynamic'

export default async function GeneratePage({ searchParams }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const sp = await searchParams
  const incomingPreset = sp?.preset ? getPresetById(String(sp.preset)) : null

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  let incomingStudioJob = null
  let incomingStudioJobs = []

  if (sp?.studio_job) {
    const rawIds = String(sp.studio_job).split(',').filter(Boolean)
    if (rawIds.length > 0) {
      const { data: jobs } = await supabase
        .from('studio_jobs')
        .select('*')
        .in('id', rawIds)
        .eq('workspace_id', ws.id)

      incomingStudioJobs = jobs || []
      incomingStudioJob = jobs?.[0] || null
    }
  }

  const personasQuery = supabase
    .from('personas')
    .select('id, name, username, avatar_url, role_label, postiz_channel_id, voice_id, voice_name, brand_id, persona_refs(refs(id, fal_url, label, knowledge, kind))')
    .eq('workspace_id', ws.id)
  if (ws.active_brand_id) {
    personasQuery.eq('brand_id', ws.active_brand_id)
  }
  const [{ data: personas }, { data: refs }, brandRes] = await Promise.all([
    personasQuery.order('created_at', { ascending: false }),
    supabase.from('refs').select('id, fal_url, label, knowledge, kind').eq('workspace_id', ws.id).order('created_at', { ascending: false }),
    ws.active_brand_id
      ? supabase.from('brands').select('id, name, notes, config').eq('id', ws.active_brand_id).single()
      : Promise.resolve({ data: null }),
  ])

  const incomingCameraPreset = sp?.camera_preset || null
  const incomingImgModel = sp?.img_model || null
  // Constraints chosen in the Studio Inbox modal before launching a batch.
  // Undefined (param absent) = caller said nothing, keep /generate's defaults.
  const incomingConstraints = sp?.constraints === undefined ? null : String(sp.constraints)

  return (
    <GenerateClient
      workspaceId={ws.id}
      userId={user.id}
      activeBrand={brandRes?.data || null}
      personas={personas || []}
      workspaceRefs={refs || []}
      incomingPreset={incomingPreset}
      incomingCameraPreset={incomingCameraPreset}
      incomingImgModel={incomingImgModel}
      incomingConstraints={incomingConstraints}
      incomingStudioJob={incomingStudioJob}
      incomingStudioJobs={incomingStudioJobs}
    />
  )
}
