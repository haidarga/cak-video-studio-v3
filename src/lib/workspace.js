// Resolve the active workspace for the signed-in user. Used by API routes that
// need workspace-scoped state (API keys, voices, refs). Returns null if no ws.
//
// Convention: we use the user's earliest workspace_members row as their primary
// workspace, matching the pattern in /api/workspace/backup.
export async function getActiveWorkspace(supabase, user) {
  if (!user) return null
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  return data?.[0]?.workspace_id || null
}
