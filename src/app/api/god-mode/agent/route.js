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

export const runtime = 'nodejs'
export const maxDuration = 120

// ── Helpers ──────────────────────────────────────────────────────────

async function getFalKey(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspaces').select('fal_key').eq('id', workspaceId).maybeSingle()
  return data?.fal_key || process.env.FAL_KEY || ''
}

// Call a fal.ai sync endpoint. Returns the result JSON.
async function falCall(model, input, falKey) {
  // Use queue endpoint for long-running gens; this helper waits inline. For
  // gen_video which takes 1-3 min, prefer the queue + poll pattern via the
  // existing falRun helper from src/lib/fal-client.js. Keeping this lightweight
  // here for image gen which is usually <30s.
  const res = await fetch(`https://fal.run/${model}`, {
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
    description: 'Generate an image directly. Use when user explicitly asks to create / generate / bikin gambar / make image. Pass a clear visual prompt. If user has an active persona context, the persona refs auto-attach. If active product set, product ref auto-attaches.',
    handler: async ({ prompt, ar }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      // Build ref_image_urls from active context: persona refs + product ref.
      const refUrls = []
      if (ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)

      // Pick model: if persona has Soul LoRA, use flux-lora + inject trigger
      // word into prompt for character lock. Else use nano-banana-2 with refs.
      let model, input, finalPrompt = String(prompt || '')
      if (ctx.activePersona?.lora_url && ctx.activePersona?.lora_trigger_word) {
        model = 'fal-ai/flux-lora'
        finalPrompt = `${ctx.activePersona.lora_trigger_word}, ${finalPrompt}`
        input = {
          prompt: finalPrompt,
          loras: [{ path: ctx.activePersona.lora_url, scale: 1.0 }],
          image_size: ar === '9:16' ? 'portrait_16_9' : ar === '16:9' ? 'landscape_16_9' : 'square_hd',
        }
      } else {
        model = 'fal-ai/nano-banana/edit'
        input = {
          prompt: finalPrompt,
          image_urls: refUrls.slice(0, 8),
          output_format: 'jpeg',
        }
      }

      try {
        const data = await falCall(model, input, falKey)
        const url = data?.images?.[0]?.url || data?.image?.url || data?.url
        if (!url) return { type: 'error', error: 'no image url in fal response' }

        // Save to results so it appears in /qc browsing.
        const { data: row } = await ctx.supabase.from('results').insert({
          workspace_id: ctx.workspaceId,
          persona_id: ctx.activePersona?.id || null,
          type: 'image', url, label: `God Mode — image`,
          ar: ar || 'auto',
          meta: { source: 'god-mode', prompt: finalPrompt, model, refs: refUrls },
          created_by: ctx.userId,
        }).select('id').single()

        return { type: 'gen_image_result', url, model, ar: ar || 'auto', result_id: row?.id, prompt: finalPrompt }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  gen_video: {
    description: 'Generate a video. Pass motion_prompt (what happens, camera moves), duration (5-15s), and optionally image_url for image-to-video. If active persona/product present they auto-attach as refs. If active preset, its motion prompt is appended.',
    handler: async ({ motion_prompt, duration = 5, image_url, ar = '9:16' }, ctx) => {
      const falKey = await getFalKey(ctx.supabase, ctx.workspaceId)
      if (!falKey) return { type: 'error', error: 'no fal.ai key configured' }

      // Compose final motion prompt with active preset appended.
      let finalMotion = String(motion_prompt || '')
      if (ctx.activePreset?.prompt) {
        finalMotion += `\n\n[Cinematic preset: ${ctx.activePreset.label}] ${ctx.activePreset.prompt}`
      }

      // Build refs from active context.
      const refUrls = []
      if (ctx.activePersona?.id) {
        const { data: pRefs } = await ctx.supabase
          .from('persona_refs').select('refs(fal_url)').eq('persona_id', ctx.activePersona.id)
        for (const r of pRefs || []) if (r.refs?.fal_url) refUrls.push(r.refs.fal_url)
      }
      if (ctx.activeProduct?.fal_url) refUrls.push(ctx.activeProduct.fal_url)

      const dur = Math.max(3, Math.min(15, parseInt(duration) || 5))
      let model, input
      if (image_url) {
        // Image-to-video path — animate from a specific frame
        model = 'fal-ai/kling-video/v3/image-to-video'
        input = {
          prompt: finalMotion,
          image_url,
          duration: String(dur),
          aspect_ratio: ar,
        }
      } else {
        // Ref-to-video path — refs as visual anchor, no source image
        model = 'bytedance/seedance-2.0/fast/reference-to-video'
        input = {
          prompt: finalMotion,
          image_urls: refUrls.slice(0, 9),
          duration: String(dur),
          aspect_ratio: ar,
          resolution: '720p',
        }
      }

      try {
        // Use queue endpoint for long-running video gen, poll until done.
        const submitRes = await fetch(`https://queue.fal.run/${model}`, {
          method: 'POST',
          headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        const submitData = await submitRes.json().catch(() => ({}))
        if (!submitRes.ok) throw new Error(submitData?.detail || submitData?.error || `fal.ai ${submitRes.status}`)
        const requestId = submitData?.request_id
        if (!requestId) throw new Error('no request_id from fal')

        // Poll up to 100 seconds. Most 5-10s videos complete within 60-90s
        // on these models. If we time out, the gen continues server-side; the
        // user can re-query later via a follow-up tool (future: gen_status).
        let done = null
        const start = Date.now()
        while (Date.now() - start < 100000) {
          await new Promise((r) => setTimeout(r, 3000))
          const stRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
            headers: { 'Authorization': `Key ${falKey}` },
          })
          const st = await stRes.json().catch(() => ({}))
          if (st?.status === 'COMPLETED') {
            const fullRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
              headers: { 'Authorization': `Key ${falKey}` },
            })
            done = await fullRes.json().catch(() => ({}))
            break
          }
          if (st?.status === 'FAILED') throw new Error(st?.error || 'fal training failed')
        }
        if (!done) return { type: 'error', error: 'video gen timed out (still running on fal — try again in 1-2 min)' }

        const url = done?.video?.url || done?.url
        if (!url) return { type: 'error', error: 'no video url in fal response' }

        const { data: row } = await ctx.supabase.from('results').insert({
          workspace_id: ctx.workspaceId,
          persona_id: ctx.activePersona?.id || null,
          type: 'video', url, label: `God Mode — video`,
          ar,
          meta: { source: 'god-mode', motion: finalMotion, model, image_url, refs: refUrls },
          created_by: ctx.userId,
        }).select('id').single()

        return {
          type: 'gen_video_result',
          url, model, ar, duration: dur, result_id: row?.id, motion: finalMotion,
        }
      } catch (e) {
        return { type: 'error', error: e.message }
      }
    },
  },

  // ─ URL → Marketing proposal ──────────────────────────────────────
  scrape_url_for_marketing: {
    description: 'Given a product page URL (Shopee/Tokopedia/online shop), scrape the page and propose a marketing video naskah. Returns product info + 5-shot UGC-style naskah suggestion. Use when user pastes a URL and asks for marketing video.',
    handler: async ({ url }, ctx) => {
      if (!url || !/^https?:\/\//i.test(url)) return { type: 'error', error: 'valid URL required' }
      try {
        const html = await fetchUrlAsHtml(url)
        // Ask Gemini to extract structured product info + propose naskah
        const extractPrompt = `You are scraping a product page to bootstrap a marketing video. Extract product info from this HTML and propose a 5-shot UGC marketing naskah in Bahasa Indonesia, ~25 seconds total.

URL: ${url}

HTML (cleaned):
${html.slice(0, 25000)}

Return JSON only:
{
  "title": "product name",
  "price": "Rp ... or empty",
  "description": "1-2 sentence product summary",
  "image": "best product image URL from page or empty",
  "naskah": "5-shot UGC naskah in Bahasa Indonesia, 25s total, format:\n[0:00-0:05] Shot 1 description + dialog\n[0:05-0:10] ..."
}

Be concise. If you can't find info, leave field empty."`

        const result = await callLLMJSON({
          workspaceId: ctx.workspaceId,
          contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
          temperature: 0.3,
          maxOutputTokens: 2048,
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

  // ─ Video analyzer ────────────────────────────────────────────────
  analyze_reference_video: {
    description: 'Analyze a reference video to extract style, camera, mood, pacing, suggested replication strategy. Use when user uploads a video as attachment OR provides a URL and asks "make like this" / "analyze this video".',
    handler: async ({ video_url, attachment_index }, ctx) => {
      // If no video_url provided, look at most recent user message attachments
      // and use one. The agent should have determined that already, but we
      // gracefully handle the lookup here.
      let urlToAnalyze = video_url
      if (!urlToAnalyze && Array.isArray(ctx.recentAttachments)) {
        const att = ctx.recentAttachments[parseInt(attachment_index) || 0]
        if (att?.url) urlToAnalyze = att.url
      }
      if (!urlToAnalyze) return { type: 'error', error: 'no video URL or attachment to analyze' }

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
          maxOutputTokens: 1500,
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
      if (!url) return { type: 'error', error: 'no content URL to score' }

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
          maxOutputTokens: 1000,
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

      const { data: persona } = await ctx.supabase
        .from('personas').select('id, name, username, workspace_id').eq('id', persona_id).maybeSingle()
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
  const ctxBlock = ctxLines.length ? `\nActive context:\n${ctxLines.map((l) => `  - ${l}`).join('\n')}` : ''

  return `You are GOD MODE — AI agent inside CAK Video Studio. You speak Bahasa Indonesia (casual, like a teammate). Be direct, decisive, helpful.

Context:
- ${brandLine}
- Personas available: ${ctx.personaCount}
- Product refs available: ${ctx.productCount}
- Cinematic presets in library: ${CINEMATIC_PRESETS.length}${ctxBlock}

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
- "text" should be a brief setup line, UI renders tool result below.
- NEVER invent tools not in the list.
- For gen_image/gen_video, defaults to active context (persona, product, preset) — only override if user specifies different.
- If user pastes a URL, prefer scrape_url_for_marketing.
- If user uploads/attaches a video and says "analyze" or "make like this", call analyze_reference_video.
- If user uploads/attaches an image and asks to score, call predict_virality.
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
  // uploaded content (analyze_reference_video, predict_virality).
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const recentAttachments = lastUserMsg?.attachments || []

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
    recentAttachments,
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
    const res = await callLLMJSON({ workspaceId, contents, temperature: 0.4, maxOutputTokens: 1024 })
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
