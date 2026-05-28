import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/workspace/backup — download full workspace data as JSON.
// Manual backup mechanism while we don't have automated dumps.
export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const ws = ms?.[0]?.workspaces
  if (!ws) return NextResponse.json({ ok: false, error: 'No workspace' }, { status: 404 })

  // Fetch all major tables for this workspace
  const tables = ['personas', 'brands', 'refs', 'persona_refs', 'results', 'scheduled_posts', 'editor_projects']
  const dump = { workspace: ws, exported_at: new Date().toISOString(), tables: {} }

  for (const t of tables) {
    const { data } = await supabase.from(t).select('*').eq('workspace_id', ws.id).limit(10000)
    dump.tables[t] = data || []
  }
  // persona_refs joins personas — fetch by persona_id
  const personaIds = (dump.tables.personas || []).map((p) => p.id)
  if (personaIds.length > 0) {
    const { data } = await supabase.from('persona_refs').select('*').in('persona_id', personaIds)
    dump.tables.persona_refs = data || []
  }

  // Activity log + usage_log (audit context)
  const { data: act } = await supabase.from('activity_log').select('*').eq('workspace_id', ws.id).order('created_at', { ascending: false }).limit(1000)
  dump.tables.activity_log = act || []
  const { data: usage } = await supabase.from('usage_log').select('*').eq('workspace_id', ws.id).order('created_at', { ascending: false }).limit(2000)
  dump.tables.usage_log = usage || []

  const filename = `cak-video-backup-${ws.name.replace(/[^a-z0-9]/gi, '_')}-${new Date().toISOString().slice(0, 10)}.json`
  return new NextResponse(JSON.stringify(dump, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
