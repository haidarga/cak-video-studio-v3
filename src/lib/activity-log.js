// Server-side activity logger. Non-fatal — never throws.
import { createAdminClient } from '@/lib/supabase/admin'

export async function logActivity({ workspaceId, userId, action, entityType, entityId, summary, metadata = {} }) {
  if (!workspaceId || !userId) return
  try {
    const admin = createAdminClient()
    await admin.from('activity_log').insert({
      workspace_id: workspaceId, user_id: userId,
      action, entity_type: entityType || null, entity_id: entityId || null,
      summary: summary || null, metadata,
    })
  } catch (e) { console.warn('[activity_log] failed:', e.message) }
}
