import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST /api/postiz/analytics — fetch engagement stats from Postiz for posted
// scheduled_posts. Optional body: { post_ids } to limit. Default: all posted
// in last 30 days. Updates external_response with latest stats.
export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { post_ids } = body || {}

  const { data: ms } = await supabase.from('workspace_members').select('workspace_id').eq('user_id', user.id).limit(1).single()
  if (!ms) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  // Find posted rows with external_id (Postiz post id)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  let q = supabase.from('scheduled_posts')
    .select('id, external_id, external_response')
    .eq('workspace_id', ms.workspace_id)
    .eq('status', 'posted')
    .not('external_id', 'is', null)
    .gte('posted_at', since)
  if (Array.isArray(post_ids) && post_ids.length) q = q.in('id', post_ids)
  const { data: rows } = await q.limit(100)
  if (!rows?.length) return NextResponse.json({ ok: true, fetched: 0, updated: 0 })

  // Postiz API endpoint to get post analytics — varies by version
  const url = (process.env.POSTIZ_API_URL || '').replace(/\/$/, '')
  const key = process.env.POSTIZ_API_KEY
  if (!url || !key) return NextResponse.json({ ok: false, error: 'POSTIZ_API_URL / KEY missing' }, { status: 500 })

  const admin = createAdminClient()
  let updated = 0
  const results = []
  for (const row of rows) {
    // Try several path patterns for analytics
    const paths = [
      `/public/v1/posts/${row.external_id}`,
      `/api/public/v1/posts/${row.external_id}`,
      `/api/v1/posts/${row.external_id}/analytics`,
    ]
    let postData = null
    for (const path of paths) {
      try {
        const res = await fetch(`${url}${path}`, { headers: { Authorization: key }, cache: 'no-store' })
        if (res.ok) {
          postData = await res.json()
          break
        }
      } catch {}
    }
    if (!postData) { results.push({ id: row.id, error: 'no analytics' }); continue }

    // Merge analytics into external_response.analytics
    const merged = { ...(row.external_response || {}), analytics: postData, analytics_fetched_at: new Date().toISOString() }
    await admin.from('scheduled_posts').update({ external_response: merged }).eq('id', row.id)
    updated++
    results.push({ id: row.id, ok: true })
  }

  return NextResponse.json({ ok: true, fetched: rows.length, updated, details: results })
}
