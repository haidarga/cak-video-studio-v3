// POST /api/external/ingest — accept naskah payloads from Caketing (or other sources).
//
// Auth: Bearer API key (validated via external-auth.js, workspace-scoped).
// This is the "tunnel" endpoint — Caketing pushes approved naskah here.
//
// Body: { naskah: [{ source_ref, title, naskah_text, parsed_shots, persona_mapping, ... }] }
// Response: { ok, jobs: [{ studio_job_id, title, status }] }

import { NextResponse } from 'next/server'
import { validateExternalApiKey, hasPermission } from '@/lib/external-auth'
import { createAdminClient } from '@/lib/supabase/admin'

const MAX_NASKAH_PER_REQUEST = 100
const MAX_NASKAH_TEXT_LEN = 10000
const MAX_TITLE_LEN = 200

export async function POST(req) {
  // 1. Validate API key
  const auth = await validateExternalApiKey(req)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  }
  if (!hasPermission(auth, 'ingest')) {
    return NextResponse.json({ ok: false, error: 'API key lacks ingest permission' }, { status: 403 })
  }

  // 2. Parse + validate body
  let body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { naskah } = body
  if (!Array.isArray(naskah) || naskah.length === 0) {
    return NextResponse.json({ ok: false, error: 'naskah array is required and must not be empty' }, { status: 400 })
  }
  if (naskah.length > MAX_NASKAH_PER_REQUEST) {
    return NextResponse.json({ ok: false, error: `Max ${MAX_NASKAH_PER_REQUEST} naskah per request` }, { status: 400 })
  }

  const admin = createAdminClient()
  const wsId = auth.workspaceId

  // 3. Resolve persona mappings (auto-match by name)
  // Fetch all personas in the workspace for matching
  const { data: studioPersonas } = await admin
    .from('personas')
    .select('id, name, brand_id')
    .eq('workspace_id', wsId)

  const personasByName = new Map(
    (studioPersonas || []).map(p => [p.name.toLowerCase().trim(), p])
  )

  // 4. Resolve brands by name
  const { data: studioBrands } = await admin
    .from('brands')
    .select('id, name')
    .eq('workspace_id', wsId)

  const brandsByName = new Map(
    (studioBrands || []).map(b => [b.name.toLowerCase().trim(), b])
  )

  // 5. Build studio_jobs rows
  const jobRows = []
  const validationErrors = []

  for (let i = 0; i < naskah.length; i++) {
    const item = naskah[i]

    // Validate required fields
    if (!item.title?.trim()) {
      validationErrors.push({ index: i, error: 'title is required' })
      continue
    }
    if (!item.naskah_text?.trim()) {
      validationErrors.push({ index: i, error: 'naskah_text is required' })
      continue
    }

    const title = String(item.title).slice(0, MAX_TITLE_LEN)
    const naskahText = String(item.naskah_text).slice(0, MAX_NASKAH_TEXT_LEN)

    // Auto-match persona by name
    const sourcePersonaName = item.persona_mapping?.persona_name
      || item.persona_mapping?.source_persona_name
      || ''
    const matched = sourcePersonaName
      ? personasByName.get(sourcePersonaName.toLowerCase().trim())
      : null

    const personaMapping = {
      source_persona_id: item.persona_mapping?.source_persona_id || null,
      source_persona_name: sourcePersonaName,
      studio_persona_id: matched?.id || null,
      match_type: matched ? 'auto' : 'unmapped',
    }

    // Auto-match brand by name
    const brandName = item.brand_name || ''
    const matchedBrand = brandName
      ? brandsByName.get(brandName.toLowerCase().trim())
      : null

    jobRows.push({
      workspace_id: wsId,
      source: item.source || 'caketing',
      source_ref: item.source_ref || {},
      title,
      naskah_text: naskahText,
      parsed_shots: item.parsed_shots || null,
      persona_mapping: personaMapping,
      brand_id: matchedBrand?.id || null,
      brand_name: brandName || null,
      brief_context: item.brief_context || {},
      format_meta: item.format_meta || {},
      status: 'pending',
      created_by: null, // external push — no auth.users row
    })
  }

  if (jobRows.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'No valid naskah items',
      validation_errors: validationErrors,
    }, { status: 400 })
  }

  // 6. Insert studio_jobs
  const { data: insertedJobs, error: insertErr } = await admin
    .from('studio_jobs')
    .insert(jobRows)
    .select('id, title, status, persona_mapping, brand_name')

  if (insertErr) {
    return NextResponse.json({
      ok: false,
      error: `Failed to create studio jobs: ${insertErr.message}`,
    }, { status: 500 })
  }

  // 7. Return job IDs (Caketing stores these for status tracking)
  return NextResponse.json({
    ok: true,
    jobs: insertedJobs.map(j => ({
      studio_job_id: j.id,
      title: j.title,
      status: j.status,
      persona_matched: j.persona_mapping?.match_type === 'auto',
      persona_studio: j.persona_mapping?.studio_persona_id || null,
      brand: j.brand_name,
    })),
    validation_errors: validationErrors.length > 0 ? validationErrors : undefined,
  })
}
