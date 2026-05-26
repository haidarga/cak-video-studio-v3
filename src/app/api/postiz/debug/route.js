import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchPostizChannels } from '@/lib/postiz'

// GET /api/postiz/debug — list Postiz integrations + verify a specific channel_id
// exists. Used to debug 'Postiz 404 not_found' on /posts.
//
// Query: ?channel_id=xxx (optional) → reports whether that id matches any
// integration; useful kalau Postiz post API balik not_found.
export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const checkId = searchParams.get('channel_id')

  try {
    const channels = await fetchPostizChannels()
    const matched = checkId
      ? channels.find((c) => String(c.id) === String(checkId))
      : null
    return NextResponse.json({
      ok: true,
      total: channels.length,
      channels: channels.map((c) => ({ id: c.id, name: c.name, username: c.username, platform: c.platform })),
      ...(checkId ? { checkId, matched: matched ? { id: matched.id, name: matched.name } : null, match: !!matched } : {}),
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
