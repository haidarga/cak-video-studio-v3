// POST /api/god-mode/agent
//
// Conversational agent for the GOD MODE chatroom. Self-contained — handles
// the full flow from intent → tool selection → tool execution → structured
// response. Generation tools (gen_image, gen_video) call fal.ai directly
// and return inline media; the chat UI renders results without routing to
// /generate.
//
// Tool registry pattern: each tool has description (informs Gemini's
// selection) + handler (executes side effect). Adding new capability =
// append to TOOLS. Result types flow through to the UI which has matching
// renderer branches.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLMJSON, callLLM } from '@/lib/llm-server'
import { CINEMATIC_PRESETS, CINEMATIC_CATEGORIES, getPresetById } from '@/lib/cinematic-presets'
import { IMAGE_MODELS, VIDEO_MODELS } from '@/lib/fal-client'
import { canonicalFalPath, candidateFalPaths } from '@/lib/fal-paths'

export const runtime = 'nodejs'
export const maxDuration = 120

// ── Helpers ──────────────────────────────────────────────────────────

async function getFalKey(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspaces').select('fal_key').eq('id', workspaceId).maybeSingle()
  return data?.fal_key || process.env.FAL_KEY || ''
}

// Build a video gen input shape per-model. Each fal.ai video model has its
// own field names — Kling v3 standard wants `start_image_url`, Seedance
// wants `image_urls` array, Grok wants `reference_image_urls`, etc. Failing
// to send the right key returns a 422 "Field required" client error.
function buildVideoInputForModel(model, { motion_prompt, image_url, image_urls, duration, aspect_ratio, resolution }) {
  const dur = String(Math.max(3, Math.min(15, parseInt(duration) || 5)))
  const ar = aspect_ratio || '9:16'

  // Variant detection driven by MODEL URL, not by which inputs we have.
  // Previously: `if (image_url)` would route a ref-to-video model into the
  // i2v shape because we'd auto-promoted chat attachment as image_url. That
  // sent `image_url` to a ref-to-video endpoint, which 422s on missing
  // `reference_image_urls`. Fix: variant decides shape; inputs feed into
  // whichever fields that variant expects.
  const isI2V = model.includes('image-to-video')
  const isR2V = model.includes('reference-to-video')
  const isT2V = model.includes('text-to-video')

  // Build a unified refs array — if explicit image_urls passed, use those,
  // else fall back to single image_url as a 1-element array.
  const refsArr = (image_urls && image_urls.length > 0)
    ? image_urls.filter(Boolean)
    : (image_url ? [image_url] : [])

  if (model.includes('kling-video')) {
    if (isI2V) {
      return { prompt: motion_prompt, start_image_url: image_url || refsArr[0], duration: dur, aspect_ratio: ar }
    }
    if (isR2V) {
      const elements = refsArr.slice(0, 4).map((u) => ({ frontal_image_url: u }))
      return { prompt: motion_prompt, ...(elements.length ? { elements } : {}), duration: dur, aspect_ratio: ar }
    }
    return { prompt: motion_prompt, duration: dur, aspect_ratio: ar }
  }

  if (model.includes('seedance')) {
    const okAR = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
    const finalAR = okAR.includes(ar) ? ar : 'auto'
    if (isI2V) {
      return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: dur, resolution: resolution || '720p', aspect_ratio: finalAR }
    }
    if (isR2V) {
      return { prompt: motion_prompt, image_urls: refsArr.slice(0, 9), duration: dur, resolution: resolution || '720p', aspect_ratio: finalAR }
    }
    return { prompt: motion_prompt, duration: dur, resolution: resolution || '720p', aspect_ratio: finalAR }
  }

  if (model.includes('happy-horse')) {
    if (isI2V) {
      return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar, resolution: '720p' }
    }
    if (isR2V) {
      return { prompt: motion_prompt, image_urls: refsArr.slice(0, 9), duration: parseInt(dur), aspect_ratio: ar, resolution: '720p' }
    }
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar, resolution: '720p' }
  }

  if (model.includes('grok-imagine')) {
    if (isI2V) {
      return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar }
    }
    if (isR2V) {
      // Field name `reference_image_urls` (NOT image_urls) — fal returned 422
      // "reference_image_urls: Field required" when we sent image_urls.
      return { prompt: motion_prompt, reference_image_urls: refsArr.slice(0, 6), duration: parseInt(dur), aspect_ratio: ar }
    }
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar }
  }

  if (model.includes('veo3')) {
    return { prompt: motion_prompt, ...(image_url ? { image_url } : {}), duration: parseInt(dur), aspect_ratio: ar }
  }

  // Generic fallback — pick shape by variant if detectable, else send both.
  if (isI2V) {
    return { prompt: motion_prompt, image_url: image_url || refsArr[0], duration: parseInt(dur), aspect_ratio: ar }
  }
  if (isR2V) {
    return { prompt: motion_prompt, image_urls: refsArr.slice(0, 6), duration: parseInt(dur), aspect_ratio: ar }
  }
  if (isT2V) {
    return { prompt: motion_prompt, duration: parseInt(dur), aspect_ratio: ar }
  }
  return {
    prompt: motion_prompt,
    ...(image_url ? { image_url, start_image_url: image_url } : {}),
    ...(image_urls?.length ? { image_urls: image_urls.slice(0, 6) } : {}),
    duration: parseInt(dur),
    aspect_ratio: ar,
  }
}

// Build image gen input per-model.
function buildImageInputForModel(model, { prompt, refs, ar, quality }) {
  const refList = (refs || []).filter(Boolean).slice(0, 8)

  if (model.includes('nano-banana')) {
    const isEdit = model.includes('edit')
    // text-to-image variant doesn't accept image_urls; only edit variant uses it.
    return {
      prompt,
      ...(isEdit ? { image_urls: refList } : {}),
      output_format: 'jpeg',
    }
  }

  if (model.includes('gpt-image')) {
    // /edit takes image_urls (required, min 1). /generation = pure t2i, no image_urls.
    const isEdit = model.includes('edit')
    if (isEdit && refList.length === 0) {
      throw new Error('GPT Image 2 Edit mode butuh minimal 1 source image. Upload gambar ke chat dulu.')
    }
    return {
      prompt,
      ...(isEdit ? { image_urls: refList } : {}),
      quality: quality === '1080p' ? 'high' : 'medium',
      aspect_ratio: ar || '1:1',
    }
  }

  if (model.includes('grok-imagine')) {
    return { prompt, image_urls: refList, aspect_ratio: ar || '1:1' }
  }

  if (model.includes('flux-lora')) {
    const arMap = { '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '1:1': 'square_hd', '4:5': 'portrait_4_3', '3:4': 'portrait_4_3' }
    return {
      prompt,
      loras: [], // caller must inject if available
      image_size: arMap[ar] || 'square_hd',
    }
  }

  // Generic fallback — refList as image_urls.
  return { prompt, image_urls: refList }
}

// Call a fal.ai sync endpoint. Returns the result JSON.
async function falCall(model, input, falKey) {
  // Use queue endpoint for long-running gens; this helper waits inline. For
  // gen_video which takes 1-3 min, prefer the queue + poll pattern via the
  // existing falRun helper from src/lib/fal-client.js. Keeping this lightweight
  // here for image gen which is usually <30s.
  const wireModel = canonicalFalPath(model)
  const res = await fetch(`https://fal.run/${wireModel}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.detail || data?.error || `fal.ai ${res.status}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return data
}

// Fetch arbitrary URL and return a trimmed HTML string we can feed to
// Gemini for product extraction. Strips <script>/<style> to save tokens.
async function fetchUrlAsHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 CAK-Video-GodMode/1.0' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status}`)
  let html = await res.text()
  // Tight clean: drop scripts/styles + noscript, then collapse whitespace.
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Cap HTML length sent to LLM — most product pages have what we need in
  // the first 30k chars (meta tags + visible content).
  return html.slice(0, 30000)
}

// ── TOOL REGISTRY ────────────────────────────────────────────────────

const TOOLS = {
  // ─ Cinematic preset tools ────────────────────────────────────────
  suggest_cinematic_preset: {
    description: 'When user describes camera move / motion / cinematic look (e.g. "bullet time", "dolly in", "product spin"), find closest matching presets and return them. Use when the user mentions camera/motion/cinematic vocabulary.',
    handler: async ({ user_intent }) => {
      const intent = String(user_intent || '').toLowerCase()
      const ranked = CINEMATIC_PRESETS.map((p) => {
        let score = 0
        const hay = `${p.label} ${p.desc} ${p.prompt}`.toLowerCase()
        for (const word of intent.split(/\s+/).filter((w) => w.length > 2)) {
          if (hay.includes(word)) score += 1
        }
        return { preset: p, score }
      }).sort((a, b) => b.score - a.score).slice(0, 3)
      return { type: 'cinematic_preset_suggestions', intent: user_intent, suggestions: ranked.map((r) => r.preset) }
    },
  },
  list_cinematic_presets: {
    description: 'List the full cinematic preset library, grouped by category. Use when user asks to browse all available motion presets or "what presets do you have".',
    handler: async () => {
      const groups = {}
      for (const c of CINEMATIC_CATEGORIES) groups[c.id] = { ...c, presets: [] }
      for (const p of CINEMATIC_PRESETS) groups[p.category]?.presets.push(p)
      return { type: 'cinematic_preset_library', categories: Object.values(groups) }
    },
  },

  // ─ Workspace browsing ────────────────────────────────────────────
  list_personas: {
    description: 'List personas available in the current workspace + active brand. Use when user mentions picking a character, "who can I use", or composing a scene.',
    handler: async (_, ctx) => {
      const q = ctx.supabase
        .from('personas')
        .select('id, name, username, avatar_url, brand_id, lora_url, lora_trigger_word')
        .eq('workspace_id', ctx.workspaceId)
      if (ctx.activeBrandId) q.eq('brand_id', ctx.activeBrandId)
      const { data } = await q.order('created_at', { ascending: false }).limit(40)
      return { type: 'persona_list', personas: data || [] }
    },
  },
  list_product_refs: {
    description: 'List product refs (uploaded product images with knowledge sheets) in the workspace. Use when user wants to pick a product or asks "what products do I have".',
    handler: async (_, ctx) => {
      const { data } = await ctx.supabase
        .from('refs').select('id, label, fal_url, knowledge')
        .eq('workspace_id', ctx.workspaceId).eq('kind', 'product')
        .order('created_at', { ascending: false }).limit(40)
      return { type: 'product_ref_list', products: data || [] }
    },
  },

  // ─ Generation tools ──────────────────────────────────────────────
  gen_image: {
    description: 'Generate ONE image (NOT video) from a text prompt. Trigger phrases: "bikin foto/gambar", "buat image", "generate foto", "render gambar", "kasih foto", "potret", "hasilin gambar", "bikin poster", "edit gambar diatas". Use this when user explicitly wants an IMAGE not video. **CRITICAL**: if user uploaded image(s) to chat AND asks to edit/use them ("dari gambar diatas", "dari gambar yang gua upload"), those attachments AUTO-include as source refs — DO NOT tell user to pin anything. Pass visual prompt. Optional: model, ar override. Refs auto-stack: chat attachments + pinned persona refs + pinned product.',
    handler: async ({ prompt, ar, model: modelOverride }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      // Resolve config defaults from active context, with per-call overrides.
      const cfg = ctx.activeConfig || {}
      const finalAr = ar || cfg.ar || 'auto'

      // Build ref_image_urls stack — IMPORTANT priority order:
      //   1. Recent chat attachments (user uploaded image to chat) — primary
      //      source for "edit gambar yang gua upload" / "dari gambar diatas"
      //   2. Pinned persona refs
      //   3. Pinned product ref
      const refUrls = []
      for (const att of ctx.recentAttachments || []) {
        if (att.type === 'image' && att.url) refUrls.push(att.url)
      }
      if (ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)

      // Model selection priority:
      //   1. Explicit override from agent ("pake gpt-image-2")
      //   2. Soul LoRA if persona has one trained
      //   3. User's picked image_model from config bar
      let model = modelOverride || ''
      let finalPrompt = String(prompt || '').trim()

      // Prompt fallback — Gemini sometimes drops the prompt field empty
      // when it embeds the description in `text` only. Fall back to the
      // user's raw last-message text so fal doesn't 422 on min_length.
      if (finalPrompt.length < 3 && ctx.lastUserText) finalPrompt = ctx.lastUserText
      if (finalPrompt.length < 3) {
        return { type: 'error', error: 'Prompt kosong. Coba: "bikin foto X di lokasi Y, style Z".' }
      }

      if (!model && ctx.activePersona?.lora_url && ctx.activePersona?.lora_trigger_word) {
        model = 'fal-ai/flux-lora'
        finalPrompt = `${ctx.activePersona.lora_trigger_word}, ${finalPrompt}`
      }
      if (!model) model = cfg.image_model || 'fal-ai/nano-banana/edit'

      // Auto-switch /edit variants to their text-to-image counterpart when
      // no source images are available. User asked "bikin foto X" without
      // uploading or pinning — they want pure generation, not edit.
      if (refUrls.length === 0) {
        if (model === 'fal-ai/nano-banana/edit') model = 'fal-ai/nano-banana'
        if (model === 'openai/gpt-image-2/edit') model = 'openai/gpt-image-2'
        if (model.endsWith('/edit')) model = model.replace(/\/edit$/, '')
      }

      // Build input per-model via centralized helper. Each fal.ai model
      // has different field expectations — this fails gracefully with a
      // user-readable error if e.g. user picks GPT Image 2 Edit mode
      // without pinning any source images.
      let input
      try {
        input = buildImageInputForModel(model, {
          prompt: finalPrompt,
          refs: refUrls,
          ar: finalAr,
          quality: cfg.resolution,
        })
        // Inject LoRA path into flux-lora model after generic build.
        if (model.includes('flux-lora') && ctx.activePersona?.lora_url) {
          input.loras = [{ path: ctx.activePersona.lora_url, scale: 1.0 }]
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }

      try {
        const data = await falCall(model, input, falKey)
        const url = data?.images?.[0]?.url || data?.image?.url || data?.url
        if (!url) return { type: 'error', error: 'no image url in fal response' }

        const { data: row } = await ctx.supabase.from('results').insert({
          workspace_id: ctx.workspaceId,
          persona_id: ctx.activePersona?.id || null,
          type: 'image', url, label: `God Mode — image`,
          ar: finalAr,
          meta: { source: 'god-mode', prompt: finalPrompt, model, refs: refUrls },
          created_by: ctx.userId,
        }).select('id').single()

        return {
          type: 'gen_image_result',
          url, model, ar: finalAr, result_id: row?.id, prompt: finalPrompt,
          // Re-gen payload — frontend uses this to fire identical re-gen call
          regen_payload: { prompt, ar, model: modelOverride },
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  gen_video: {
    description: 'Generate a video. Pass motion_prompt (what happens, camera moves). Optional: duration (3-15s), image_url for image-to-video, ar (override), model (override config). If active persona/product, refs auto-attach. If active preset, its motion prompt appended.',
    handler: async ({ motion_prompt, duration, image_url, ar, model: modelOverride }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      // Resolve config defaults with per-call overrides.
      const cfg = ctx.activeConfig || {}
      const finalAr = ar || cfg.ar || '9:16'
      const dur = Math.max(3, Math.min(15, parseInt(duration) || parseInt(cfg.duration) || 5))
      const audioOn = cfg.audio !== false

      // Compose final motion prompt with active preset appended.
      let finalMotion = String(motion_prompt || '').trim()
      // Prompt fallback — Gemini sometimes drops motion_prompt empty when it
      // puts the description only in `text`. Use the user's raw last message
      // so fal doesn't 422 on min_length.
      if (finalMotion.length < 3 && ctx.lastUserText) finalMotion = ctx.lastUserText
      if (finalMotion.length < 3) {
        return { type: 'error', error: 'Motion prompt kosong. Coba: "video X detik tema Y dengan camera Z".' }
      }
      if (ctx.activePreset?.prompt) {
        finalMotion += `\n\n[Cinematic preset: ${ctx.activePreset.label}] ${ctx.activePreset.prompt}`
      }
      if (!audioOn) finalMotion += '\n\nNO dialogue, NO speech, silent ambient only.'

      // Build refs from active context. PRIORITY ORDER:
      //   1. Chat attachments (images user uploaded in this turn — primary
      //      source when user says "gambar 2 dan produk di gambar 3")
      //   2. Pinned persona refs
      //   3. Pinned product ref
      // This mirrors gen_image's behavior; without this, ref-to-video models
      // (Grok, Seedance r2v, Kling r2v) 422 on empty reference_image_urls
      // even when the user clearly uploaded ref images.
      const refUrls = []
      for (const att of ctx.recentAttachments || []) {
        if (att.type === 'image' && att.url) refUrls.push(att.url)
      }
      if (ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)

      // Auto-promote source image_url: explicit > recent chat attachment > refs[0].
      // This is what fixes the "start_image_url Field required" 422 — when user
      // uploaded image to chat but agent didn't echo it back as image_url.
      let finalImageUrl = image_url
      if (!finalImageUrl) {
        const attImg = (ctx.recentAttachments || []).find((a) => a.type === 'image' && a.url)
        if (attImg) finalImageUrl = attImg.url
      }

      // Model selection: explicit override > config > smart default by mode.
      let model = modelOverride
      if (!model) {
        if (finalImageUrl) {
          // Image-to-video — pick i2v variant of the configured family if possible
          const i2vMap = {
            'bytedance/seedance-2.0/fast/reference-to-video': 'bytedance/seedance-2.0/fast/image-to-video',
            'fal-ai/kling-video/v3/reference-to-video': 'fal-ai/kling-video/v3/image-to-video',
            'alibaba/happy-horse/reference-to-video': 'alibaba/happy-horse/image-to-video',
            'xai/grok-imagine-video/reference-to-video': 'xai/grok-imagine-video/image-to-video',
          }
          model = i2vMap[cfg.video_model] || 'fal-ai/kling-video/v3/image-to-video'
        } else {
          model = cfg.video_model || 'bytedance/seedance-2.0/fast/reference-to-video'
        }
      }

      // If model is an i2v variant but we still have no source image, fall back
      // to refs[0] as start frame, else auto-switch to ref-to-video (or text-to-video).
      if (model.includes('image-to-video') && !finalImageUrl) {
        if (refUrls.length > 0) {
          finalImageUrl = refUrls[0]
        } else {
          // Switch to ref-to-video variant; if no refs either, switch to text-to-video.
          const r2vMap = {
            'fal-ai/kling-video/v3/image-to-video': 'fal-ai/kling-video/v3/reference-to-video',
            'fal-ai/kling-video/v3/standard/image-to-video': 'fal-ai/kling-video/v3/reference-to-video',
            'fal-ai/kling-video/v3/pro/image-to-video': 'fal-ai/kling-video/v3/reference-to-video',
            'bytedance/seedance-2.0/fast/image-to-video': 'bytedance/seedance-2.0/fast/reference-to-video',
            'alibaba/happy-horse/image-to-video': 'alibaba/happy-horse/reference-to-video',
            'xai/grok-imagine-video/image-to-video': 'xai/grok-imagine-video/reference-to-video',
          }
          model = r2vMap[model] || model.replace('/image-to-video', '/text-to-video')
        }
      }

      // Build input via centralized per-model helper. Handles Kling's
      // start_image_url, Seedance's image_urls array, Grok's
      // reference_image_urls, etc. — all the field-name variants that
      // caused 422 errors before.
      const input = buildVideoInputForModel(model, {
        motion_prompt: finalMotion,
        image_url: finalImageUrl,
        image_urls: refUrls,
        duration: dur,
        aspect_ratio: finalAr,
        resolution: cfg.resolution,
      })

      try {
        // Canonicalize model path before ANY queue.fal.run call. fal
        // accepts vendor aliases at submit (`bytedance/seedance-2.0/...`)
        // but anchors request_ids on canonical paths (`fal-ai/seedance-2/
        // ...`). Polling status on the alias returns empty forever. See
        // src/lib/fal-paths.js.
        const wireModel = canonicalFalPath(model)

        // Submit to fal.ai queue. Return request_id immediately so the agent
        // route doesn't hold the Vercel function open past the 60s limit
        // (Hobby tier). Frontend polls via /api/god-mode/gen-status?
        // request_id=...&model=... when ready.
        //
        // Earlier version polled inline up to 100s, which killed the Vercel
        // function and returned HTML to the frontend (user saw "Unexpected
        // token 'A'... is not valid JSON" error). Async pattern fixes this.
        const submitRes = await fetch(`https://queue.fal.run/${wireModel}`, {
          method: 'POST',
          headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        const submitData = await submitRes.json().catch(() => ({}))
        if (!submitRes.ok) throw new Error(submitData?.detail || submitData?.error || `fal.ai ${submitRes.status}`)
        const requestId = submitData?.request_id
        if (!requestId) throw new Error('no request_id from fal')
        // fal's submit response includes status_url + response_url that
        // point to the CANONICAL polling URLs — capture them so the
        // poller doesn't have to guess any model paths.
        const statusUrl = submitData?.status_url
        const responseUrl = submitData?.response_url

        // Short inline poll — 30s max — to catch fast gens (some videos
        // <5s finish quickly). If not done by then, return queued state
        // and let frontend poll separately.
        let done = null
        const start = Date.now()
        while (Date.now() - start < 30000) {
          await new Promise((r) => setTimeout(r, 4000))
          // Use fal-provided URLs when available; fall back to constructed.
          const stUrl = statusUrl || `https://queue.fal.run/${wireModel}/requests/${requestId}/status`
          const stRes = await fetch(stUrl, { headers: { 'Authorization': `Key ${falKey}` } })
          const st = await stRes.json().catch(() => ({}))
          if (st?.status === 'COMPLETED') {
            const rUrl = responseUrl || `https://queue.fal.run/${wireModel}/requests/${requestId}`
            const fullRes = await fetch(rUrl, { headers: { 'Authorization': `Key ${falKey}` } })
            done = await fullRes.json().catch(() => ({}))
            break
          }
          if (st?.status === 'FAILED') throw new Error(st?.error || 'fal gen failed')
        }

        if (done) {
          const url = done?.video?.url || done?.url
          if (!url) return { type: 'error', error: 'no video url in fal response' }

          const { data: row } = await ctx.supabase.from('results').insert({
            workspace_id: ctx.workspaceId,
            persona_id: ctx.activePersona?.id || null,
            type: 'video', url, label: `God Mode — video`,
            ar: finalAr,
            meta: { source: 'god-mode', motion: finalMotion, model: wireModel, image_url: finalImageUrl, refs: refUrls },
            created_by: ctx.userId,
          }).select('id').single()

          return {
            type: 'gen_video_result',
            url, model: wireModel, ar: finalAr, duration: dur, result_id: row?.id, motion: finalMotion,
            audio: audioOn,
            regen_payload: { motion_prompt, duration, image_url, ar, model: modelOverride },
          }
        }

        // Not done within 30s — return queued state so the UI can poll the
        // gen-status endpoint. Includes everything needed to resume on
        // success: request_id + model + the metadata to save when result
        // is fetched (motion, ar, image_url, refs, persona_id).
        // status_url + response_url are the authoritative polling URLs
        // fal handed us — no path-guessing needed when these are present.
        return {
          type: 'gen_video_queued',
          request_id: requestId,
          model: wireModel,
          status_url: statusUrl,
          response_url: responseUrl,
          ar: finalAr,
          duration: dur,
          motion: finalMotion,
          image_url: image_url || null,
          refs: refUrls,
          persona_id: ctx.activePersona?.id || null,
          regen_payload: { motion_prompt, duration, image_url, ar, model: modelOverride },
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ URL → Marketing proposal (preview only, no gen) ───────────────
  scrape_url_for_marketing: {
    description: 'PREVIEW ONLY mode. Given a product URL, scrape + propose naskah but DO NOT gen video yet. Use this only when user explicitly says "preview saja", "kasih ide naskah", "check produknya dulu". If user asks to BUILD/MAKE/BIKIN a video with duration/theme/model specified, use gen_marketing_video_from_url instead.',
    handler: async ({ url, duration = 25, theme = '' }, ctx) => {
      if (!url || !/^https?:\/\//i.test(url)) return { type: 'error', error: 'valid URL required' }
      try {
        const html = await fetchUrlAsHtml(url)
        const shotCount = Math.max(3, Math.min(6, Math.ceil(duration / 5)))
        const extractPrompt = `You are scraping a product page to propose a marketing video naskah. Extract product info + write naskah at the user's requested duration + theme.

URL: ${url}
Requested duration: ${duration} seconds
Theme/vibe: ${theme || 'modern UGC, authentic, scroll-stopping'}
Shot count: ${shotCount} shots

HTML (cleaned):
${html.slice(0, 25000)}

Return JSON only:
{
  "title": "product name",
  "price": "Rp ... or empty",
  "description": "1-2 sentence product summary",
  "image": "best product image URL from page or empty",
  "naskah": "${shotCount}-shot naskah in Indonesian, ${duration}s total. Format:\n[0:00-0:0X] Shot 1: visual + dialog\n[0:0X-0:XX] Shot 2: ..."
}

Match the theme vibe in the naskah tone. Keep timestamps consistent with ${duration}s total.`

        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
          temperature: 0.5,
          maxOutputTokens: 4000,
        })
        const p = result.parsed || {}
        return {
          type: 'url_marketing_proposal',
          url,
          title: p.title || '',
          price: p.price || '',
          description: p.description || '',
          image: p.image || '',
          naskah: p.naskah || '',
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ URL → Image (scrape + gen single image) ──────────────────────
  gen_image_from_url: {
    description: 'Generate a SINGLE marketing IMAGE from a product URL. Scrapes product, gens styled image using the product photo as reference. Use when user pastes URL + asks for IMAGE: "bikin foto dari URL", "listing photo dari link", "image saja jangan video". URL fallback: if user references "link itu" without re-pasting, auto-resolves from recent messages. **IMPORTANT**: if user already uploaded an image to chat instead of URL, use gen_image (not this) — gen_image picks up chat attachments automatically.',
    handler: async ({ url, theme, ar, model: modelOverride }, ctx) => {
      if (!url && Array.isArray(ctx.recentUrls) && ctx.recentUrls.length > 0) {
        url = ctx.recentUrls[0]
      }
      if (!url || !/^https?:\/\//i.test(url)) return { type: 'error', error: 'valid URL required — gua gak nemu URL. Coba paste URL produknya, atau upload image langsung ke chat dan minta "bikin gambar dari foto diatas".' }
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      const cfg = ctx.activeConfig || {}
      const finalAr = ar || cfg.ar || '1:1'
      const finalTheme = theme || 'clean studio product photography'

      try {
        const html = await fetchUrlAsHtml(url)
        const extractPrompt = `Extract product info from this HTML for a marketing image. Return JSON only:
{
  "title": "product name",
  "image_url": "best primary product image URL (absolute)",
  "image_prompt": "detailed visual prompt in English for a marketing/listing photo of the product, matching theme '${finalTheme}'. Describe composition, lighting, mood, props. 2-3 sentences."
}

URL: ${url}
HTML: ${html.slice(0, 22000)}`

        const extracted = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
          temperature: 0.6,
          maxOutputTokens: 3000,
        })
        const p = extracted.parsed || {}
        if (!p.image_url || !p.image_prompt) {
          return { type: 'error', error: 'gagal extract product dari URL — pastikan URL punya product photo yang jelas' }
        }

        const imageModel = modelOverride || cfg.image_model || 'fal-ai/nano-banana/edit'

        // Use centralized helper — handles field names per model family,
        // throws readable error if model needs source image and we don't
        // have one (shouldn't happen here since we always have p.image_url).
        let input
        try {
          input = buildImageInputForModel(imageModel, {
            prompt: p.image_prompt,
            refs: [p.image_url],
            ar: finalAr,
            quality: cfg.resolution,
          })
        } catch (e) {
          return { type: 'error', error: e.message }
        }

        const data = await falCall(imageModel, input, falKey)
        const imageUrl = data?.images?.[0]?.url || data?.image?.url
        if (!imageUrl) return { type: 'error', error: 'no image url in fal response' }

        const { data: row } = await ctx.supabase.from('results').insert({
          workspace_id: ctx.workspaceId,
          type: 'image', url: imageUrl,
          label: `God Mode — ${p.title || 'marketing image'}`,
          ar: finalAr,
          meta: { source: 'god-mode', source_url: url, prompt: p.image_prompt, model: imageModel, theme: finalTheme, product_image: p.image_url },
          created_by: ctx.userId,
        }).select('id').single()

        return {
          type: 'gen_image_result',
          url: imageUrl, model: imageModel, ar: finalAr,
          result_id: row?.id, prompt: p.image_prompt,
          regen_payload: { url, theme: finalTheme, model: modelOverride, ar: finalAr },
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ URL → Marketing Video (scrape + gen video in one shot) ────────
  gen_marketing_video_from_url: {
    description: 'PRIMARY TOOL when user pastes a product URL AND asks for VIDEO with specific params (duration / theme / model / etc). Scrapes URL, extracts product, composes motion_prompt with theme, gens video at requested duration with requested model. Returns the video directly. Use this when user says e.g. "bikin video X detik dari URL ini, tema Y, pake model Z". If user references "link itu" / "URL diatas" / "dari link tadi" without pasting again, the URL auto-resolves from earlier messages in the conversation.',
    handler: async ({ url, duration, theme, model: modelOverride, ar }, ctx) => {
      // Fallback: if no URL passed, use most recent URL from conversation.
      if (!url && Array.isArray(ctx.recentUrls) && ctx.recentUrls.length > 0) {
        url = ctx.recentUrls[0]
      }
      if (!url || !/^https?:\/\//i.test(url)) return { type: 'error', error: 'valid URL required — gua gak nemu URL di chat. Coba paste URL produknya.' }
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      const cfg = ctx.activeConfig || {}
      const finalDuration = Math.max(3, Math.min(15, parseInt(duration) || parseInt(cfg.duration) || 8))
      const finalAr = ar || cfg.ar || '9:16'
      const finalTheme = theme || 'modern UGC, scroll-stopping'

      try {
        // STEP 1 — Scrape + extract product info via Gemini.
        const html = await fetchUrlAsHtml(url)
        const extractPrompt = `Extract product info from this HTML to build a marketing video. Return JSON only:
{
  "title": "product name",
  "image_url": "best primary product image URL from the page (absolute URL)",
  "key_features": ["feature 1", "feature 2", "feature 3"],
  "motion_prompt": "${finalDuration}s video motion description in English, matching theme '${finalTheme}'. Describe what happens, camera moves, mood. Be cinematic. Bake in product showcase. Single block of text, no timestamps."
}

URL: ${url}
HTML: ${html.slice(0, 22000)}`

        const extracted = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
          temperature: 0.6,
          maxOutputTokens: 4000,
        })
        const p = extracted.parsed || {}

        if (!p.image_url || !p.motion_prompt) {
          return { type: 'error', error: 'gagal extract product image / motion dari URL — coba paste URL yang punya product photo jelas' }
        }

        // STEP 2 — Resolve video model. User can override via "pake Kling 3"
        // in prompt, which the agent passes as modelOverride. Otherwise use
        // the image-to-video version of cfg.video_model since we have a
        // source image now (scraped product photo).
        let videoModel = modelOverride
        if (!videoModel) {
          const i2vMap = {
            'bytedance/seedance-2.0/fast/reference-to-video': 'bytedance/seedance-2.0/fast/image-to-video',
            'fal-ai/kling-video/v3/reference-to-video': 'fal-ai/kling-video/v3/image-to-video',
            'alibaba/happy-horse/reference-to-video': 'alibaba/happy-horse/image-to-video',
          }
          videoModel = i2vMap[cfg.video_model] || 'fal-ai/kling-video/v3/image-to-video'
        }

        // STEP 3 — Append active cinematic preset if any.
        let finalMotion = p.motion_prompt
        if (ctx.activePreset?.prompt) {
          finalMotion += `\n\n[Cinematic preset: ${ctx.activePreset.label}] ${ctx.activePreset.prompt}`
        }
        if (cfg.audio === false) finalMotion += '\n\nNO dialogue, NO speech, silent ambient only.'

        // STEP 4 — Submit to fal.ai queue. Use the per-model helper so
        // Kling gets start_image_url, others get image_url, etc.
        const videoInput = buildVideoInputForModel(videoModel, {
          motion_prompt: finalMotion,
          image_url: p.image_url,
          duration: finalDuration,
          aspect_ratio: finalAr,
          resolution: cfg.resolution,
        })
        // Canonicalize before queue calls — see src/lib/fal-paths.js
        const wireVideoModel = canonicalFalPath(videoModel)
        const submitRes = await fetch(`https://queue.fal.run/${wireVideoModel}`, {
          method: 'POST',
          headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(videoInput),
        })
        const submitData = await submitRes.json().catch(() => ({}))
        if (!submitRes.ok) throw new Error(submitData?.detail || submitData?.error || `fal.ai ${submitRes.status}`)
        const requestId = submitData?.request_id
        if (!requestId) throw new Error('no request_id from fal')
        // Capture fal-provided polling URLs (authoritative — see fal-paths.js)
        const statusUrl = submitData?.status_url
        const responseUrl = submitData?.response_url

        // STEP 5 — Short inline poll, falls back to queued state for frontend.
        let done = null
        const start = Date.now()
        while (Date.now() - start < 30000) {
          await new Promise((r) => setTimeout(r, 4000))
          const stUrl = statusUrl || `https://queue.fal.run/${wireVideoModel}/requests/${requestId}/status`
          const stRes = await fetch(stUrl, { headers: { 'Authorization': `Key ${falKey}` } })
          const st = await stRes.json().catch(() => ({}))
          if (st?.status === 'COMPLETED') {
            const rUrl = responseUrl || `https://queue.fal.run/${wireVideoModel}/requests/${requestId}`
            const fullRes = await fetch(rUrl, { headers: { 'Authorization': `Key ${falKey}` } })
            done = await fullRes.json().catch(() => ({}))
            break
          }
          if (st?.status === 'FAILED') throw new Error(st?.error || 'fal gen failed')
        }

        if (done) {
          const videoUrl = done?.video?.url || done?.url
          if (!videoUrl) return { type: 'error', error: 'no video url in fal response' }
          const { data: row } = await ctx.supabase.from('results').insert({
            workspace_id: ctx.workspaceId,
            type: 'video', url: videoUrl,
            label: `God Mode — ${p.title || 'marketing video'}`,
            ar: finalAr,
            meta: { source: 'god-mode', source_url: url, motion: finalMotion, model: wireVideoModel, theme: finalTheme, product_image: p.image_url },
            created_by: ctx.userId,
          }).select('id').single()
          return {
            type: 'gen_video_result',
            url: videoUrl, model: wireVideoModel, ar: finalAr, duration: finalDuration,
            result_id: row?.id, motion: finalMotion,
            regen_payload: { url, duration: finalDuration, theme: finalTheme, model: modelOverride, ar: finalAr },
          }
        }

        return {
          type: 'gen_video_queued',
          request_id: requestId, model: wireVideoModel,
          status_url: statusUrl, response_url: responseUrl,
          ar: finalAr, duration: finalDuration,
          motion: finalMotion, image_url: p.image_url,
          regen_payload: { url, duration: finalDuration, theme: finalTheme, model: modelOverride, ar: finalAr },
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Video analyzer ────────────────────────────────────────────────
  analyze_reference_video: {
    description: 'Analyze a reference video to extract style, camera, mood, pacing, suggested replication strategy. Use when user uploads a video as attachment OR provides a URL (TikTok / IG / YouTube) and asks "make like this" / "analyze this video" / "analisis video diatas".',
    handler: async ({ video_url, attachment_index }, ctx) => {
      // Resolve source — explicit tool_input.video_url first, then recent
      // attachment, then any URL pasted earlier in the conversation
      // (handles "analisis video diatas" / "video dari link tadi").
      let urlToAnalyze = video_url
      if (!urlToAnalyze && Array.isArray(ctx.recentAttachments)) {
        const att = ctx.recentAttachments[parseInt(attachment_index) || 0]
        if (att?.url) urlToAnalyze = att.url
      }
      if (!urlToAnalyze && Array.isArray(ctx.recentUrls) && ctx.recentUrls.length > 0) {
        urlToAnalyze = ctx.recentUrls[0]
      }
      if (!urlToAnalyze) return { type: 'error', error: 'gak nemu URL video atau attachment buat dianalisis. Paste link video atau upload langsung.' }

      const analyzePrompt = `Analyze this video reference and extract its production strategy so the user can replicate similar content. Reply in Bahasa Indonesia.

Video URL: ${urlToAnalyze}

Return JSON only with these fields:
{
  "style": "art / visual style (e.g. UGC iPhone handheld, 2D storybook, cinematic anamorphic)",
  "camera": "primary camera moves used (e.g. medium shot static, push-in, handheld POV)",
  "mood": "emotional tone (e.g. authentic casual, dramatic tense, lighthearted comedy)",
  "pacing": "edit pace (e.g. 3 beats in 15s, slow contemplative, fast cuts)",
  "character_notes": "character appearance and behavior summary",
  "suggested_model": "which fal.ai model is best for replicating (e.g. Grok i2v + iPhone preset, Seedance ref-to-video)",
  "replication_strategy": "step-by-step strategy to replicate this style in 1-2 paragraphs"
}`

      try {
        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: analyzePrompt }] }],
          temperature: 0.4,
          maxOutputTokens: 3000,
        })
        return { type: 'video_analysis', ...(result.parsed || {}) }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Virality predictor ────────────────────────────────────────────
  predict_virality: {
    description: 'Score viral potential of a video or image. Use when user asks to score, predict virality, judge hook strength. Provide content_url or use recent attachment.',
    handler: async ({ content_url }, ctx) => {
      let url = content_url
      if (!url && Array.isArray(ctx.recentAttachments) && ctx.recentAttachments[0]?.url) {
        url = ctx.recentAttachments[0].url
      }
      if (!url && Array.isArray(ctx.recentUrls) && ctx.recentUrls.length > 0) {
        url = ctx.recentUrls[0]
      }
      if (!url) return { type: 'error', error: 'gak nemu content buat di-score. Paste URL atau upload media dulu.' }

      const scorePrompt = `Score the viral potential of this content for short-form social media (TikTok/Reels). Reply in Bahasa Indonesia.

Content URL: ${url}

Apply these scoring rules (0-100 each):
- hook: Does the first 1-3 seconds grab attention? Visual contrast, motion, surprising element, clear subject?
- retention: Does the content reward continued watching? Pacing tight? Curiosity loop? Payoff visible?
- visual: Color contrast, framing quality, subject prominence, scroll-stopping aesthetics?

Compute overall = average of (hook, retention, visual).

Return JSON only:
{
  "hook": <0-100>,
  "retention": <0-100>,
  "visual": <0-100>,
  "overall": <0-100>,
  "advice": ["improvement tip 1", "tip 2", "tip 3"]
}`

      try {
        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: scorePrompt }] }],
          temperature: 0.3,
          maxOutputTokens: 3000,
        })
        const p = result.parsed || {}
        return {
          type: 'virality_score',
          hook: parseInt(p.hook) || 0,
          retention: parseInt(p.retention) || 0,
          visual: parseInt(p.visual) || 0,
          overall: parseInt(p.overall) || 0,
          advice: Array.isArray(p.advice) ? p.advice : [],
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Brand Builder ─────────────────────────────────────────────────
  brand_builder: {
    description: 'Bootstrap a brand from scratch. User describes a niche or product idea, this returns: niche analysis + brand concept + suggested name/tagline + product description + 3 listing photo prompts + 1 hero video naskah. Use when user says "build me a brand", "bikin brand X from scratch", "research niche Y + bikin konsep".',
    handler: async ({ niche_or_idea }, ctx) => {
      if (!niche_or_idea) return { type: 'error', error: 'niche_or_idea required' }

      const prompt = `You are a brand strategist + creative director. User wants to bootstrap a brand from this seed: "${niche_or_idea}".

Generate a full brand bootstrap package in Bahasa Indonesia. Return JSON only:
{
  "niche_analysis": "1-2 paragraph niche analysis — pain point yang dipecahkan, target audience, competitor angle",
  "brand_name_suggestions": ["name1", "name2", "name3"],
  "tagline_suggestions": ["tagline1", "tagline2"],
  "brand_voice": "casual/formal/playful/luxury - one of these + 1 line rationale",
  "color_palette": ["#hex1", "#hex2", "#hex3"],
  "product_concept": "1 paragraph what the product is + key features",
  "target_audience": "specific audience demographics + psychographics in 1 paragraph",
  "listing_photo_prompts": [
    "prompt 1 — clean studio shot",
    "prompt 2 — lifestyle in-use shot",
    "prompt 3 — hero detail close-up"
  ],
  "hero_video_naskah": "30s UGC-style video naskah in Indonesian, 5 shots with [0:XX-0:YY] timestamps, dialog cues, mood notes",
  "marketing_angles": ["angle 1", "angle 2", "angle 3"]
}

Be specific to Indonesian / SEA market. Make brand names that sound natural in Indonesian (mix English/Indonesian OK).`

      try {
        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          temperature: 0.7,
          maxOutputTokens: 3000,
        })
        return { type: 'brand_builder_result', seed: niche_or_idea, ...(result.parsed || {}) }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Mass Image Variants (Variant Forge Lite) ─────────────────────
  mass_image_variants: {
    description: 'Generate multiple image variants of a product/persona across different scenes/concepts. User specifies count (5-30), scenes/concepts list, personas list. Returns gallery of N images. Use when user asks "bikin 10 variant" / "gen 20 variasi product di scene berbeda" / "mass generate images".',
    handler: async ({ count = 6, scenes = [], hooks = [], use_product = true, use_personas = false }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      const n = Math.max(2, Math.min(20, parseInt(count) || 6))

      // Build variation matrix — combine scenes × hooks if both provided,
      // else just use scenes, else infer 4 default scenes.
      let scenesList = Array.isArray(scenes) && scenes.length ? scenes : ['di cafe modern', 'di kamar dengan natural window light', 'di kitchen rapi', 'outdoor taman santai', 'di mobil', 'home studio minimalist']
      let hooksList = Array.isArray(hooks) && hooks.length ? hooks : ['close-up product detail', 'lifestyle wide shot', 'hand holding product', 'over-shoulder POV', 'flat lay aesthetic']

      // Generate variations — round-robin combinations.
      const variations = []
      for (let i = 0; i < n; i++) {
        variations.push({
          scene: scenesList[i % scenesList.length],
          hook: hooksList[i % hooksList.length],
          index: i,
        })
      }

      // Build refs (product + persona if pinned)
      const refUrls = []
      if (use_product && ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)
      if (use_personas && ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }

      const model = 'fal-ai/nano-banana/edit'
      const cfg = ctx.activeConfig || {}

      // Fire all gens in parallel with concurrency cap = 5 to stay under
      // fal.ai rate limits + Vercel function 60s timeout. Each image gen
      // is usually <15s, 5 concurrent x ceil(20/5) = 4 batches = ~60s max.
      const results = []
      const CONCURRENCY = 5
      for (let batchStart = 0; batchStart < variations.length; batchStart += CONCURRENCY) {
        const batch = variations.slice(batchStart, batchStart + CONCURRENCY)
        const batchResults = await Promise.all(batch.map(async (v) => {
          const productHint = ctx.activeProduct ? `${ctx.activeProduct.label}` : 'the product'
          const prompt = `${v.hook} of ${productHint} ${v.scene}, professional photography, ${cfg.resolution === '1080p' ? 'highly detailed' : 'clean composition'}`
          try {
            const data = await falCall(model, {
              prompt,
              image_urls: refUrls.slice(0, 6),
              output_format: 'jpeg',
            }, falKey)
            const url = data?.images?.[0]?.url || data?.image?.url
            if (!url) return null

            // Save to results
            const { data: row } = await ctx.supabase.from('results').insert({
              workspace_id: ctx.workspaceId,
              persona_id: ctx.activePersona?.id || null,
              type: 'image', url,
              label: `Variant ${v.index + 1}`,
              ar: cfg.ar || 'auto',
              meta: { source: 'god-mode', batch: 'mass-variants', scene: v.scene, hook: v.hook, prompt, model },
              created_by: ctx.userId,
            }).select('id').single()

            return { url, scene: v.scene, hook: v.hook, index: v.index, result_id: row?.id }
          } catch (e) {
            return { error: e.message, scene: v.scene, hook: v.hook, index: v.index }
          }
        }))
        results.push(...batchResults)
      }

      return {
        type: 'mass_variants_result',
        count: results.filter(Boolean).length,
        requested: n,
        variants: results,
        product_label: ctx.activeProduct?.label || null,
      }
    },
  },

  // ─ Viral Ad Campaign (full agency workflow) ─────────────────────
  viral_ad_campaign: {
    description: 'BIG TOOL — full ad agency workflow. Generates N (default 20) ad concepts for a product based on proven viral ad patterns (hook frameworks, retention mechanics, CTA conversions), scores+ranks each, then COMBINES the strongest elements into ONE production-ready package: hook, 5-shot storyboard, shotlist with camera directions, voiceover script, on-screen text, CTA, and visual reference prompts. Use when user asks for "20 ad concepts", "build viral ad campaign", "ad agency workflow", "bikin iklan production-ready", "score + rank + combine into final ad". Pass product_description (or rely on pinned product/chat attachments), optional niche/target_audience/n_concepts.',
    handler: async ({ product_description, niche, target_audience, n_concepts = 20 }, ctx) => {
      // Resolve product context — explicit > pinned > chat attachments > raw user intent.
      let productDesc = product_description || ''
      if (!productDesc && ctx.activeProduct) {
        productDesc = `${ctx.activeProduct.label}${ctx.activeProduct.knowledge ? ' — ' + JSON.stringify(ctx.activeProduct.knowledge).slice(0, 800) : ''}`
      }
      if (!productDesc && ctx.lastUserText) productDesc = ctx.lastUserText
      if (!productDesc) return { type: 'error', error: 'Kasih deskripsi produk atau pin produk dulu.' }

      const n = Math.max(5, Math.min(30, parseInt(n_concepts) || 20))

      // ONE big LLM call to generate concepts + score + rank + final package.
      // Multi-pass would be cleaner but costs 3x tokens; with maxOutputTokens
      // = 8000 + Gemini 2.5 we get a coherent single-pass deliverable.
      const prompt = `You are a senior creative director at a top-tier social ads agency. Your job: build a complete ad campaign for the product below, grounded in proven viral ad patterns (NOT real-time market analysis — work from established short-form ad frameworks).

PRODUCT: ${productDesc}
${niche ? `NICHE: ${niche}` : ''}
${target_audience ? `TARGET AUDIENCE: ${target_audience}` : ''}

DELIVERABLES (return as JSON, Bahasa Indonesia for copy where appropriate):

1. concepts: array of ${n} distinct ad concepts. Each:
   { id, name, hook_type (problem-agitate, transformation, social-proof, contrarian, demo, before-after, POV, etc), one_line_pitch, target_emotion, format (UGC selfie / cinematic / split-screen / etc) }

2. scored_concepts: array of ${n}, same order as concepts. Each:
   { id, hook_score (0-100), retention_score (0-100), conversion_score (0-100), overall (avg), why_it_works (1 sentence) }

3. top_3_ids: array of the 3 highest overall scores, sorted descending.

4. final_package: combining the strongest elements from top 3 into ONE production-ready ad. Object:
   {
     "title": "campaign title",
     "duration_seconds": 15,
     "hook": "first 1-3 sec hook line + visual",
     "storyboard": [
       { "shot": 1, "duration_s": 3, "visual": "...", "camera": "push-in / handheld POV / static wide / etc", "on_screen_text": "...", "voiceover": "..." },
       { "shot": 2, ... },
       ... 5 shots total covering full duration
     ],
     "shotlist_compact": "Shot 1: ... | Shot 2: ... | Shot 3: ... etc — single-line summary",
     "voiceover_full": "complete VO script as one continuous block of speech",
     "on_screen_text_full": "all on-screen text overlays in order",
     "cta": "exact final CTA line + visual",
     "visual_reference_prompts": [
       "ref prompt 1 — describe a real-world ad style / shot that this looks like",
       "ref prompt 2",
       "ref prompt 3"
     ],
     "music_mood": "BPM range + genre + reference track style",
     "why_this_combo": "1-2 sentence rationale for combining these specific elements"
   }

Return JSON only, no prose. No markdown fences. Be specific, no generic filler.`

      try {
        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          temperature: 0.7,
          maxOutputTokens: 8000,
        })
        const p = result.parsed || {}
        return {
          type: 'viral_ad_campaign_result',
          product: productDesc.slice(0, 200),
          n_concepts: Array.isArray(p.concepts) ? p.concepts.length : 0,
          concepts: p.concepts || [],
          scored_concepts: p.scored_concepts || [],
          top_3_ids: p.top_3_ids || [],
          final_package: p.final_package || null,
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Soul / LoRA training ─────────────────────────────────────────
  train_persona_soul: {
    description: 'Start training a Soul (LoRA) for a persona. Use when user explicitly asks to train soul, train persona, lock character via training. Requires persona_id + reference image URLs (from user attachments or persona refs).',
    handler: async ({ persona_id, image_urls }, ctx) => {
      if (!persona_id) return { type: 'error', error: 'persona_id required' }
      let urls = Array.isArray(image_urls) ? image_urls.filter(Boolean) : []

      // Fallback — if user didn't pass URLs, pull from persona's existing refs
      if (urls.length < 4) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', persona_id)
        urls = (pRefs || []).map((r) => r.refs?.fal_url).filter(Boolean)
      }
      if (urls.length < 4) return { type: 'error', error: 'minimum 4 reference images needed (attach or add to persona refs first)' }

      // Scope to caller's workspace — persona_id is user-supplied so
      // without the filter, the agent could leak persona metadata
      // (name + username) from another tenant's workspace via the
      // soul_training_result response.
      const { data: persona } = await ctx.supabase
        .from('personas').select('id, name, username, workspace_id')
        .eq('id', persona_id).eq('workspace_id', ctx.workspaceId).maybeSingle()
      if (!persona) return { type: 'error', error: 'persona not found' }

      // Kick off via the dedicated train-soul endpoint internally.
      const proto = ctx.req?.headers?.get?.('x-forwarded-proto') || 'https'
      const host = ctx.req?.headers?.get?.('host') || 'localhost:3000'
      const cookie = ctx.req?.headers?.get?.('cookie') || ''
      try {
        const r = await fetch(`${proto}://${host}/api/god-mode/train-soul`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ persona_id, image_urls: urls.slice(0, 15) }),
        })
        const j = await r.json()
        if (!j.ok) return { type: 'error', error: j.error }
        return {
          type: 'soul_training_result',
          status: 'training',
          persona_name: persona.name,
          trigger_word: j.trigger_word,
          request_id: j.request_id,
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },
}

// ── System prompt builder ───────────────────────────────────────────

function buildSystemPrompt(ctx) {
  const toolDescriptions = Object.entries(TOOLS).map(([name, t]) => `- ${name}: ${t.description}`).join('\n')
  const brandLine = ctx.activeBrand
    ? `Active brand: "${ctx.activeBrand.name}" (notes: ${ctx.activeBrand.notes || 'none'})`
    : 'No active brand'

  // Active context — locked persona/product/preset that the user has pinned
  // earlier in the chat. Gen tools automatically use these as defaults.
  const ctxLines = []
  if (ctx.activePersona) ctxLines.push(`Pinned persona: ${ctx.activePersona.name} (id ${ctx.activePersona.id})${ctx.activePersona.lora_url ? ' — has Soul LoRA trained' : ''}`)
  if (ctx.activeProduct) ctxLines.push(`Pinned product: ${ctx.activeProduct.label}`)
  if (ctx.activePreset) ctxLines.push(`Pinned cinematic preset: ${ctx.activePreset.label}`)
  const ctxBlock = ctxLines.length ? `\nPinned context:\n${ctxLines.map((l) => `  - ${l}`).join('\n')}` : ''

  // User's current config bar defaults — gen tools use these unless the user
  // overrides per-message. Surface to LLM so it knows the baseline.
  const cfg = ctx.activeConfig || {}
  const cfgBlock = `
Current config defaults (from user's picker bar):
  - Image model: ${cfg.image_model || 'fal-ai/nano-banana/edit'}
  - Video model: ${cfg.video_model || 'bytedance/seedance-2.0/fast/reference-to-video'}
  - Aspect ratio: ${cfg.ar || '9:16'}
  - Duration: ${cfg.duration || 5}s
  - Audio: ${cfg.audio === false ? 'off' : 'on'}
  - Resolution: ${cfg.resolution || '720p'}`

  // Model catalogs — user can ask "pakai Veo3" / "ganti ke Kling Pro" etc
  const imgList = IMAGE_MODELS.map((m) => `  - ${m.v}: ${m.l}`).join('\n')
  const vidList = VIDEO_MODELS.map((m) => `  - ${m.v}: ${m.l}`).join('\n')

  return `You are GOD MODE — AI agent inside CAK Video Studio. You speak Bahasa Indonesia (casual, like a teammate). Be direct, decisive, helpful.

Context:
- ${brandLine}
- Personas available: ${ctx.personaCount}
- Product refs available: ${ctx.productCount}
- Cinematic presets in library: ${CINEMATIC_PRESETS.length}${ctxBlock}
${cfgBlock}

Available image models (pass to gen_image as { model } if user overrides):
${imgList}

Available video models (pass to gen_video as { model } if user overrides):
${vidList}

Available tools (return ONE tool call when relevant, OR text reply if no tool fits):

${toolDescriptions}

OUTPUT FORMAT (strict JSON, no markdown):
{
  "tool": "<tool_name>" | null,
  "tool_input": { ... } | null,
  "text": "<short reply in Bahasa Indonesia, conversational>"
}

Rules:
- If a tool fits, return tool name + inputs.
- "text" should be brief setup line; UI renders tool result below.
- NEVER invent tools not in the list.
- NEVER refuse a request just because it sounds complex / multi-step. The tools below CAN handle big workflows:
  * "20 ad concepts + scored + ranked + combined into production package" → viral_ad_campaign (one shot, returns all of it).
  * "brand from scratch + naskah + listing photos" → brand_builder.
  * "20 product variants in different scenes" → mass_image_variants.
  * "analyze video + remake with my character + product" → analyze_reference_video first, then gen_video with refs.
  If you see a tool that fits, USE IT. Don't tell user "gua belum bisa". Don't claim limits the tools don't have.
- IMPORTANT: viral_ad_campaign does NOT need real-time market data. It synthesizes from established viral ad frameworks (hook types, retention mechanics, conversion triggers). Use it whenever user asks for ad concepts + scoring + final package, even if they mention "viral ads from last X days".

PROMPT RULES (CRITICAL — fal returns 422 if empty):
- gen_image MUST receive tool_input.prompt = a full English visual description (2-4 sentences). Take the user's Indonesian intent and EXPAND into vivid English prompt. NEVER send empty prompt. NEVER put the prompt only in "text".
- gen_video MUST receive tool_input.motion_prompt = full English motion description (what happens, camera moves, mood). NEVER send empty motion_prompt.
- Example: user says "bro buatin gambar orang di pantai candid UGC pake samsung a13 potrait" → prompt: "A candid UGC-style portrait of a young person at a sunny tropical beach, shot on Samsung A13 with slight motion blur, natural sunlight, authentic vacation vibe, vertical 9:16 framing, soft warm tones."

MODEL VARIANT RULES (CRITICAL):
- If user wants pure text-to-image (no source image uploaded, no pinned product, no URL): pick the BASE variant — "fal-ai/nano-banana" (not /edit), "openai/gpt-image-2" (not /edit).
- If user uploaded image to chat OR has pinned source: pick the /edit variant for that family.
- For video: if user uploaded image OR pinned product → use image-to-video variant. If only personas pinned (multi-ref) → use reference-to-video. If pure text → text-to-video.

- For gen_image/gen_video: use config defaults from above UNLESS user explicitly mentions a different model / AR / duration / audio in their message — then override via tool_input.
- If user says e.g. "pakai Kling Pro 1:1 10 detik no audio", pass { model: 'fal-ai/kling-video/v3/pro/image-to-video', ar: '1:1', duration: 10 } to gen_video (and bake "silent" into motion_prompt).
- SOURCE RESOLUTION (CRITICAL — read carefully):
  - User UPLOADED an image/file to chat (look for attachments in conversation): treat that as the source. For IMAGE gen → call gen_image (handler auto-attaches recent chat attachments as refs). For VIDEO gen from uploaded image → call gen_video with image_url set to the attachment URL.
  - User pasted a URL in current OR recent message: use the URL.
  - User says "link itu" / "URL diatas" / "dari link tadi" without re-pasting: URL auto-resolves from recent messages (handler does this).
  - User says "dari gambar diatas" / "edit foto yang gua upload" / "gambar barusan" → that means a CHAT ATTACHMENT not a URL. Call gen_image (handler picks up attachments). DO NOT ask user to pin anything.
  - Never tell user to "pin product/persona dulu" if they already uploaded an image or pasted a URL — just call the right tool.

- URL/VIDEO ROUTING:
  - URL + "bikin video X detik tema Y" / "video dari link" → gen_marketing_video_from_url with extracted (duration, theme, model).
  - URL + "bikin foto/image/poster" → gen_image_from_url.
  - Bare URL no clear instruction → scrape_url_for_marketing (preview).
  - Detect model overrides in prompt: "pake Kling 3" -> 'fal-ai/kling-video/v3/image-to-video', "Kling Pro" -> '/v3/pro/image-to-video', "Seedance" -> 'bytedance/seedance-2.0/fast/image-to-video', "Veo" -> 'fal-ai/veo3', "Grok" -> 'xai/grok-imagine-video/image-to-video', "GPT Image 2 Edit" -> 'openai/gpt-image-2/edit', "Nano Banana" -> 'fal-ai/nano-banana/edit'.
- If user uploads/attaches a video and says "analyze" or "make like this", call analyze_reference_video.
- If user uploads/attaches image/video and asks to score / predict virality, call predict_virality.
- Always return valid JSON. No markdown, no code fences.`
}

// ── Route handler ───────────────────────────────────────────────────

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }

  const { workspaceId, messages, activeBrand, personaCount = 0, productCount = 0, activeContext = {} } = body || {}
  if (!workspaceId || !Array.isArray(messages)) {
    return NextResponse.json({ ok: false, error: 'missing workspaceId or messages' }, { status: 400 })
  }

  const { data: ws } = await supabase.from('workspaces').select('id').eq('id', workspaceId).maybeSingle()
  if (!ws) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 403 })

  // Most-recent user message attachments — used by tools that operate on
  // uploaded content (analyze_reference_video, predict_virality, gen_image).
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const recentAttachments = lastUserMsg?.attachments || []
  const lastUserText = lastUserMsg?.content ? String(lastUserMsg.content).trim() : ''

  // Collect URLs mentioned anywhere in the recent conversation (last 6 msgs).
  // If user says "dari link itu" without re-pasting, we can still resolve.
  // Order: most-recent first so agent picks the latest URL.
  const recentUrls = []
  const urlRe = /https?:\/\/[^\s"'<>)]+/g
  for (const m of [...messages].reverse().slice(0, 6)) {
    const txt = String(m.content || '')
    const found = txt.match(urlRe) || []
    for (const u of found) if (!recentUrls.includes(u)) recentUrls.push(u)
  }

  const ctx = {
    supabase,
    workspaceId,
    userId: user.id,
    activeBrand: activeBrand || null,
    activeBrandId: activeBrand?.id || null,
    personaCount,
    productCount,
    activePersona: activeContext?.persona || null,
    activeProduct: activeContext?.product || null,
    activePreset: activeContext?.preset || null,
    activeConfig: activeContext?.config || {},
    recentAttachments,
    recentUrls,
    lastUserText,
    req,
  }

  const systemPrompt = buildSystemPrompt(ctx)

  // Build Gemini contents. Multimodal: inline images from user attachments.
  const contents = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Siap. Gua agent GOD MODE — tinggal kasih tau apa yang lo butuh.' }] },
  ]
  for (const m of messages.slice(-12)) {
    const parts = []
    if (m.content) parts.push({ text: String(m.content) })
    const atts = Array.isArray(m.attachments) ? m.attachments.slice(0, 5) : []
    let imgCount = 0
    for (const a of atts) {
      if (a.type === 'image' && imgCount < 3) {
        try {
          const imgRes = await fetch(a.url)
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer())
            parts.push({ inline_data: { mime_type: a.mime || 'image/jpeg', data: buf.toString('base64') } })
            imgCount++
          }
        } catch {
          parts.push({ text: `[attached image: ${a.name}]` })
        }
      } else {
        parts.push({ text: `[attached file: ${a.name} at ${a.url}]` })
      }
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: parts.length > 0 ? parts : [{ text: '' }],
    })
  }

  let parsed
  try {
    // 4000 tokens — gives Gemini enough headroom to emit full motion_prompt
    // or visual prompt (often 200-500 tokens) without truncating the JSON.
    // 1024 was too tight: long prompts caused "balik bukan JSON valid" errors
    // because the response cut off mid-string.
    const res = await callLLMJSON({ workspaceId, contents, temperature: 0.4, maxOutputTokens: 4000 })
    parsed = res.parsed
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'llm error: ' + (e?.message || String(e)) }, { status: 500 })
  }

  const tool = parsed?.tool
  const toolInput = parsed?.tool_input || {}
  const text = String(parsed?.text || '')

  let toolResult = null
  if (tool && TOOLS[tool]) {
    try {
      toolResult = await TOOLS[tool].handler(toolInput, ctx)
    } catch (e) {
      toolResult = { type: 'error', error: e?.message || 'tool execution failed' }
    }
  }

  return NextResponse.json({ ok: true, text, tool: tool || null, tool_result: toolResult })
}
