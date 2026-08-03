import { createClient } from '@/lib/supabase/server'
import PersonasClient from './_components/PersonasClient'

// Same reasoning as /generate — brand-scoped persona list must be fresh
// on every navigation. Without this, router.refresh() after a brand
// switch can hit cached HTML and serve stale data.
export const dynamic = 'force-dynamic'

export default async function PersonasPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  // Same STRICT filter as /generate — brand active = only matching
  // brand_id. Untagged personas are HIDDEN unless user switches to
  // "Tanpa brand" mode (where they show up alongside everything else
  // for management).
  const personasQuery = supabase
    .from('personas')
    .select('*, persona_refs(ref_id, refs(id, fal_url, label))')
    .eq('workspace_id', ws.id)
  if (ws.active_brand_id) {
    personasQuery.eq('brand_id', ws.active_brand_id)
  }
  // ALSO load the untagged count so the page can surface a migration
  // banner ("X untagged personas — assign all to ACEKID?"). Cheap query
  // (count only, no row data).
  const untaggedCountP = supabase
    .from('personas')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws.id)
    .is('brand_id', null)
  // Brands list for the per-persona Assign Brand dropdown — lets the user
  // re-tag existing untagged personas (created before brand tagging) to a
  // specific brand without going through Supabase SQL.
  const [{ data: personas }, { data: brand }, { data: brands }, untaggedRes] = await Promise.all([
    personasQuery.order('created_at', { ascending: false }),
    ws.active_brand_id
      ? supabase.from('brands').select('id, name').eq('id', ws.active_brand_id).single()
      : Promise.resolve({ data: null }),
    supabase.from('brands').select('id, name').eq('workspace_id', ws.id).order('name'),
    untaggedCountP,
  ])

  return (
    <PersonasClient
      key={ws.active_brand_id || "no-brand"}
      workspaceId={ws.id}
      userId={user.id}
      activeBrandId={ws.active_brand_id || null}
      activeBrandName={brand?.name || ''}
      brands={brands || []}
      untaggedCount={untaggedRes?.count || 0}
      initialPersonas={personas || []}
    />
  )
}
