import { createClient } from '@/lib/supabase/server'
import GodModeClient from './_components/GodModeClient'

// Brand-scoped — re-fetch on every request so brand switch reflects the
// available personas + product refs immediately.
export const dynamic = 'force-dynamic'

export default async function GodModePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  // Brand-scope personas (same rule as /generate). Untagged personas appear
  // only when "Tanpa brand" mode is selected.
  const personasQuery = supabase
    .from('personas')
    .select('id, name, username, avatar_url, brand_id, persona_refs(refs(id, fal_url, label, knowledge, kind))')
    .eq('workspace_id', ws.id)
  if (ws.active_brand_id) {
    personasQuery.eq('brand_id', ws.active_brand_id)
  }

  const [{ data: personas }, { data: refs }, brandRes] = await Promise.all([
    personasQuery.order('created_at', { ascending: false }),
    // Refs are workspace-wide (shared across brands) — same as /generate.
    supabase.from('refs').select('id, fal_url, label, knowledge, kind').eq('workspace_id', ws.id).order('created_at', { ascending: false }),
    ws.active_brand_id
      ? supabase.from('brands').select('id, name, notes, config').eq('id', ws.active_brand_id).single()
      : Promise.resolve({ data: null }),
  ])

  return (
    <GodModeClient
      workspaceId={ws.id}
      userId={user.id}
      activeBrand={brandRes?.data || null}
      personas={personas || []}
      refs={refs || []}
    />
  )
}
