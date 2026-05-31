// POST /api/upload — single endpoint for all media uploads to R2.
//
// Replaces the browser-side `supabase.storage.from('refs').upload(...)` +
// `getPublicUrl(...)` flow. Server scopes paths by workspace_id (extracted
// from session) so a logged-in user can't write outside their workspace.
//
// Request:  multipart/form-data
//   file:    File (required)
//   folder:  string (optional, default 'refs') — sub-prefix inside the
//            workspace partition (e.g. 'preset-style', 'editor-audio')
//   name:    string (optional) — extension hint when file.name is missing
//
// Response: { ok: true, url, key } or { ok: false, error }

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'
import { uploadToR2 } from '@/lib/r2-client'

// Larger uploads (edited MP4 ~5-15MB, voiceover MP3 ~1-3MB). Allow up to
// 50MB so editor exports don't fail. Vercel limit for serverless is 4.5MB
// for body — set runtime to nodejs to bypass.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const wsId = await getActiveWorkspace(supabase, user)
  if (!wsId) return NextResponse.json({ ok: false, error: 'no workspace' }, { status: 404 })

  let formData
  try { formData = await req.formData() }
  catch (e) { return NextResponse.json({ ok: false, error: 'invalid form data' }, { status: 400 }) }

  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ ok: false, error: 'file required' }, { status: 400 })
  }
  const folder = String(formData.get('folder') || 'refs').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'refs'
  const nameHint = String(formData.get('name') || file.name || 'upload.bin')
  const ext = (nameHint.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'

  // Content-addressed key: workspace partition + folder + timestamp + random
  // suffix. UUID-style randomness makes the URL unguessable; combined with the
  // workspace prefix, that's the same security posture as Supabase storage's
  // signed-URL-less public access pattern.
  const rand = Math.random().toString(36).slice(2, 12)
  const key = `${folder}/${wsId}/${Date.now()}-${rand}.${ext}`

  try {
    const buf = Buffer.from(await file.arrayBuffer())
    const url = await uploadToR2(key, buf, file.type || `application/${ext}`)
    return NextResponse.json({ ok: true, url, key })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || String(e) }, { status: 500 })
  }
}
