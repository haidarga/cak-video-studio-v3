// Server-side error logger ala mini-Sentry. Inserts ke error_log via admin
// client. Non-fatal — never throws (no error feedback loops).
import { createAdminClient } from '@/lib/supabase/admin'

export async function logError({ workspaceId = null, userId = null, source, level = 'error', message, stack = null, metadata = {} }) {
  try {
    const admin = createAdminClient()
    await admin.from('error_log').insert({
      workspace_id: workspaceId,
      user_id: userId,
      source,
      level,
      message: String(message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 5000) : null,
      metadata,
    })
  } catch (e) { console.warn('[error_log] failed:', e.message) }
}

// Helper: wrap API route handler with auto error logging.
// Usage: export const POST = withErrorLog('source', async (req) => { ... })
export function withErrorLog(source, handler) {
  return async (req, ...rest) => {
    try {
      return await handler(req, ...rest)
    } catch (e) {
      await logError({ source, message: e?.message || String(e), stack: e?.stack, metadata: { url: req.url } })
      throw e
    }
  }
}
