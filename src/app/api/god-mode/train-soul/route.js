// POST /api/god-mode/train-soul
//
// Trains a Flux LoRA on fal.ai using a persona's reference images. The trained
// LoRA weights URL gets stored on the persona row so subsequent image gens can
// opt-in by passing `loras: [{ path: persona.lora_url, scale: 1.0 }]` to a
// fal-ai/flux-lora endpoint.
//
// Why fal.ai LoRA training (not self-host):
//   - $2/training, 3-5 min — cheaper than renting GPU for one-off training
//   - Same provider as inference — no cross-vendor URL juggling
//   - Endpoint exists today: fal-ai/flux-lora-fast-training
//
// Body: { persona_id, image_urls: string[], trigger_word?: string }
// Returns: { ok, request_id } or { ok, lora_url } (if synchronous on fal side)

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/workspace'

export const runtime = 'nodejs'
export const maxDuration = 60

const FAL_TRAIN_MODEL = 'fal-ai/flux-lora-fast-training'

async function getFalKey(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspaces').select('fal_key').eq('id', workspaceId).maybeSingle()
  return data?.fal_key || process.env.FAL_KEY || ''
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  const { persona_id, image_urls, trigger_word } = body || {}

  if (!persona_id || !Array.isArray(image_urls) || image_urls.length < 4) {
    return NextResponse.json({ ok: false, error: 'persona_id + min 4 image_urls required' }, { status: 400 })
  }
  if (image_urls.length > 20) {
    return NextResponse.json({ ok: false, error: 'max 20 images per training' }, { status: 400 })
  }

  // Verify ownership + load workspace + persona. Workspace filter prevents
  // cross-tenant access — without it, any authed user could enqueue
  // training on another workspace's persona by guessing the persona_id.
  const wsId = await getActiveWorkspace(supabase, user)
  const { data: persona, error: pErr } = await supabase
    .from('personas')
    .select('id, name, username, workspace_id, lora_training_status')
    .eq('id', persona_id)
    .eq('workspace_id', wsId)
    .maybeSingle()
  if (pErr || !persona) return NextResponse.json({ ok: false, error: 'persona not found' }, { status: 404 })

  if (persona.lora_training_status === 'training') {
    return NextResponse.json({ ok: false, error: 'training already in progress for this persona' }, { status: 409 })
  }

  const falKey = await getFalKey(supabase, persona.workspace_id)
  if (!falKey) return NextResponse.json({ ok: false, error: 'no fal.ai key configured' }, { status: 500 })

  // Build a sensible default trigger word from username/name. The trigger
  // word is what the user writes in prompts to invoke the LoRA — e.g.
  // "tandy_moo in forest" makes the model render the trained persona.
  const safeTrigger = (trigger_word || persona.username || persona.name || `persona_${persona_id.slice(0, 8)}`)
    .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32)

  // Queue the training job on fal.ai. fal-ai/flux-lora-fast-training returns
  // a request_id; we poll separately via the status endpoint. Async pattern
  // because training takes 3-5 min — too long for a single HTTP request.
  const falRes = await fetch(`https://queue.fal.run/${FAL_TRAIN_MODEL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      images_data_url: image_urls,
      trigger_word: safeTrigger,
      // Default training params — balanced for character LoRAs. Steps=1000
      // is the fal.ai default for "fast" training. is_style=false because we
      // want character identity, not style transfer.
      is_style: false,
      iter_multiplier: 1.0,
      steps: 1000,
      create_masks: true,
    }),
  })
  const falData = await falRes.json().catch(() => ({}))
  if (!falRes.ok) {
    return NextResponse.json({
      ok: false,
      error: falData?.detail || falData?.error || `fal.ai ${falRes.status}`,
    }, { status: falRes.status })
  }

  const requestId = falData?.request_id || falData?.id
  if (!requestId) {
    return NextResponse.json({ ok: false, error: 'fal.ai did not return a request_id' }, { status: 500 })
  }

  // Persist the in-flight state. Status='training' so the dashboard widget
  // can show progress + the next POST will reject duplicate concurrent runs.
  await supabase
    .from('personas')
    .update({
      lora_training_status: 'training',
      lora_training_request_id: requestId,
      lora_trigger_word: safeTrigger,
    })
    .eq('id', persona_id)

  return NextResponse.json({ ok: true, request_id: requestId, trigger_word: safeTrigger })
}

// GET /api/god-mode/train-soul?persona_id=...
// Polls fal.ai for the training status and updates the persona row if done.
export async function GET(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const personaId = url.searchParams.get('persona_id')
  if (!personaId) return NextResponse.json({ ok: false, error: 'persona_id required' }, { status: 400 })

  // Scope by workspace to prevent cross-tenant persona access. The user
  // could otherwise pass any persona_id and get back its workspace's
  // training state.
  const wsId = await getActiveWorkspace(supabase, user)
  const { data: persona } = await supabase
    .from('personas')
    .select('id, workspace_id, lora_url, lora_training_status, lora_training_request_id, lora_trigger_word')
    .eq('id', personaId)
    .eq('workspace_id', wsId)
    .maybeSingle()
  if (!persona) return NextResponse.json({ ok: false, error: 'persona not found' }, { status: 404 })

  // Already done — short-circuit, no need to hit fal.
  if (persona.lora_training_status === 'done' && persona.lora_url) {
    return NextResponse.json({
      ok: true,
      status: 'done',
      lora_url: persona.lora_url,
      trigger_word: persona.lora_trigger_word,
    })
  }
  if (!persona.lora_training_request_id) {
    return NextResponse.json({ ok: true, status: persona.lora_training_status || 'idle' })
  }

  // Poll fal.ai for current status of the request.
  const falKey = await getFalKey(supabase, persona.workspace_id)
  if (!falKey) return NextResponse.json({ ok: false, error: 'no fal.ai key' }, { status: 500 })

  const statusRes = await fetch(
    `https://queue.fal.run/${FAL_TRAIN_MODEL}/requests/${persona.lora_training_request_id}/status`,
    { headers: { 'Authorization': `Key ${falKey}` } },
  )
  const statusData = await statusRes.json().catch(() => ({}))

  if (statusData?.status === 'COMPLETED') {
    // Fetch the result to get the diffusers_lora_file URL.
    const resultRes = await fetch(
      `https://queue.fal.run/${FAL_TRAIN_MODEL}/requests/${persona.lora_training_request_id}`,
      { headers: { 'Authorization': `Key ${falKey}` } },
    )
    const resultData = await resultRes.json().catch(() => ({}))
    const loraUrl = resultData?.diffusers_lora_file?.url
      || resultData?.weights?.url
      || resultData?.lora_url
      || null
    if (loraUrl) {
      await supabase
        .from('personas')
        .update({
          lora_url: loraUrl,
          lora_training_status: 'done',
          lora_trained_at: new Date().toISOString(),
        })
        .eq('id', personaId)
      return NextResponse.json({
        ok: true,
        status: 'done',
        lora_url: loraUrl,
        trigger_word: persona.lora_trigger_word,
      })
    }
    return NextResponse.json({ ok: false, error: 'training done but lora_url missing from response' }, { status: 500 })
  }

  if (statusData?.status === 'FAILED' || statusData?.status === 'CANCELLED') {
    await supabase
      .from('personas')
      .update({ lora_training_status: 'failed' })
      .eq('id', personaId)
    return NextResponse.json({ ok: true, status: 'failed', error: statusData?.error || 'training failed' })
  }

  // Still running. fal.ai status: IN_QUEUE, IN_PROGRESS
  return NextResponse.json({
    ok: true,
    status: 'training',
    fal_status: statusData?.status || 'unknown',
    queue_position: statusData?.queue_position,
  })
}
