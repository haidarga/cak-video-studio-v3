import { createClient } from '@/lib/supabase/server'
import QCClient from './_components/QCClient'

// Brand-scoped page — must re-fetch on every request (active brand changes
// the persona filter). Without this, switching brand left stale QC content.
export const dynamic = 'force-dynamic'

export default async function QCPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members').select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  // STRICT brand filter. Personas are scoped to brand via personas.brand_id.
  // QC results are scoped to personas via results.persona_id. So if we
  // resolve "which personas belong to active brand" first, then load only
  // results from those personas, we get true per-brand workspace isolation.
  let allowedPersonaIds = null
  if (ws.active_brand_id) {
    const { data: brandPersonas } = await supabase
      .from('personas').select('id')
      .eq('workspace_id', ws.id).eq('brand_id', ws.active_brand_id)
    allowedPersonaIds = (brandPersonas || []).map((p) => p.id)
    // If brand has no personas yet, short-circuit to empty results.
    if (!allowedPersonaIds.length) {
      return <QCClient workspaceId={ws.id} userId={user.id} initialResults={[]} personas={[]} />
    }
  }

  // Cap at 300 results — old query had no limit + select('*') which shipped
  // entire meta jsonb (cloned_audio_url, base/overlay clip arrays, etc.) for
  // every result. Default surface = recent QC work only; older results are
  // browsable via /results.
  const resultsQuery = supabase.from('results')
    .select('id, type, url, label, ar, qc_status, group_label, created_at, persona_id, personas(id, name, username, avatar_url, postiz_channel_id)')
    .eq('workspace_id', ws.id).not('qc_status', 'is', null)
  const personasQuery = supabase.from('personas')
    .select('id, name, username, avatar_url, postiz_channel_id')
    .eq('workspace_id', ws.id)
  if (allowedPersonaIds) {
    resultsQuery.in('persona_id', allowedPersonaIds)
    personasQuery.eq('brand_id', ws.active_brand_id)
  }

  const [{ data: results }, { data: personas }] = await Promise.all([
    resultsQuery.order('created_at', { ascending: false }).limit(300),
    personasQuery.order('created_at', { ascending: false }).limit(100),
  ])

  return <QCClient workspaceId={ws.id} userId={user.id} initialResults={results || []} personas={personas || []} />
}
