import { createClient } from '@/lib/supabase/server'
import PostingClient from './_components/PostingClient'

// Brand-scoped page — re-fetch every request so brand switch reflects.
export const dynamic = 'force-dynamic'

export default async function PostingPage() {
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

  // Load personas with their N linked channels (persona_channels join). The
  // singular postiz_channel_id columns are kept as fallback but new UI uses
  // persona_channels for multi-link support.
  // STRICT brand filter — only show personas tagged to active brand.
  const personasQuery = supabase
    .from('personas')
    .select(`
      id, name, username, role_label, avatar_url,
      postiz_channel_id, postiz_channel_label, postiz_platform, postiz_account_id,
      persona_channels(id, channel_id, channel_label, platform, username, is_default, postiz_account_id)
    `)
    .eq('workspace_id', ws.id)
  if (ws.active_brand_id) {
    personasQuery.eq('brand_id', ws.active_brand_id)
  }
  const { data: personas } = await personasQuery.order('created_at', { ascending: false })

  return (
    <PostingClient
      workspaceId={ws.id}
      initialPersonas={personas || []}
    />
  )
}
