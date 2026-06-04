import { createClient } from '@/lib/supabase/server'
import ScheduledClient from './_components/ScheduledClient'

// Brand-scoped page — re-fetch every request.
export const dynamic = 'force-dynamic'

export default async function ScheduledPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  // Resolve personas in active brand first. Scheduled posts + approved
  // results are filtered by persona_id IN (allowed). Empty brand = empty
  // scheduled list (short-circuit).
  let allowedPersonaIds = null
  if (ws.active_brand_id) {
    const { data: brandPersonas } = await supabase
      .from('personas').select('id')
      .eq('workspace_id', ws.id).eq('brand_id', ws.active_brand_id)
    allowedPersonaIds = (brandPersonas || []).map((p) => p.id)
    if (!allowedPersonaIds.length) {
      return <ScheduledClient workspaceId={ws.id} userId={user.id} initialScheduled={[]} approvedResults={[]} />
    }
  }

  const scheduledQuery = supabase.from('scheduled_posts')
    .select('*, results(id, type, url, label, ar), personas(id, name, username, avatar_url, postiz_channel_id, postiz_platform)')
    .eq('workspace_id', ws.id)
  const approvedQuery = supabase.from('results')
    .select('id, type, url, label, ar, personas(id, name, username, avatar_url, postiz_channel_id, postiz_platform, persona_channels(channel_id, channel_label, platform, postiz_account_id, is_default))')
    .eq('workspace_id', ws.id).eq('qc_status', 'approved')
  if (allowedPersonaIds) {
    scheduledQuery.in('persona_id', allowedPersonaIds)
    approvedQuery.in('persona_id', allowedPersonaIds)
  }

  const [{ data: scheduled }, { data: approved }] = await Promise.all([
    scheduledQuery.order('scheduled_for', { ascending: true, nullsFirst: false }),
    approvedQuery.order('created_at', { ascending: false }).limit(50),
  ])

  return (
    <ScheduledClient
      workspaceId={ws.id}
      userId={user.id}
      initialScheduled={scheduled || []}
      approvedResults={approved || []}
    />
  )
}
