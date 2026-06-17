import { NextResponse } from 'next/server'
import { falStatus } from '@/lib/fal-server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const model = searchParams.get('model')
  const request_id = searchParams.get('request_id')
  if (!model || !request_id) return NextResponse.json({ ok: false, error: 'model+request_id required' }, { status: 400 })
  // Scope to caller's workspace — block polling another tenant's job/media.
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })
  const { data: job } = await supabase
    .from('gen_jobs')
    .select('workspace_id')
    .eq('request_id', request_id)
    .eq('workspace_id', wsId)
    .maybeSingle()
  if (!job) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
  try {
    const result = await falStatus(model, request_id)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
