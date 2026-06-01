// POST /api/upload-presign — issue a short-lived signed PUT URL to R2.
//
// Why this exists: /api/upload proxies the file through Vercel, but Vercel
// caps serverless request bodies at 4.5MB. Video uploads (editor exports
// 5-15MB, external videos up to 200MB) hit that wall. Presigned URLs let the
// browser PUT directly to R2 with no intermediate proxy — no size limit, no
// Vercel function bandwidth cost.
//
// Request:  JSON { folder?: string, name?: string, contentType?: string }
// Response: { ok: true, uploadUrl, publicUrl, key } or { ok: false, error }
//
// The path is server-scoped to the active workspace_id; clients can't write
// outside their workspace.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { presignPutR2 } from '@/lib/r2-client'

export const runtime = 'nodejs'

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  let body
  try { body = await req.json() }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }) }

  const folder = String(body.folder || 'refs').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'refs'
  const nameHint = String(body.name || 'upload.bin')
  const ext = (nameHint.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  const contentType = String(body.contentType || 'application/octet-stream').slice(0, 100)

  const rand = Math.random().toString(36).slice(2, 12)
  const key = `${folder}/${wsId}/${Date.now()}-${rand}.${ext}`

  try {
    const out = await presignPutR2(key, contentType, 300)
    return NextResponse.json({ ok: true, ...out })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || String(e) }, { status: 500 })
  }
}
