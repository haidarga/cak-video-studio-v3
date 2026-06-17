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
import { assertBudget, estimateFalCost } from '@/lib/budget-gate'
import { isPublicHttpUrl } from '@/lib/ssrf-guard'
import {
  buildVideoInputForModel,
  buildImageInputForModel,
  falCall,
  fetchUrlAsHtml,
  buildProductFidelityDirective,
  buildVideoEditInput,
  mirrorToR2,
  mirrorToFalStorage,
  mirrorToFalStorageStrict,
} from '@/lib/god-mode-builders'

export const runtime = 'nodejs'
export const maxDuration = 120

// ── Helpers ──────────────────────────────────────────────────────────

async function getFalKey(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspaces').select('fal_key').eq('id', workspaceId).maybeSingle()
  return data?.fal_key || process.env.FAL_KEY || ''
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
    handler: async ({ prompt, ar, model: modelOverride, extra_ref_urls }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      // Resolve config defaults from active context, with per-call overrides.
      const cfg = ctx.activeConfig || {}
      const finalAr = ar || cfg.ar || 'auto'

      // Build ref_image_urls stack — IMPORTANT priority order:
      //   0. Continuity refs from continue_shot (previous shot's frame + its
      //      original refs) — strongest anchor, must be seen first
      //   1. Recent chat attachments (user uploaded image to chat) — primary
      //      source for "edit gambar yang gua upload" / "dari gambar diatas"
      //   2. Pinned persona refs
      //   3. Pinned product ref
      const refUrls = []
      for (const u of Array.isArray(extra_ref_urls) ? extra_ref_urls : []) {
        if (u && /^https?:/.test(u)) refUrls.push(u)
      }
      for (const att of ctx.recentAttachments || []) {
        if (att.type === 'image' && att.url) refUrls.push(att.url)
      }
      if (ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)
      // Dedupe keeping FIRST occurrence (continuity ref can also arrive as a
      // chat attachment) — preserves priority order, and duplicate ref URLs
      // waste model attention / 422 on some endpoints.
      const dedupedRefs = [...new Set(refUrls)]
      refUrls.length = 0
      refUrls.push(...dedupedRefs)

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

      // ── Soul LoRA auto-inject ──
      // If pinned persona has a trained LoRA, two things happen automatically:
      //   1. trigger_word is prepended to the prompt (helps the model invoke
      //      the trained character even on non-LoRA models, since the trigger
      //      word also leaks into general latent space during training).
      //   2. If no model override, switch to flux-lora to actually USE the
      //      LoRA weights (the loras array is injected after buildInput).
      // Previously the trigger word only got injected when model was unset,
      // so picking nano-banana with a LoRA persona meant the trained
      // character was effectively ignored. Now trigger word fires always.
      const hasSoul = ctx.activePersona?.lora_url && ctx.activePersona?.lora_trigger_word
      if (hasSoul) {
        const trigger = ctx.activePersona.lora_trigger_word
        // Only prepend if user prompt doesn't already contain the trigger
        // — avoid double-prepending when user types the trigger themselves.
        if (!finalPrompt.toLowerCase().includes(trigger.toLowerCase())) {
          finalPrompt = `${trigger}, ${finalPrompt}`
        }
        if (!model) model = 'fal-ai/flux-lora'
      }
      if (!model) model = cfg.image_model || 'fal-ai/nano-banana/edit'

      // ── Product fidelity directive ──
      // Append the pinned product's textual knowledge (description, dimensions,
      // features, label text) as a STRONG directive. Without this, the model
      // only sees the product as a fuzzy image ref + drifts across shots.
      // With this, the model has both visual + textual anchors -> stays
      // consistent. Critical for branded campaigns (UGREEN, ACEKID, etc).
      const productDirective = buildProductFidelityDirective(ctx.activeProduct)
      if (productDirective) finalPrompt += productDirective

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

      // Budget gate — refuse the gen if the workspace's daily/monthly
      // budget would be busted. WITHOUT this, god-mode chat became the
      // only fal-spending surface that bypassed the limit. assertBudget
      // is fail-closed so a DB read hiccup blocks rather than allows.
      const imgProjected = estimateFalCost(model, input || {})
      const imgGate = await assertBudget(ctx.supabase, ctx.workspaceId, { projectedUsd: imgProjected })
      if (!imgGate.ok) return { type: 'error', error: imgGate.reason, gate: imgGate }

      try {
        let data
        try {
          data = await falCall(model, input, falKey)
        } catch (err) {
          // file_download_error retry — refs on r2.dev get rate-limited for
          // fal's downloaders. Re-host refs on fal storage and retry once.
          if (/failed to download|file_download_error|inaccessible/i.test(String(err?.message || '')) && refUrls.length) {
            const mirroredRefs = await Promise.all(refUrls.map((u) => mirrorToFalStorage(u, falKey)))
            const input2 = buildImageInputForModel(model, {
              prompt: finalPrompt, refs: mirroredRefs, ar: finalAr, quality: cfg.resolution,
            })
            if (model.includes('flux-lora') && ctx.activePersona?.lora_url) {
              input2.loras = [{ path: ctx.activePersona.lora_url, scale: 1.0 }]
            }
            data = await falCall(model, input2, falKey)
          } else {
            throw err
          }
        }
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
          // Re-gen payload — frontend uses this to fire identical re-gen call.
          // refs included so continue_shot can carry the same anchors forward.
          regen_payload: { prompt, ar, model: modelOverride, refs: refUrls.slice(0, 8) },
        }
      } catch (e) {
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
        return { type: 'error', error: e.message }
      }
    },
  },

  gen_video: {
    description: 'Generate one OR MORE videos. Pass motion_prompt (what happens, camera moves). Optional: duration (3-15s), image_url for image-to-video, ar (override), model (override config), count (1-5, parallel parallel gens — pass when user says "3 video" / "5 variasi"). If active persona/product, refs auto-attach. If active preset, its motion prompt appended.',
    handler: async ({ motion_prompt, duration, image_url, ar, model: modelOverride, count = 1, extra_ref_urls }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      // Resolve config defaults with per-call overrides.
      const cfg = ctx.activeConfig || {}
      const finalAr = ar || cfg.ar || '9:16'
      let dur = Math.max(3, Math.min(15, parseInt(duration) || parseInt(cfg.duration) || 5))
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

      // Product fidelity directive — same anti-drift mechanism as gen_image.
      // Video gen is even more prone to product drift since each frame is
      // generated semi-independently. Strong textual anchor + image ref =
      // best chance of identical product across all frames.
      const vidProductDirective = buildProductFidelityDirective(ctx.activeProduct)
      if (vidProductDirective) finalMotion += vidProductDirective

      // Build refs from active context. PRIORITY ORDER:
      //   0. Continuity refs from continue_shot (previous shot's frame + its
      //      original refs) — strongest anchor, must be seen first
      //   1. Chat attachments (images user uploaded in this turn — primary
      //      source when user says "gambar 2 dan produk di gambar 3")
      //   2. Pinned persona refs
      //   3. Pinned product ref
      // This mirrors gen_image's behavior; without this, ref-to-video models
      // (Grok, Seedance r2v, Kling r2v) 422 on empty reference_image_urls
      // even when the user clearly uploaded ref images.
      let refUrls = []
      for (const u of Array.isArray(extra_ref_urls) ? extra_ref_urls : []) {
        if (u && /^https?:/.test(u)) refUrls.push(u)
      }
      for (const att of ctx.recentAttachments || []) {
        if (att.type === 'image' && att.url) refUrls.push(att.url)
      }
      if (ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)
      // Dedupe keeping FIRST occurrence — continuity ref can also arrive as
      // a chat attachment; duplicates waste model attention / 422 sometimes.
      refUrls = [...new Set(refUrls)]

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
          model = cfg.video_model || 'xai/grok-imagine-video/reference-to-video'
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

      // TEXT-ONLY AUTO-DETECT — ref-to-video with ZERO refs and no start
      // image = guaranteed 422 ("reference_image_urls: List should have at
      // least 1 item"). This is the pure-text path: user asks "bikin video X"
      // with nothing pinned and no upload. Switch to the SAME family's
      // text-to-video variant so style/cost expectations carry over.
      if (model.includes('reference-to-video') && refUrls.length === 0 && !finalImageUrl) {
        const t2vMap = {
          'xai/grok-imagine-video/reference-to-video': 'xai/grok-imagine-video/text-to-video',
          'bytedance/seedance-2.0/fast/reference-to-video': 'bytedance/seedance-2.0/text-to-video',
          'alibaba/happy-horse/reference-to-video': 'alibaba/happy-horse/text-to-video',
          'fal-ai/kling-video/v3/reference-to-video': 'fal-ai/kling-video/v3/standard/text-to-video',
          'fal-ai/kling-video/v2.5-turbo/pro/ref-to-video': 'fal-ai/kling-video/v3/standard/text-to-video',
        }
        model = t2vMap[model] || 'xai/grok-imagine-video/text-to-video'
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
        // Budget gate BEFORE submit — videos are the most expensive
        // calls in the app ($0.07-$0.28/dtk × duration). 10 unchecked
        // 10s seedance gens = $24 burned through god-mode chat alone.
        const vidProjected = estimateFalCost(model, input || {})
        const vidGate = await assertBudget(ctx.supabase, ctx.workspaceId, { projectedUsd: vidProjected })
        if (!vidGate.ok) return { type: 'error', error: vidGate.reason, gate: vidGate }

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
        // Mirror image_url to R2 if it exists + auto-retry on fal 422.
        // Grok i2v + some Kling variants sometimes 422 with "image_url:
        // Failed to download" even on R2 URLs — happens when source
        // URL has signed-query params that expire mid-request, or when
        // R2 CDN cache miss + fal's downloader bails fast. Mirroring
        // through R2 with fresh keys + cache-warm fixes it.
        async function submitOnce(inputToTry) {
          const r = await fetch(`https://queue.fal.run/${wireModel}`, {
            method: 'POST',
            headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(inputToTry),
          })
          const d = await r.json().catch(() => ({}))
          return { ok: r.ok, status: r.status, data: d }
        }

        // Multi-video path (count > 1) — parallel submits, skip inline
        // poll, return all queued at once. Same pattern as
        // gen_marketing_video_from_url.
        const reqCount = Math.max(1, Math.min(5, parseInt(count) || 1))
        if (reqCount > 1) {
          const results = await Promise.all(Array.from({ length: reqCount }, async (_, idx) => {
            try {
              const res = await submitOnce(input)
              if (!res.ok) {
                // "Failed to download" retry — re-host EVERY image input on
                // fal's own storage. r2.dev public dev-domain is rate-limited
                // by Cloudflare, so fal's downloader intermittently 429s on
                // attachments even though the URL opens fine in a browser.
                const errStr = JSON.stringify(res.data).toLowerCase()
                if (/failed to download|file_download_error|inaccessible/i.test(errStr) && (finalImageUrl || refUrls.length)) {
                  const startM = finalImageUrl ? await mirrorToFalStorageStrict(finalImageUrl, falKey) : null
                  const refsM = (await Promise.all(refUrls.map((u) => mirrorToFalStorageStrict(u, falKey)))).filter(Boolean)
                  const aliveStart = startM || refsM[0] || null
                  if (!aliveStart && refsM.length === 0) {
                    return { ok: false, idx, error: 'Semua gambar sumber gak bisa di-download (host mati) — re-upload ref-nya' }
                  }
                  const input2 = buildVideoInputForModel(model, {
                    motion_prompt, image_url: aliveStart || undefined,
                    image_urls: refsM.length ? refsM : undefined,
                    duration: dur, aspect_ratio: finalAr, resolution: cfg.resolution,
                  })
                  const retry = await submitOnce(input2)
                  if (!retry.ok) return { ok: false, idx, error: retry.data?.detail || `fal ${retry.status} (after fal-storage mirror retry)` }
                  return { ok: true, idx, request_id: retry.data?.request_id, status_url: retry.data?.status_url, response_url: retry.data?.response_url }
                }
                return { ok: false, idx, error: res.data?.detail || res.data?.error || `fal ${res.status}` }
              }
              return { ok: true, idx, request_id: res.data?.request_id, status_url: res.data?.status_url, response_url: res.data?.response_url }
            } catch (e) {
              return { ok: false, idx, error: String(e?.message || e) }
            }
          }))
          return {
            type: 'gen_video_multi_queued',
            count: reqCount,
            items: results.map((s) => s.ok ? {
              type: 'gen_video_queued',
              request_id: s.request_id, model: wireModel,
              status_url: s.status_url, response_url: s.response_url,
              ar: finalAr, duration: dur,
              motion: finalMotion, image_url: finalImageUrl,
              label: `Video ${s.idx + 1}/${reqCount}`,
              regen_payload: { motion_prompt, duration, image_url: finalImageUrl || image_url, ar, model: modelOverride, refs: refUrls.slice(0, 8) },
            } : { type: 'error', idx: s.idx, error: s.error }),
          }
        }

        // Single-video path (count=1) with mirror-retry on 422.
        let submitRes_ = await submitOnce(input)
        if (!submitRes_.ok) {
          const errStr = JSON.stringify(submitRes_.data).toLowerCase()
          if (/failed to download|file_download_error|inaccessible/i.test(errStr) && (finalImageUrl || refUrls.length)) {
            // Re-host every image input on fal storage and DROP the ones that
            // can't be fetched at all (dead hosts like old r2.ai-assist.me
            // refs) — resubmitting a dead URL just fails identically.
            const startM = finalImageUrl ? await mirrorToFalStorageStrict(finalImageUrl, falKey) : null
            const refsM = (await Promise.all(refUrls.map((u) => mirrorToFalStorageStrict(u, falKey)))).filter(Boolean)
            const aliveStart = startM || refsM[0] || null
            if (!aliveStart && refsM.length === 0) {
              throw new Error(`Semua gambar sumber gak bisa di-download (host mati / expired). URL bermasalah: ${(finalImageUrl || refUrls[0] || '').slice(0, 90)}... — re-upload ref/persona image-nya, yang lama nunjuk storage yang udah gak ada.`)
            }
            const input2 = buildVideoInputForModel(model, {
              motion_prompt, image_url: aliveStart || undefined,
              image_urls: refsM.length ? refsM : undefined,
              duration: dur, aspect_ratio: finalAr, resolution: cfg.resolution,
            })
            submitRes_ = await submitOnce(input2)
          }
          if (!submitRes_.ok) throw new Error(submitRes_.data?.detail || submitRes_.data?.error || `fal.ai ${submitRes_.status}`)
        }
        const submitData = submitRes_.data
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
          // Comprehensive URL extraction — fal models return different
          // shapes (video.url, videos[0].url, output.video.url, etc).
          // Same paths as /api/god-mode/gen-status.
          const url =
            done?.video?.url ||
            done?.video_url ||
            done?.output?.video?.url ||
            done?.output?.url ||
            done?.url ||
            (Array.isArray(done?.videos) && done.videos[0]?.url) ||
            null
          if (!url) {
            // fal returned COMPLETED but no video URL — usually means
            // content checker flagged silently OR validation issue
            // crept past queue. Surface raw payload so debug is possible.
            const tail = JSON.stringify(done).slice(0, 300)
            return { type: 'error', error: `fal completed without video URL — likely content checker rejection or input validation issue. Raw: ${tail}` }
          }

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
            regen_payload: { motion_prompt, duration, image_url: finalImageUrl || image_url, ar, model: modelOverride, refs: refUrls.slice(0, 8) },
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
          regen_payload: { motion_prompt, duration, image_url: finalImageUrl || image_url, ar, model: modelOverride, refs: refUrls.slice(0, 8) },
        }
      } catch (e) {
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
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
        const html = await fetchUrlAsHtml(url, { cookie: ctx.req?.headers?.get?.('cookie') || '' })
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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ URL → Image (scrape + gen single image) ──────────────────────
  gen_image_from_url: {
    description: 'Generate a SINGLE marketing IMAGE from a product URL. Scrapes product, gens styled image using the product photo as reference. Use when user pastes URL + asks for IMAGE: "bikin foto/poster dari URL", "listing photo dari link", "image saja jangan video". MODEL CHOICE: if user wants TEXT/copy/CTA/ajakan/kata-kata ON the image (poster ads, sale banner, promo with headline), PASS model="openai/gpt-image-2/edit" — gpt-image-2 is the only model that renders legible text consistently. Default nano-banana is great for clean product shots but butchers text. URL fallback: auto-resolves from recent messages. **IMPORTANT**: if user uploaded image to chat instead of URL, use gen_image (not this).',
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
        const html = await fetchUrlAsHtml(url, { cookie: ctx.req?.headers?.get?.('cookie') || '' })
        const extractPrompt = `Extract product info from this e-commerce page for a marketing image. The page content has TWO blocks:
- Top: STRUCTURED DATA (OG_META + JSON_LD_PRODUCT) — trust this FIRST for reliable title + image.
- Bottom: HTML BODY (fallback) — often empty shell on JS-SPAs (Shopee, Sociolla, Tokopedia).

Return JSON only:
{
  "title": "product name (prefer og:title / JSON-LD name)",
  "image_url": "best primary product image URL (prefer og:image / JSON-LD image — absolute)",
  "image_prompt": "detailed visual prompt in English for a marketing/listing photo of the product, matching theme '${finalTheme}'. CRITICAL: bake the user's literal intent into the prompt — if they asked for text/copy/CTA/captions/ajakan/kata-kata on the image, EXPLICITLY include 'with on-image text/headline reading X', 'CTA button reading Y', 'tagline visible on poster', etc. Describe composition, lighting, mood, props. 3-4 sentences if user wanted text overlays."
}

USER ORIGINAL REQUEST (preserve literally — bake into image_prompt verbatim if it mentions text/copy/CTA/ajakan/kata-kata):
${(ctx.lastUserText || '').slice(0, 500)}

PAGE CONTENT:
${html.slice(0, 22000)}`

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

        // Mirror scraped image to R2 — same reason as gen_marketing_video_from_url.
        // Source CDNs (Sociolla, Tokopedia, etc) hotlink-block fal's fetcher.
        p.image_url = await mirrorToR2(p.image_url, 'scraped-products')

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

        // Budget gate before falCall — url_marketing fires 1 image gen
        // per call, gate guards against bulk-runs blowing daily limit.
        const urlImgProjected = estimateFalCost(imageModel, input || {})
        const urlImgGate = await assertBudget(ctx.supabase, ctx.workspaceId, { projectedUsd: urlImgProjected })
        if (!urlImgGate.ok) return { type: 'error', error: urlImgGate.reason, gate: urlImgGate }

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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ URL → Marketing Video (scrape + gen video in one shot) ────────
  gen_marketing_video_from_url: {
    description: 'PRIMARY TOOL when user pastes a product URL AND asks for VIDEO with specific params (duration / theme / model / count / etc). Scrapes URL, extracts product, gens N videos at requested duration with requested model. Returns the video(s) directly. Use this when user says e.g. "bikin 2 video X detik dari URL ini, tema Y, pake model Z" or "buatin gua 3 video promo dari link ini". COUNT detection: if user says "2 video" / "3 video promo" / "bikinin 5 variasi", pass count=N (max 5). Returns array of generated videos. If user references "link itu" / "URL diatas" without pasting again, the URL auto-resolves from earlier messages.',
    handler: async ({ url, duration, theme, model: modelOverride, ar, count = 1 }, ctx) => {
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
        const html = await fetchUrlAsHtml(url, { cookie: ctx.req?.headers?.get?.('cookie') || '' })
        const extractPrompt = `Extract product info from this e-commerce page to build a marketing video. The page content has TWO blocks:
- Top: STRUCTURED DATA (OG_META + JSON_LD_PRODUCT) — extracted before HTML strip. Trust this FIRST. og:image / og:title / og:description / JSON-LD image+name+description are reliable.
- Bottom: HTML BODY (fallback) — visible markup. Use only if structured data is missing.

For JS-rendered SPAs (Shopee, Tokopedia, Sociolla, IG) the HTML body is often a near-empty shell — structured data is the ONLY reliable source.

Return JSON only:
{
  "title": "product name (prefer og:title / JSON-LD name)",
  "image_url": "best primary product image URL (prefer og:image / JSON-LD image — absolute URL)",
  "key_features": ["feature 1", "feature 2", "feature 3"],
  "motion_prompt": "${finalDuration}s video motion description in English, matching theme '${finalTheme}'. CRITICAL: if user's original request mentions specific things they want (ajakan/CTA/text overlay/scene transitions/specific actions/voiceover style/mood), BAKE THOSE LITERALLY into motion_prompt — don't abstract them away. Describe what happens, camera moves, mood. Be cinematic. Bake in product showcase. Single block of text, no timestamps."
}

USER ORIGINAL REQUEST (preserve literally — bake into motion_prompt verbatim):
${(ctx.lastUserText || '').slice(0, 500)}

If you cannot find image_url anywhere, return image_url=null and the caller will surface a clearer error.

PAGE CONTENT:
${html.slice(0, 22000)}`

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

        // STEP 1b — Mirror scraped image to R2. Sociolla, Tokopedia, IG CDN
        // etc block hotlinking — fal would get 403/404 trying to download.
        // R2 mirror = always CORS-friendly, no Referer requirement.
        const mirroredImageUrl = await mirrorToR2(p.image_url, 'scraped-products')
        p.image_url = mirroredImageUrl

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
        // Budget gate — multiplied by count for multi-video requests.
        const reqCount = Math.max(1, Math.min(5, parseInt(count) || 1))
        const urlVidProjected = estimateFalCost(videoModel, videoInput || {}) * reqCount
        const urlVidGate = await assertBudget(ctx.supabase, ctx.workspaceId, { projectedUsd: urlVidProjected })
        if (!urlVidGate.ok) return { type: 'error', error: urlVidGate.reason, gate: urlVidGate }

        // Canonicalize before queue calls — see src/lib/fal-paths.js
        const wireVideoModel = canonicalFalPath(videoModel)

        // ── MULTI-VIDEO PATH ──
        // User asked "bikin N video" -> submit N parallel gen jobs and
        // return all queued at once. Skip the 30s inline poll (would
        // 30s*N exceed Vercel function timeout). Frontend polls each
        // queued message independently.
        if (reqCount > 1) {
          const submits = await Promise.all(Array.from({ length: reqCount }, async (_, idx) => {
            try {
              const r = await fetch(`https://queue.fal.run/${wireVideoModel}`, {
                method: 'POST',
                headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(videoInput),
              })
              const d = await r.json().catch(() => ({}))
              if (!r.ok) return { ok: false, idx, error: d?.detail || d?.error || `fal ${r.status}` }
              return {
                ok: true, idx,
                request_id: d?.request_id, status_url: d?.status_url, response_url: d?.response_url,
              }
            } catch (e) {
              return { ok: false, idx, error: String(e?.message || e) }
            }
          }))
          return {
            type: 'gen_video_multi_queued',
            count: reqCount,
            items: submits.map((s) => s.ok ? {
              type: 'gen_video_queued',
              request_id: s.request_id, model: wireVideoModel,
              status_url: s.status_url, response_url: s.response_url,
              ar: finalAr, duration: finalDuration,
              motion: finalMotion, image_url: p.image_url,
              label: `Video ${s.idx + 1}/${reqCount}`,
              regen_payload: { url, duration: finalDuration, theme: finalTheme, model: modelOverride, ar: finalAr },
            } : { type: 'error', idx: s.idx, error: s.error }),
          }
        }

        // ── SINGLE-VIDEO PATH (original flow) ──
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
          const videoUrl =
            done?.video?.url ||
            done?.video_url ||
            done?.output?.video?.url ||
            done?.output?.url ||
            done?.url ||
            (Array.isArray(done?.videos) && done.videos[0]?.url) ||
            null
          if (!videoUrl) {
            // Fal sometimes returns 'COMPLETED' status but no URL in the
            // payload when the actual gen failed (e.g. 422 input validation
            // that crept past the queue). Surface the raw payload tail so
            // user (and future debugger) can see what came back.
            const tail = JSON.stringify(done).slice(0, 300)
            return { type: 'error', error: `fal completed without video URL — likely input validation issue. Raw response: ${tail}` }
          }
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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Video analyzer ────────────────────────────────────────────────
  analyze_reference_video: {
    description: 'Analyze a reference video to extract style, camera, mood, pacing, suggested replication strategy. Use when user uploads a video as attachment OR provides a URL (YouTube native; TikTok/IG only if downloaded mp4 uploaded). CRITICAL: if user uploaded a video file, DO NOT pass video_url — leave it empty so server auto-picks the attachment. NEVER infer a TikTok/IG URL from filename hints like "ssstik.io_xxx.mp4" or "snaptik_xxx.mp4" — those are LOCAL FILES, not URLs. Use the attachment bytes directly.',
    handler: async ({ video_url, attachment_index }, ctx) => {
      // Resolve source — explicit tool_input.video_url first, then recent
      // attachment, then any URL pasted earlier in the conversation
      // ── Source resolution (PRIORITY ORDER) ──
      // Original priority was: tool_input.video_url > attachment > recentUrls.
      // But agent kept hallucinating TikTok URLs from filename hints
      // (e.g. "ssstik.io_@username.mp4" -> agent passes
      // "https://tiktok.com/@username/..." as video_url even though the
      // ACTUAL VIDEO BYTES are right there as an R2 attachment). My
      // platform-block then refused, wasting the attachment.
      // New priority: VIDEO ATTACHMENT ALWAYS WINS if present. Agent
      // can only override with URL when no video uploaded.
      let urlToAnalyze = null
      const videoAtt = Array.isArray(ctx.recentAttachments)
        ? ctx.recentAttachments.find((a) => a?.type === 'video' && a?.url)
        : null
      if (videoAtt) {
        urlToAnalyze = videoAtt.url
      } else if (video_url) {
        urlToAnalyze = video_url
      } else if (Array.isArray(ctx.recentAttachments)) {
        const att = ctx.recentAttachments[parseInt(attachment_index) || 0]
        if (att?.url) urlToAnalyze = att.url
      }
      if (!urlToAnalyze && Array.isArray(ctx.recentUrls) && ctx.recentUrls.length > 0) {
        urlToAnalyze = ctx.recentUrls[0]
      }
      if (!urlToAnalyze) return { type: 'error', error: 'gak nemu URL video atau attachment buat dianalisis. Paste link video atau upload langsung.' }

      // ── ROUTE BY URL KIND ──
      // Gemini 2.5 supports 3 video input shapes — we route to the
      // RIGHT one per source so the model sees actual frames, never
      // hallucinates from URL text alone:
      //
      //   1. YouTube URL → Gemini's NATIVE file_data part with
      //      file_uri="<youtube url>" + mime_type="video/*". Gemini
      //      fetches + analyzes the public video itself. Up to 8 hours
      //      of YouTube per day on free tier; works on all public
      //      youtube.com / youtu.be URLs.
      //   2. Direct video file URL <20MB → inline_data with bytes
      //      (download → base64). Works for R2 / Supabase storage /
      //      public mp4 hosts.
      //   3. TikTok / Instagram → block. Gemini's file_data only
      //      supports YouTube + Google Cloud Storage URIs; those
      //      platforms CORS-block direct fetch too.
      const isYouTube = /youtube\.com|youtu\.be/i.test(urlToAnalyze)
      const isTikTok = /tiktok\.com/i.test(urlToAnalyze)
      const isInstagram = /instagram\.com/i.test(urlToAnalyze)

      if (isTikTok || isInstagram) {
        const platform = isTikTok ? 'TikTok' : 'Instagram'
        return {
          type: 'error',
          error: `Gemini API gak support ${platform} URL langsung (cuma YouTube + direct mp4 URLs). Workaround: download videonya pake snaptik / ssstik, upload mp4 ke chat ini lewat 📎, lalu suruh gua analisis lagi.`,
        }
      }

      const analyzePrompt = `Analyze the attached video reference and extract its production strategy so the user can replicate similar content. Reply in Bahasa Indonesia. Base your analysis on what you actually SEE in the video frames, not assumptions from the URL.

Return JSON only with these fields:
{
  "style": "art / visual style (e.g. UGC iPhone handheld, 2D storybook, cinematic anamorphic)",
  "camera": "primary camera moves used (e.g. medium shot static, push-in, handheld POV)",
  "mood": "emotional tone (e.g. authentic casual, dramatic tense, lighthearted comedy)",
  "pacing": "edit pace (e.g. 3 beats in 15s, slow contemplative, fast cuts)",
  "character_notes": "character appearance and behavior summary based on what you see",
  "suggested_model": "which fal.ai model is best for replicating (e.g. Grok i2v + iPhone preset, Seedance ref-to-video)",
  "replication_strategy": "step-by-step strategy to replicate this style in 1-2 paragraphs"
}`

      try {
        let videoPart
        let mediaResolution = null
        if (isYouTube) {
          // YouTube → file_data with the URL. Gemini fetches natively.
          // mime_type 'video/*' lets the API auto-detect format.
          // mediaResolution: 'low' (360p) makes Gemini process ~3-4x
          // faster + uses ~5x fewer tokens, critical to stay under the
          // Vercel function timeout (60s Hobby / 120s Pro). Quality is
          // still plenty for the kind of metadata we're extracting
          // (style/camera/mood/pacing don't need 1080p frames).
          videoPart = { file_data: { mime_type: 'video/*', file_uri: urlToAnalyze } }
          // Gemini's generation_config.media_resolution is an ENUM, not
          // a plain string. Sending 'low' returns 400 Invalid Value;
          // the API wants the full enum name MEDIA_RESOLUTION_LOW.
          // Same for MEDIUM / HIGH variants if we ever bump quality.
          mediaResolution = 'MEDIA_RESOLUTION_LOW'
        } else {
          // Direct video URL — fetch + inline. Check size first.
          const head = await fetch(urlToAnalyze, { method: 'HEAD' })
          const sizeHeader = head.headers.get('content-length')
          const sizeMb = sizeHeader ? parseInt(sizeHeader) / 1024 / 1024 : null
          if (sizeMb != null && sizeMb > 20) {
            return {
              type: 'error',
              error: `Video ${sizeMb.toFixed(1)}MB — Gemini inline limit 20MB. Trim videonya dulu atau upload yang lebih kecil.`,
            }
          }
          const videoRes = await fetch(urlToAnalyze)
          if (!videoRes.ok) {
            return { type: 'error', error: `Gagal fetch video (${videoRes.status}). Cek URL valid + accessible.` }
          }
          const videoBuf = Buffer.from(await videoRes.arrayBuffer())
          const mimeType = head.headers.get('content-type') || 'video/mp4'
          videoPart = { inline_data: { mime_type: mimeType, data: videoBuf.toString('base64') } }
        }

        // mediaResolution 'low' bakes into generationConfig only when set —
        // for inline_data (R2 mp4) it doesn't apply, only for file_data
        // YouTube fetches.
        const generationConfig = {
          temperature: 0.4,
          // Was tightened 3000→1500 ("analysis fits") — it didn't: detailed
          // analyses (style + hooks + shot breakdown in Bahasa) truncated
          // mid-JSON → "balik bukan JSON valid". 6000 gives real headroom.
          maxOutputTokens: 6000,
          ...(mediaResolution ? { mediaResolution } : {}),
        }
        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: analyzePrompt }, videoPart] }],
          ...generationConfig,
        })
        return { type: 'video_analysis', source_url: urlToAnalyze, ...(result.parsed || {}) }
      } catch (e) {
        const msg = String(e?.message || e)
        // Surface timeout-specific guidance so user knows next step.
        if (/timeout|deadline|504|exceeded/i.test(msg)) {
          return {
            type: 'error',
            error: `Gemini analyze YouTube kelamaan (Vercel function limit). Workaround: download videonya pake ssstik.io / yt-dlp, upload mp4 ke chat lewat 📎 — analyze dari upload jauh lebih cepat (file lokal di R2, gak perlu Gemini fetch YouTube).`,
          }
        }
        return { type: 'error', error: `Analisis gagal: ${msg}. Coba upload video langsung lewat 📎.` }
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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
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
        const massProductDirective = buildProductFidelityDirective(ctx.activeProduct)
        const batchResults = await Promise.all(batch.map(async (v) => {
          const productHint = ctx.activeProduct ? `${ctx.activeProduct.label}` : 'the product'
          // Append the full fidelity directive so every variant gets the
          // same product spec — without this, 20 variants drift wildly
          // (different colors, wrong port counts, mangled label text).
          const prompt = `${v.hook} of ${productHint} ${v.scene}, professional photography, ${cfg.resolution === '1080p' ? 'highly detailed' : 'clean composition'}${massProductDirective}`
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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Viral Clip Cutter ────────────────────────────────────────────
  viral_clip_cut: {
    description: 'Cut a long video into platform-target clips (TikTok 60s, Reels 90s, Shorts 60s). Use when user asks "potong video buat TikTok", "bikin reels dari video ini", "cut clip 60 detik mulai detik 30", "convert ke shorts format". Provide video_url + clips array [{ start, duration | preset }]. Preset auto-fills duration: tiktok/shorts=60s, reels/ig=90s. DO NOT use with YouTube/TikTok/IG URLs — browser CORS-blocks those, fetch returns 403. User must download + upload mp4 first.',
    handler: async ({ video_url, clips, result_id }, ctx) => {
      if (!video_url) {
        // Auto-resolve from chat attachments OR most-recent video result
        const att = (ctx.recentAttachments || []).find((a) => a.type === 'video' && a.url)
        if (att) video_url = att.url
      }
      if (!video_url) return { type: 'error', error: 'video_url required — upload video ke chat atau kasih URL' }

      // Block YouTube/TikTok/IG URLs — browser ffmpeg.wasm fetches via
      // standard fetch() which CORS-blocks those platforms (returns 403).
      // Same root cause as analyze_reference_video URL fetch failures.
      // Cut only works on direct-CORS-allowed video URLs (R2 / Supabase
      // storage / public mp4 hosts).
      if (/youtube\.com|youtu\.be|tiktok\.com|instagram\.com/i.test(video_url)) {
        const platform = /youtube/i.test(video_url) ? 'YouTube'
          : /tiktok/i.test(video_url) ? 'TikTok' : 'Instagram'
        return {
          type: 'error',
          error: `Sori bro, gak bisa cut langsung dari ${platform} URL — browser di-block CORS jadi fetch ke server ${platform} balik 403. Workaround: download videonya pake ssstik.io / yt-dlp / snaptik, upload mp4 ke chat ini lewat 📎, lalu suruh gua "potong 15 detik" lagi. Setelah upload, file ada di R2 storage yang CORS-friendly.`,
        }
      }
      if (!Array.isArray(clips) || clips.length === 0) {
        // Sensible default — one 60s clip from the start
        clips = [{ start: 0, duration: 60, preset: 'tiktok', label: 'TikTok cut' }]
      }

      // ── "Akalin" approach ── Cutting happens CLIENT-SIDE via ffmpeg.wasm
      // (see src/lib/clip-cutter-client.js). The tool just validates +
      // normalizes the request, the frontend renderer runs the actual
      // cuts then uploads results to R2.
      // Why client-side: Vercel has no ffmpeg, and routing through v2 HF
      // Space couples v3's uptime to v2's. Browser ffmpeg.wasm runs on
      // the user's machine for free.
      return {
        type: 'viral_clip_pending',
        source: video_url,
        clips: clips.map((c, i) => ({
          start: parseFloat(c.start) || 0,
          duration: parseFloat(c.duration) || (c.preset === 'reels' || c.preset === 'ig' ? 90 : 60),
          preset: c.preset || null,
          label: c.label || `Clip ${i + 1}`,
        })),
        result_id: result_id || null,
      }
    },
  },

  // ─ Continue shot — next image/video in a sequence ────────────────
  continue_shot: {
    description: 'Generate the NEXT shot in a sequence based on the most recent gen_image / gen_video in this conversation. Same character/style/setting carried over, only the action/moment advances. Use when user says "next shot", "lanjutin", "shot 2", "continue dari yang tadi", "shot berikutnya tapi dia lagi X". Optional `next_action` describes what the new shot shows. Optional `start_frame_url`: if the user message says a last-frame image of the previous shot is attached, pass that attachment URL here.',
    handler: async ({ next_action, kind, start_frame_url }, ctx) => {
      // Find most recent gen result in conversation history. Cover all
      // gen-producing types — original bug: only checked gen_image_result
      // and gen_video_result so multi-queued / url-marketing / still-
      // queued shots were invisible and continue_shot returned "no gen
      // found" even right after a successful gen.
      const allMsgs = ctx.messages || []
      let lastGen = null
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        const m = allMsgs[i]
        const r = m?.result
        if (!r) continue
        // Single result types — direct match
        if (r.type === 'gen_image_result' || r.type === 'gen_video_result') {
          lastGen = r
          break
        }
        // Queued (still polling) — agent can continue based on its
        // recorded regen_payload even before resolution
        if (r.type === 'gen_video_queued' && r.regen_payload) {
          lastGen = { ...r, type: 'gen_video_result' } // normalize
          break
        }
        // Multi-queued — pick first item (most recently submitted shot)
        if (r.type === 'gen_video_multi_queued' && Array.isArray(r.items)) {
          const firstOk = r.items.find((it) => it?.type === 'gen_video_queued' && it.regen_payload)
          if (firstOk) {
            lastGen = { ...firstOk, type: 'gen_video_result' }
            break
          }
        }
      }
      // FALLBACK — the Continue button always attaches the previous shot's
      // last frame (or the source image) + may pass start_frame_url. If the
      // history scan found nothing (reloaded conversation drops the slim
      // `result`, or the prior gen came from a surface that didn't tag it),
      // treat that attached image AS the source. This is what the user is
      // literally pointing at, so it's the most reliable anchor anyway.
      if (!lastGen) {
        const anchorImg = (start_frame_url && /^https?:/.test(start_frame_url))
          ? start_frame_url
          : (ctx.recentAttachments || []).find((a) => a.type === 'image' && a.url)?.url
        if (anchorImg) {
          lastGen = {
            type: 'gen_image_result',
            url: anchorImg,
            regen_payload: { prompt: ctx.lastUserText || '', ar: ctx.activeConfig?.ar, refs: [] },
          }
        }
      }
      if (!lastGen) {
        return { type: 'error', error: 'Belum ada gen result di chat ini buat dilanjutin, dan gak ada gambar yang ke-attach. Bikin shot pertama dulu (gen_image / gen_video) atau upload frame-nya via 📎.' }
      }

      const isVideoSource = lastGen.type === 'gen_video_result'
      // Default: continue in the SAME medium. User can override via `kind`
      // (e.g. last was image, user wants video continuation -> animate it).
      const targetKind = kind || (isVideoSource ? 'video' : 'image')

      // Pull the source prompt from regen_payload (where gen_image/gen_video
      // stashed the prompt + ar + duration + model at gen time).
      const srcPayload = lastGen.regen_payload || {}
      const sourcePrompt =
        srcPayload.prompt ||                // gen_image stashed under prompt
        srcPayload.motion_prompt ||         // gen_video stashed under motion_prompt
        ''
      if (!sourcePrompt) {
        return { type: 'error', error: 'Gak nemu source prompt dari shot sebelumnya — coba bikin shot baru langsung pake gen_image / gen_video.' }
      }

      // Build continuation prompt via LLM — extracts the durable elements
      // (character, setting, style, lighting) + replaces only the action.
      // Without this step, naive prompt concat creates internal contradictions
      // ("she sips coffee" + "she dances" = confused model).
      const continuationBuilder = `Lo lagi bantu user bikin shot LANJUTAN dari shot sebelumnya. Tugas: rewrite source prompt jadi versi shot baru dengan SAME character/wardrobe/setting/style/lighting tapi advance action/moment-nya.

SOURCE PROMPT (shot sebelumnya):
${sourcePrompt.slice(0, 800)}

NEXT ACTION yang user mau (kalo ada): ${next_action || '(user gak specify — pilih moment natural berikutnya dalam scene yang sama, mis: kalo dia pegang cup -> sekarang dia minum / senyum / liat ke arah lain)'}

Output JSON only:
{
  "new_prompt": "rewritten shot prompt in English, single paragraph, preserves character + setting + style but with new action",
  "continuity_note": "1 line in Bahasa Indonesia describing what changed vs source"
}`

      let newPrompt = sourcePrompt
      let continuityNote = ''
      try {
        const built = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: continuationBuilder }] }],
          temperature: 0.7,
          maxOutputTokens: 800,
        })
        if (built.parsed?.new_prompt) newPrompt = built.parsed.new_prompt
        continuityNote = built.parsed?.continuity_note || ''
      } catch (e) {
        // LLM rewrite failed -> fall back to naive concat; better than nothing.
        newPrompt = `${sourcePrompt}\n\nNext moment: ${next_action || 'continue the scene naturally'}`
      }

      // ── Continuity anchors ──
      // The single biggest anti-drift lever: start the next shot FROM the
      // previous shot's actual pixels, and re-attach the refs the source
      // gen used (persona/product/uploads) so identity doesn't reset.
      //   anchor priority: explicit start_frame_url (client extracts the
      //   video's last frame and attaches it) > image attachment in the
      //   continue message > source image itself (image sources).
      const srcRefs = Array.isArray(srcPayload.refs) ? srcPayload.refs.filter(Boolean) : []
      let anchorUrl = (start_frame_url && /^https?:/.test(start_frame_url)) ? start_frame_url : null
      if (!anchorUrl) {
        const attImg = (ctx.recentAttachments || []).find((a) => a.type === 'image' && a.url)
        if (attImg) anchorUrl = attImg.url
      }
      if (!anchorUrl && !isVideoSource) anchorUrl = lastGen.url

      if (anchorUrl) {
        newPrompt += `\n\nCONTINUITY: this is the NEXT shot of the SAME scene. The first reference image is the final frame of the previous shot — begin from that exact pose, setting and lighting. Keep character identity, wardrobe, color grade and art style IDENTICAL to it. Only the action advances.`
      }

      // VIDEO → VIDEO continuation: Grok EXTEND-VIDEO continues the ACTUAL
      // footage (pixels + motion + audio) natively — strictly stronger than
      // re-generating from an extracted last frame. Frame-anchor path below
      // stays as the fallback when extend fails or source URL is missing.
      if (isVideoSource && targetKind === 'video' && lastGen.url) {
        const ext = await TOOLS.extend_video.handler({
          prompt: newPrompt,
          video_url: lastGen.url,
          duration: srcPayload.duration,
        }, ctx)
        if (ext && ext.type !== 'error') {
          ext._continuation_of = lastGen.result_id || null
          ext._continuity_note = continuityNote || 'Lanjutan langsung dari footage sebelumnya (extend)'
          return ext
        }
        // extend failed — fall through to start-frame anchoring below
      }

      // Dispatch to gen_image or gen_video tool internally — re-use all
      // their existing logic (budget gate, refs, fidelity directive, etc).
      // This keeps continue_shot as a thin orchestrator, not a duplicate
      // gen path that would drift out of sync with the main tools.
      const targetTool = targetKind === 'video' ? TOOLS.gen_video : TOOLS.gen_image
      const toolInput = targetKind === 'video'
        ? {
            motion_prompt: newPrompt,
            duration: srcPayload.duration,
            ar: srcPayload.ar,
            model: srcPayload.model,
            // Start frame: previous shot's last frame (or the source image
            // itself when continuing from an image). Falls back to the source
            // gen's own start frame as a weaker-but-better-than-nothing anchor.
            image_url: anchorUrl || (!isVideoSource ? lastGen.url : srcPayload.image_url),
            extra_ref_urls: srcRefs,
          }
        : {
            prompt: newPrompt,
            ar: srcPayload.ar,
            model: srcPayload.model,
            // Anchor frame rides as the FIRST ref so edit-models lock onto it.
            extra_ref_urls: [anchorUrl, ...srcRefs].filter(Boolean),
          }
      const result = await targetTool.handler(toolInput, ctx)
      if (result && result.type !== 'error') {
        result._continuation_of = lastGen.result_id || null
        result._continuity_note = continuityNote
      }
      return result
    },
  },

  // ─ AI Video Edit — transform an existing video via text instruction ─
  edit_video: {
    description: 'EDIT/transform an EXISTING video with a text instruction (AI video edit / reprompt). Use when user says "edit video ini", "benerin video barusan", "ganti background/warna/mood video itu", "colorize", "ubah video jadi X", "videonya kureng, coba bikin Y" — referring to a video already generated in this chat or attached. Inputs: edit_prompt (English instruction, what to change), optional video_url (defaults to attached video or the most recent video result in this conversation). Model auto-picked: Happy Horse video-edit when reference images are involved (pinned product/persona or image attachments — identity/product-anchored edit), else Grok edit-video (cheap global edit ~$0.08/s).',
    handler: async ({ edit_prompt, video_url }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      let finalPrompt = String(edit_prompt || '').trim()
      if (finalPrompt.length < 3 && ctx.lastUserText) finalPrompt = ctx.lastUserText
      if (finalPrompt.length < 3) {
        return { type: 'error', error: 'Edit prompt kosong. Contoh: "ganti background jadi pantai sunset, pertahankan karakter".' }
      }

      // Resolve source video: explicit > attached video > last video result
      // in this conversation (same scan continue_shot uses).
      let srcVideo = (video_url && /^https?:/.test(video_url)) ? video_url : null
      if (!srcVideo) {
        const attVid = (ctx.recentAttachments || []).find((a) => a.type === 'video' && a.url)
        if (attVid) srcVideo = attVid.url
      }
      if (!srcVideo) {
        for (let i = (ctx.messages || []).length - 1; i >= 0; i--) {
          const r = ctx.messages[i]?.result
          if (r?.type === 'gen_video_result' && r.url) { srcVideo = r.url; break }
        }
      }
      if (!srcVideo) {
        return { type: 'error', error: 'Gak nemu video buat di-edit. Upload videonya via 📎 atau generate dulu, baru bilang "edit video ini: ..."' }
      }

      // Refs (image attachments + pinned product/persona) decide the model:
      // refs present → Happy Horse video-edit (anchored edit, keeps identity);
      // none → Grok edit-video (3.5x cheaper, global transforms).
      const refUrls = []
      for (const att of ctx.recentAttachments || []) {
        if (att.type === 'image' && att.url) refUrls.push(att.url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)
      const model = refUrls.length > 0 ? 'alibaba/happy-horse/video-edit' : 'xai/grok-imagine-video/edit-video'

      // Product fidelity — same anti-drift anchor as gen tools.
      const editProductDirective = buildProductFidelityDirective(ctx.activeProduct)
      if (editProductDirective) finalPrompt += editProductDirective

      let input
      try {
        input = buildVideoEditInput(model, {
          prompt: finalPrompt,
          video_url: srcVideo,
          reference_image_urls: refUrls,
          resolution: ctx.activeConfig?.resolution,
        })
      } catch (e) {
        return { type: 'error', error: e.message }
      }

      try {
        // Budget gate — duration unknown until fal probes the input video;
        // assume 10s worst case for the pre-check.
        const projected = estimateFalCost(model, { ...input, duration: 10 })
        const gate = await assertBudget(ctx.supabase, ctx.workspaceId, { projectedUsd: projected })
        if (!gate.ok) return { type: 'error', error: gate.reason, gate }

        const wireModel = canonicalFalPath(model)
        const r = await fetch(`https://queue.fal.run/${wireModel}`, {
          method: 'POST',
          headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        let d = await r.json().catch(() => ({}))
        if (!r.ok) {
          // file_download_error retry — same r2.dev rate-limit issue as gen.
          const errStr = JSON.stringify(d).toLowerCase()
          if (/failed to download|file_download_error|inaccessible/i.test(errStr)) {
            const mirroredVideo = await mirrorToFalStorage(srcVideo, falKey)
            const mirroredRefs = await Promise.all(refUrls.map((u) => mirrorToFalStorage(u, falKey)))
            const input2 = buildVideoEditInput(model, {
              prompt: finalPrompt, video_url: mirroredVideo,
              reference_image_urls: mirroredRefs, resolution: ctx.activeConfig?.resolution,
            })
            const retry = await fetch(`https://queue.fal.run/${wireModel}`, {
              method: 'POST',
              headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(input2),
            })
            d = await retry.json().catch(() => ({}))
            if (!retry.ok) throw new Error(d?.detail ? JSON.stringify(d.detail).slice(0, 300) : `fal ${retry.status} (after mirror retry)`)
          } else {
            throw new Error(d?.detail ? JSON.stringify(d.detail).slice(0, 300) : d?.error || `fal ${r.status}`)
          }
        }
        const requestId = d?.request_id
        if (!requestId) throw new Error('no request_id from fal')

        // Return queued shape — the existing GenVideoQueued poller UI handles
        // status checks + result save, no new frontend renderer needed.
        return {
          type: 'gen_video_queued',
          request_id: requestId,
          model: wireModel,
          status_url: d?.status_url,
          response_url: d?.response_url,
          ar: ctx.activeConfig?.ar || '9:16',
          duration: null,
          motion: finalPrompt,
          image_url: null,
          refs: refUrls,
          persona_id: ctx.activePersona?.id || null,
          regen_payload: { motion_prompt: edit_prompt, image_url: null, model, refs: refUrls.slice(0, 8) },
          _edit_of: srcVideo,
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ Extend Video — natively continue existing footage ──────────────
  extend_video: {
    description: 'EXTEND an existing video — natively continues the ACTUAL footage with new motion (Grok extend-video). Use when user says "panjangin videonya", "terusin videonya X detik lagi", "extend", "tambahin durasi". Inputs: prompt (English — what happens in the extension), optional video_url (defaults to attached video or last video result in chat), optional duration (seconds to ADD, 5-15). Also used internally by continue_shot for video continuation.',
    handler: async ({ prompt, video_url, duration }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      let finalPrompt = String(prompt || '').trim()
      if (finalPrompt.length < 3 && ctx.lastUserText) finalPrompt = ctx.lastUserText
      if (finalPrompt.length < 3) return { type: 'error', error: 'Prompt kosong — bilang kelanjutannya ngapain.' }

      let srcVideo = (video_url && /^https?:/.test(video_url)) ? video_url : null
      if (!srcVideo) {
        const attVid = (ctx.recentAttachments || []).find((a) => a.type === 'video' && a.url)
        if (attVid) srcVideo = attVid.url
      }
      if (!srcVideo) {
        for (let i = (ctx.messages || []).length - 1; i >= 0; i--) {
          const r = ctx.messages[i]?.result
          if (r?.type === 'gen_video_result' && r.url) { srcVideo = r.url; break }
        }
      }
      if (!srcVideo) return { type: 'error', error: 'Gak nemu video buat di-extend. Upload via 📎 atau generate dulu.' }

      const model = 'xai/grok-imagine-video/extend-video'
      const input = buildVideoEditInput(model, { prompt: finalPrompt, video_url: srcVideo, duration })

      try {
        const projected = estimateFalCost(model, { ...input })
        const gate = await assertBudget(ctx.supabase, ctx.workspaceId, { projectedUsd: projected })
        if (!gate.ok) return { type: 'error', error: gate.reason, gate }

        const wireModel = canonicalFalPath(model)
        const submit = async (body) => {
          const r = await fetch(`https://queue.fal.run/${wireModel}`, {
            method: 'POST',
            headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }
        }
        let res = await submit(input)
        if (!res.ok) {
          const errStr = JSON.stringify(res.data).toLowerCase()
          if (/failed to download|file_download_error|inaccessible/i.test(errStr)) {
            const mirrored = await mirrorToFalStorageStrict(srcVideo, falKey)
            if (!mirrored) return { type: 'error', error: `Video sumber gak bisa di-download (host mati): ${srcVideo.slice(0, 80)}...` }
            res = await submit(buildVideoEditInput(model, { prompt: finalPrompt, video_url: mirrored, duration }))
          }
          if (!res.ok) return { type: 'error', error: res.data?.detail ? JSON.stringify(res.data.detail).slice(0, 300) : `fal ${res.status}` }
        }
        if (!res.data?.request_id) return { type: 'error', error: 'no request_id from fal' }
        return {
          type: 'gen_video_queued',
          request_id: res.data.request_id,
          model: wireModel,
          status_url: res.data.status_url,
          response_url: res.data.response_url,
          ar: ctx.activeConfig?.ar || '9:16',
          duration: parseInt(duration) || 10,
          motion: finalPrompt,
          image_url: null,
          refs: [],
          persona_id: ctx.activePersona?.id || null,
          regen_payload: { motion_prompt: finalPrompt, image_url: null, model, refs: [] },
          _extend_of: srcVideo,
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
        // SPA shell detected — page has no embeddable product data
        // (Sociolla, Shopee, Tokopedia, Lazada modern UI all do this).
        // Surface actionable workaround instead of generic "extract failed".
        if (e.isSpaShell) {
          return {
            type: 'error',
            error: `Site ${e.host} adalah SPA (single-page app) — product data load lewat JavaScript setelah halaman render, gak ada di HTML response. Server-side scrape gak bisa dapet info. 3 workaround: (1) right-click product photo di browser → "Copy image address" → paste URL gambar itu (bukan URL halaman) ke chat ini. (2) Screenshot product photo → upload via 📎. (3) Copy text deskripsi produk + paste manual + upload screenshot.`,
          }
        }
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
  - Video model: ${cfg.video_model || 'xai/grok-imagine-video/reference-to-video'}
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

SMART MODEL ROUTER (pick the BEST video model for the task — mention pilihan + alasan 1 kalimat di "text"):
- STEP 1, detect the INPUT TYPE first:
  * PURE TEXT (no upload, no pin, no URL) → text-to-video. The handler also auto-falls-back r2v→t2v, but YOU should pass the right t2v model explicitly.
  * ONE source image (upload/pin) → image-to-video.
  * IDENTITY matters (persona + product must stay consistent / multi-ref) → reference-to-video.
  * EXISTING VIDEO to change → edit_video tool, NOT gen_video. **HARD RULE**: kalau di chat BARU AJA ada video result dan pesan user minta SESUATU DI DALAM video itu berubah — subjek, objek, warna, background, mood — itu edit_video. Trigger: "ubah/ganti/jadiin/bikin jadi X", "edit video itu", "colorize", "anjingnya jadiin naga", "bajunya ganti merah", "backgroundnya jadi pantai". JANGAN gen_video ulang — itu buang duit dan kehilangan footage aslinya.
  * EXISTING VIDEO to make LONGER → extend_video tool. Trigger: "panjangin", "extend", "terusin videonya X detik lagi", "tambah durasi". (continue_shot juga otomatis pakai ini buat lanjutan video.)
- STEP 2, pick within the variant by need:
  * Default/cheap/draft/iterasi → Grok family ('xai/grok-imagine-video/text-to-video' | '/image-to-video' | '/reference-to-video', ~$0.07/dtk, audio).
  * Higher-quality i2v with audio → 'xai/grok-imagine-video/v1.5/image-to-video' (~$0.14/dtk).
  * Cinematic multi-shot scene from text → 'fal-ai/kling-video/v3/standard/text-to-video' (audio, multi-shot).
  * Native-audio 1080p text video → 'alibaba/happy-horse/text-to-video'.
  * Premium photoreal hero shot from text → 'bytedance/seedance-2.0/text-to-video' (~$0.30/dtk — ONLY when user signals "paling bagus"/"final"/"hero", it's pricey).
  * High-quality text video WITH native audio (safety checker OFF) → 'fal-ai/ltx-2.3-quality/text-to-video' (LTX-2.3, ~$0.06/dtk, photoreal + audio). Pakai kalau user nyebut "LTX", minta "kualitas tinggi + ada suara", atau konten yang sering kena false-positive safety checker. Text-to-video only (no i2v/r2v wired).
  * Best i2v quality → 'fal-ai/kling-video/v3/pro/image-to-video'.
  * Strong identity fidelity r2v → 'bytedance/seedance-2.0/fast/reference-to-video'.
- Budget words ("murah", "hemat", "draft", "iterasi") → Grok. Quality words ("paling bagus", "final", "buat posting") → Kling Pro / Seedance 2.
- Dialog/voiceover/sound needed → audio-capable models (Grok family, Kling O3/T2V, Happy Horse T2V, Seedance T2V).

- For gen_image/gen_video: use config defaults from above UNLESS user explicitly mentions a different model / AR / duration / audio in their message — then override via tool_input.
- If user says e.g. "pakai Kling Pro 1:1 10 detik no audio", pass { model: 'fal-ai/kling-video/v3/pro/image-to-video', ar: '1:1', duration: 10 } to gen_video (and bake "silent" into motion_prompt).
- SOURCE RESOLUTION (CRITICAL — read carefully):
  - User UPLOADED an image/file to chat (look for attachments in conversation): treat that as the source. For IMAGE gen → call gen_image (handler auto-attaches recent chat attachments as refs). For VIDEO gen from uploaded image → call gen_video with image_url set to the attachment URL.
  - User pasted a URL in current OR recent message: use the URL.
  - User says "link itu" / "URL diatas" / "dari link tadi" without re-pasting: URL auto-resolves from recent messages (handler does this).
  - User says "dari gambar diatas" / "edit foto yang gua upload" / "gambar barusan" → that means a CHAT ATTACHMENT not a URL. Call gen_image (handler picks up attachments). DO NOT ask user to pin anything.
  - Never tell user to "pin product/persona dulu" if they already uploaded an image or pasted a URL — just call the right tool.

- URL/VIDEO ROUTING:
  - URL + "bikin video X detik tema Y" / "video dari link" → gen_marketing_video_from_url with extracted (duration, theme, model, count).
  - URL + "bikin foto/image/poster" → gen_image_from_url.
  - **COUNT DETECTION**: parse N from user text — "2 video" / "3 variasi" / "bikinin 5 promo" → pass count=N to gen_marketing_video_from_url (URL path) OR gen_video (upload path). BOTH tools support count. Capped server-side at 5. If user says just "video" with no number, default count=1. **CRITICAL**: never silently downgrade — if user says "3 video" and you only call once, you're broken.
  - Bare URL no clear instruction → scrape_url_for_marketing (preview).
  - Detect model overrides in prompt: "pake Kling 3" -> 'fal-ai/kling-video/v3/image-to-video', "Kling Pro" -> '/v3/pro/image-to-video', "Seedance" -> 'bytedance/seedance-2.0/fast/image-to-video', "Veo" -> 'fal-ai/veo3', "Grok" -> 'xai/grok-imagine-video/image-to-video', "Grok 1.5" -> 'xai/grok-imagine-video/v1.5/image-to-video', "GPT Image 2 Edit" -> 'openai/gpt-image-2/edit', "Nano Banana" -> 'fal-ai/nano-banana/edit'. Text-only + family name: "Grok" -> '.../text-to-video', "Kling" -> 'fal-ai/kling-video/v3/standard/text-to-video', "Happy Horse" -> 'alibaba/happy-horse/text-to-video', "Seedance" -> 'bytedance/seedance-2.0/text-to-video'.
- If user uploads/attaches a video and says "analyze" or "make like this", call analyze_reference_video.
- If user uploads/attaches image/video and asks to score / predict virality, call predict_virality.

- CONTINUE / NEXT SHOT: ANY signal that user wants the next shot in a sequence — "lanjutin", "next", "shot 2", "shot berikutnya", "continue dong", "bikin lagi tapi scene X", "dia sekarang lagi Y" (referring to recently-shown character) — MUST call continue_shot. continue_shot auto-references the most recent gen result from the conversation (works for gen_image, gen_video, gen_marketing_video_from_url, multi-queued, etc). Pass "next_action" if user specified what changes. NEVER reply "bikin shot baru aja" — that loses continuity.

- YOUTUBE URL HANDLING (IMPORTANT — don't refuse, use the tool that works):
  - YouTube URLs DO work with analyze_reference_video (Gemini fetches natively via file_data).
  - YouTube URLs do NOT work with viral_clip_cut directly (browser ffmpeg.wasm CORS-blocked).
  - If user gives YouTube URL + asks for "potong/cut/klip 15 detik lucu": DON'T refuse the whole task.
    Step 1: call analyze_reference_video on the YouTube URL — get real frame-grounded analysis
            with pacing + key moments + suggested timestamps.
    Step 2: in your follow-up text, surface 1-2 candidate timestamps for the user, then say:
            "Buat actual cut-nya, download dulu via ssstik.io / snaptik, upload mp4 lewat 📎,
             baru gua potong di timestamp itu."
    Never reply "gua gak bisa" to a YouTube + cut request — always analyze first to deliver value.

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

  // Verify the caller is a MEMBER of this workspace — not just that it exists.
  // Without this, any authenticated user can pass another workspace's id and
  // spend its fal_key / budget and write results into it (cross-tenant abuse).
  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 403 })

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

  // ── DIRECT-TO-FAL FAST-PATH (skip Gemini entirely) ────────────────────
  // Trigger when the user NAMES a model to go direct with ("ltx", "happy
  // horse") OR explicitly asks to bypass ("langsung ke fal", "direct fal",
  // "tanpa gemini"). There's nothing for the agent to decide — submit the raw
  // command straight to fal via gen_video. Every other request falls through
  // to the normal Gemini flow below, untouched.
  {
    const lt = lastUserText.toLowerCase()
    const wantsLtx = /\bltx\b/.test(lt)
    const wantsHH = /happy[\s-]?horse/.test(lt)
    const wantsDirect = /(langsung|direct|bypass|tanpa gemini|skip gemini)/.test(lt) && /\bfal\b|fal\.?ai/.test(lt)
    if (wantsLtx || wantsHH || wantsDirect) {
      const durMatch = lastUserText.match(/(\d+)\s*(?:detik|dtk|sec(?:ond)?s?|s)\b/i)
      const directDur = durMatch ? parseInt(durMatch[1]) : (parseInt(ctx.activeConfig?.duration) || 5)
      const hasImg = (ctx.recentAttachments || []).some((a) => a.type === 'image' && a.url)
      // Pick the model: explicit name wins; else honor the config bar; else HH t2v.
      let directModel, modelLabel
      if (wantsLtx) { directModel = 'fal-ai/ltx-2.3-quality/text-to-video'; modelLabel = 'LTX' }
      else if (wantsHH) {
        directModel = hasImg ? 'alibaba/happy-horse/image-to-video' : 'alibaba/happy-horse/text-to-video'
        modelLabel = 'Happy Horse'
      } else {
        directModel = ctx.activeConfig?.video_model || 'alibaba/happy-horse/text-to-video'
        modelLabel = (directModel.split('/')[1] || 'fal')
      }
      // Clean the prompt: strip model names + bypass phrases + duration so they
      // don't pollute the motion prompt. Rest verbatim.
      let directPrompt = lastUserText
        .replace(/\b(?:pa(?:ke|kai))\s+(?:ltx|happy[\s-]?horse)\b/gi, '')
        .replace(/\bltx\b/gi, '').replace(/happy[\s-]?horse/gi, '')
        .replace(/(langsung|direct|bypass|tanpa gemini|skip gemini)\s*(ke\s*)?(fal\.?ai?)?/gi, '')
      if (durMatch) directPrompt = directPrompt.replace(durMatch[0], '')
      directPrompt = directPrompt.replace(/[,\s]{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim() || lastUserText
      try {
        const toolResult = await TOOLS.gen_video.handler({
          motion_prompt: directPrompt,
          duration: directDur,
          model: directModel,
          ar: ctx.activeConfig?.ar,
        }, ctx)
        return NextResponse.json({
          ok: true,
          text: `🚀 Direct ${modelLabel} — skip Gemini, langsung gen ${directDur}s (safety checker off).`,
          tool: 'gen_video',
          tool_result: toolResult,
        })
      } catch (e) {
        return NextResponse.json({
          ok: true,
          text: '❌ Direct gen gagal: ' + (e?.message || String(e)),
          tool: 'gen_video',
          tool_result: { type: 'error', error: e?.message || String(e) },
        })
      }
    }
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
          if (!isPublicHttpUrl(a.url)) throw new Error('blocked non-public attachment url') // SSRF guard
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
