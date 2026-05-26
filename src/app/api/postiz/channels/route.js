import { NextResponse } from 'next/server'
import { fetchPostizChannels } from '@/lib/postiz'
import { createClient } from '@/lib/supabase/server'

// GET /api/postiz/channels — sync the user's workspace channels from Postiz.
// Returns { ok: true, channels: [...] } on success.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    const channels = await fetchPostizChannels()
    return NextResponse.json({ ok: true, channels })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
