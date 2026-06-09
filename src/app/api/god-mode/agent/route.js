// POST /api/god-mode/agent
//
// Conversational agent endpoint for the GOD MODE chatroom. Accepts a user
// message + conversation history, asks Gemini to either (a) respond directly
// with text or (b) invoke a registered tool. Returns a structured response
// the chat UI can render as a message (text + optional tool result + action
// buttons).
//
// Tools registered here are "thin" — they map natural language intent to
// concrete actions inside the platform (suggest cinematic preset, list
// personas, suggest model, etc). Heavy generation (image/video) still goes
// through the existing /generate flow; the agent just orchestrates and
// surfaces suggestions.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLMJSON } from '@/lib/llm-server'
import { CINEMATIC_PRESETS, CINEMATIC_CATEGORIES } from '@/lib/cinematic-presets'

export const runtime = 'nodejs'
export const maxDuration = 60

// ── TOOL REGISTRY ────────────────────────────────────────────────────
// Each tool has a name, description (used in system prompt so Gemini knows
// when to call it), an input schema (informal, validated inside handler),
// and a handler that returns a JSON-serializable result the UI can render.
//
// To add a new tool: append to TOOLS, give it a clear name + description,
// implement the handler. The system prompt below auto-includes it.

const TOOLS = {
  suggest_cinematic_preset: {
    description: 'When the user describes a camera move, motion, or cinematic look (e.g. "bullet time", "dolly in", "product spin"), find the closest matching preset from the cinematic library and return it. Use this whenever the user mentions camera/motion/cinematic vocabulary.',
    inputs: ['user_intent: short description of the desired motion'],
    handler: async ({ user_intent }, _ctx) => {
      // Cheap keyword match — for the MVP we don't need vector search.
      // Gemini already understood intent; we just surface the catalog so
      // the UI can render the preset card with apply button.
      const intent = String(user_intent || '').toLowerCase()
      const ranked = CINEMATIC_PRESETS.map((p) => {
        let score = 0
        const hay = `${p.label} ${p.desc} ${p.prompt}`.toLowerCase()
        for (const word of intent.split(/\s+/).filter((w) => w.length > 2)) {
          if (hay.includes(word)) score += 1
        }
        return { preset: p, score }
      }).sort((a, b) => b.score - a.score).slice(0, 3)
      return {
        type: 'cinematic_preset_suggestions',
        intent: user_intent,
        suggestions: ranked.map((r) => r.preset),
      }
    },
  },
  list_cinematic_presets: {
    description: 'List the full cinematic preset library, grouped by category. Use when the user asks to browse all available motion presets or asks "what presets do you have".',
    inputs: [],
    handler: async (_, _ctx) => {
      const groups = {}
      for (const c of CINEMATIC_CATEGORIES) groups[c.id] = { ...c, presets: [] }
      for (const p of CINEMATIC_PRESETS) groups[p.category]?.presets.push(p)
      return {
        type: 'cinematic_preset_library',
        categories: Object.values(groups),
      }
    },
  },
  list_personas: {
    description: 'List all personas available in the current workspace + active brand. Use when the user mentions picking a character, asks "who can I use", or wants to compose a scene with a specific persona.',
    inputs: [],
    handler: async (_, ctx) => {
      const supabase = ctx.supabase
      const wsId = ctx.workspaceId
      const brandId = ctx.activeBrandId
      const q = supabase
        .from('personas')
        .select('id, name, username, avatar_url, brand_id')
        .eq('workspace_id', wsId)
      if (brandId) q.eq('brand_id', brandId)
      const { data } = await q.order('created_at', { ascending: false }).limit(40)
      return { type: 'persona_list', personas: data || [] }
    },
  },
  list_product_refs: {
    description: 'List all product refs (uploaded product images with knowledge sheets) in the current workspace. Use when the user wants to pick a product to feature or asks "what products do I have".',
    inputs: [],
    handler: async (_, ctx) => {
      const { data } = await ctx.supabase
        .from('refs')
        .select('id, label, fal_url, knowledge')
        .eq('workspace_id', ctx.workspaceId)
        .eq('kind', 'product')
        .order('created_at', { ascending: false })
        .limit(40)
      return { type: 'product_ref_list', products: data || [] }
    },
  },
}

// Build the system prompt — includes tool catalog so Gemini can pick the
// right tool. Keep it tight so Gemini's structured output stays clean.
function buildSystemPrompt(ctx) {
  const toolDescriptions = Object.entries(TOOLS).map(([name, t]) => {
    return `- ${name}: ${t.description}`
  }).join('\n')

  const brandLine = ctx.activeBrand
    ? `Active brand: "${ctx.activeBrand.name}" (notes: ${ctx.activeBrand.notes || 'none'})`
    : 'No active brand'

  return `You are GOD MODE — an AI agent inside CAK Video Studio that helps creators generate cinematic videos. You speak Bahasa Indonesia (casual, like a teammate) by default. Be direct and decisive.

Context:
- ${brandLine}
- Personas available: ${ctx.personaCount}
- Product refs available: ${ctx.productCount}
- Camera presets in library: ${CINEMATIC_PRESETS.length}

You have these tools (return ONE tool call when relevant, OR plain text reply if no tool fits):

${toolDescriptions}

OUTPUT FORMAT (strict JSON, nothing else):
{
  "tool": "<tool_name>" | null,
  "tool_input": { ... } | null,
  "text": "<your reply to the user, conversational, in Bahasa Indonesia>"
}

Rules:
- If a tool fits, return tool name + inputs. The "text" field should be a short setup line ("Cari preset yang cocok...") — the UI will render the tool result below.
- If NO tool fits, set tool=null and write a normal helpful reply in "text".
- NEVER invent tools not in the list.
- Always return valid JSON. No markdown, no code fences.`
}

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }

  const { workspaceId, messages, activeBrand, personaCount = 0, productCount = 0 } = body || {}
  if (!workspaceId || !Array.isArray(messages)) {
    return NextResponse.json({ ok: false, error: 'missing workspaceId or messages' }, { status: 400 })
  }

  // Verify user has access to this workspace (RLS would catch it, but
  // early-return saves a round-trip).
  const { data: ws } = await supabase.from('workspaces').select('id').eq('id', workspaceId).maybeSingle()
  if (!ws) return NextResponse.json({ ok: false, error: 'workspace not found or no access' }, { status: 403 })

  const ctx = {
    supabase,
    workspaceId,
    activeBrand: activeBrand || null,
    activeBrandId: activeBrand?.id || null,
    personaCount,
    productCount,
  }

  const systemPrompt = buildSystemPrompt(ctx)

  // Build Gemini contents — system message + conversation history. Use the
  // existing callLLMJSON helper which handles fallback chain + provider
  // routing automatically.
  //
  // Multimodal: user messages can carry attachments[] (uploaded via /api/upload
  // to R2). For images, fetch the bytes and embed as inline_data so Gemini can
  // actually see them. Non-image files only get URL + name passed as text
  // context — Gemini won't read the file content, but the agent can route to
  // a dedicated tool later.
  const contents = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Siap. Gua agent GOD MODE — tinggal kasih tau apa yang lo butuh.' }] },
  ]
  for (const m of messages.slice(-12)) { // last 12 turns max — keep context budget tight
    const parts = []
    if (m.content) parts.push({ text: String(m.content) })
    // Inline images so Gemini can analyze them. Cap at 3 images per message
    // to avoid blowing context budget. Non-images get a text note.
    const atts = Array.isArray(m.attachments) ? m.attachments.slice(0, 5) : []
    let imgCount = 0
    for (const a of atts) {
      if (a.type === 'image' && imgCount < 3) {
        try {
          const imgRes = await fetch(a.url)
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer())
            parts.push({
              inline_data: {
                mime_type: a.mime || 'image/jpeg',
                data: buf.toString('base64'),
              },
            })
            imgCount++
          }
        } catch (e) {
          parts.push({ text: `[gagal load image: ${a.name}]` })
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
    const res = await callLLMJSON({
      workspaceId,
      contents,
      temperature: 0.4,
      maxOutputTokens: 1024,
    })
    // callLLMJSON returns { parsed, model } — unwrap the JSON payload.
    parsed = res.parsed
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'llm error: ' + (e?.message || String(e)) }, { status: 500 })
  }

  // Validate Gemini's response shape.
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

  return NextResponse.json({
    ok: true,
    text,
    tool: tool || null,
    tool_result: toolResult,
  })
}
