import { createClient } from '@/lib/supabase/server'
import GenerateClient from './_components/GenerateClient'

// Force dynamic rendering on every request. Was `revalidate = 30` ISR
// before, which cached the persona/refs/brand list for 30s after each
// fetch. When the user switched brands via ActiveBrandWidget, the
// router.refresh() call hit the cached HTML and served stale data until
// the 30s window expired — user reported "musti direfresh dulu baru
// bisa". For brand-scoped content the ISR cache costs more than it saves.
export const dynamic = 'force-dynamic'

export default async function GeneratePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  // Personas are brand-scoped via personas.brand_id. STRICT filter rule:
  //   - active_brand_id set  -> show ONLY personas with matching brand_id.
  //     Untagged personas (brand_id=null) are HIDDEN from a branded view.
  //   - no active brand      -> show all personas (workspace-wide view).
  // User expectation: "brand = folder". Switching brand means switching
  // folder; personas in other folders shouldn't leak through. Untagged
  // personas show up in "Tanpa brand" mode where the user can manage +
  // assign them to a specific brand.
  // Refs stay workspace-wide (refs.brand_id doesn't exist in schema —
  // refs are intentionally shared across brands).
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

  return (
    <GenerateClient
      workspaceId={ws.id}
      userId={user.id}
      activeBrand={brandRes?.data || null}
      personas={personas || []}
      workspaceRefs={refs || []}
    />
  )
}
