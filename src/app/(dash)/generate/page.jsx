import { createClient } from '@/lib/supabase/server'
import GenerateClient from './_components/GenerateClient'

// Revalidate the server-rendered persona/refs/brand list every 30s so the page
// loads fast on subsequent visits while staying reasonably fresh. Client-side
// realtime still picks up live changes during a session.
export const revalidate = 30

export default async function GeneratePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id).order('added_at', { ascending: true }).limit(1)
  const ws = memberships?.[0]?.workspaces
  if (!ws) return <div className="p-4 text-sm text-[var(--muted)]">No workspace</div>

  // Personas are brand-scoped via personas.brand_id. Filter rule:
  //   - active_brand_id set  -> show personas with matching brand_id OR null
  //     (null = "universal" personas not tagged to any brand — backward
  //     compat for personas created before brand tagging existed)
  //   - no active brand      -> show all personas (workspace-wide)
  // Refs stay workspace-wide (refs.brand_id doesn't exist in schema —
  // refs are intentionally shared across brands).
  const personasQuery = supabase
    .from('personas')
    .select('id, name, username, avatar_url, role_label, postiz_channel_id, voice_id, voice_name, brand_id, persona_refs(refs(id, fal_url, label, knowledge, kind))')
    .eq('workspace_id', ws.id)
  if (ws.active_brand_id) {
    personasQuery.or(`brand_id.is.null,brand_id.eq.${ws.active_brand_id}`)
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
