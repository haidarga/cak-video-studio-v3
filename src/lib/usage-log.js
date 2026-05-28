// Server-side usage logger. Insert ke usage_log via admin client (bypass RLS).
// Called dari /api/fal/* dan /api/draft/* setelah successful gen.

import { createAdminClient } from '@/lib/supabase/admin'

export async function logUsage({ workspaceId, userId, kind, model, costUsd, meta = {} }) {
  if (!workspaceId || !userId) return
  try {
    const admin = createAdminClient()
    await admin.from('usage_log').insert({
      workspace_id: workspaceId,
      user_id: userId,
      kind,
      model: model || null,
      cost_usd: costUsd || 0,
      meta,
    })
  } catch (e) {
    // Non-fatal; just log
    console.warn('[usage_log] insert failed:', e.message)
  }
}
