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

  const [{ data: personas }, { data: brand }] = await Promise.all([
    supabase
      .from('personas')
      .select('*, persona_refs(ref_id, refs(id, fal_url, label))')
      .eq('workspace_id', ws.id)
      .order('created_at', { ascending: false }),
    ws.active_brand_id
      ? supabase.from('brands').select('id, name').eq('id', ws.active_brand_id).single()
      : Promise.resolve({ data: null }),
  ])

  return (
    <PersonasClient
      workspaceId={ws.id}
      userId={user.id}
      activeBrandName={brand?.name || ''}
      initialPersonas={personas || []}
    />
  )
}
