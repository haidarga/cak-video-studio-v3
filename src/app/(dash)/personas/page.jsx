import { createClient } from '@/lib/supabase/server'
import PersonasClient from './_components/PersonasClient'

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

  // Same brand filter as /generate page — personas with matching brand_id
  // OR null (universal/untagged) when an active brand is set.
  const personasQuery = supabase
    .from('personas')
    .select('*, persona_refs(ref_id, refs(id, fal_url, label))')
    .eq('workspace_id', ws.id)
  if (ws.active_brand_id) {
    personasQuery.or(`brand_id.is.null,brand_id.eq.${ws.active_brand_id}`)
  }
  // Brands list for the per-persona Assign Brand dropdown — lets the user
  // re-tag existing untagged personas (created before brand tagging) to a
  // specific brand without going through Supabase SQL.
  const [{ data: personas }, { data: brand }, { data: brands }] = await Promise.all([
    personasQuery.order('created_at', { ascending: false }),
    ws.active_brand_id
      ? supabase.from('brands').select('id, name').eq('id', ws.active_brand_id).single()
      : Promise.resolve({ data: null }),
    supabase.from('brands').select('id, name').eq('workspace_id', ws.id).order('name'),
  ])

  return (
    <PersonasClient
      workspaceId={ws.id}
      userId={user.id}
      activeBrandId={ws.active_brand_id || null}
      activeBrandName={brand?.name || ''}
      brands={brands || []}
      initialPersonas={personas || []}
    />
  )
}
