import { createClient } from '@/lib/supabase/server'
import BrandsClient from './_components/BrandsClient'

export default async function BrandsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Get user's active workspace
  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const workspaceId = memberships?.[0]?.workspace_id
  if (!workspaceId) {
    return <div className="p-4 text-sm text-[var(--muted)]">No workspace — refresh /dashboard dulu</div>
  }

  const { data: initialBrands } = await supabase
    .from('brands')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  return (
    <BrandsClient
      workspaceId={workspaceId}
      userId={user.id}
      initialBrands={initialBrands || []}
    />
  )
}
