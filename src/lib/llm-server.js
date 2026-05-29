// Multi-provider LLM caller with configurable fallback cascade.
//
// Replaces the hard-coded Gemini-only cascade. User configures default model +
// fallback chain per workspace via /settings UI. Lib reads config + cascades
// through the chain on transient failure.
//
// Supported providers: google (Gemini), openai (GPT). Each provider has a
// thin adapter that accepts the same {contents, generationConfig} shape and
// returns text. Internally adapters translate to provider-specific request.

import { createAdminClient } from '@/lib/supabase/admin'

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
const ATTEMPTS_PER_MODEL = 2
const BACKOFF_MS = [1000, 3000]

// Default config when workspace has no llm_config saved yet (fresh install).
// Gemini 2.0 Flash removed — Google blocks new users from that model;
// existing workspaces with stale config saying 2.0 will fall through the
// fallback chain to 2.5 Pro / 2.5 Flash Lite.
const DEFAULT_CONFIG = {
  default: { provider: 'google', model: 'gemini-2.5-flash' },
  fallback: [
    { provider: 'google', model: 'gemini-2.5-pro' },
    { provider: 'google', model: 'gemini-2.5-flash-lite' },
    { provider: 'google', model: 'gemini-1.5-flash' },
  ],
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function isTransientError(err) {
  if (!err) return false
  if (TRANSIENT_STATUS.has(err.status)) return true
  const msg = String(err.message || '').toLowerCase()
  return msg.includes('high demand') || msg.includes('unavailable') || msg.includes('overload') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('exhausted') || msg.includes('overloaded')
}

// ── Google (Gemini) adapter ──────────────────────────────────────────
async function callGoogle({ model, apiKey, contents, generationConfig }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    const err = new Error(data?.error?.message || `Google ${res.status}`)
    err.status = res.status; err.model = model; err.provider = 'google'
    throw err
  }
  if (!data.candidates?.length) {
    const reason = data.promptFeedback?.blockReason || 'unknown'
    const err = new Error(`Google blocked: ${reason}`)
    err.status = 400; err.model = model; err.provider = 'google'
    throw err
  }
  return data.candidates[0].content.parts[0].text || ''
}

// ── OpenAI adapter ────────────────────────────────────────────────────
// Translates Google-shaped {contents:[{parts:[{text}]}]} → OpenAI chat shape.
async function callOpenAI({ model, apiKey, contents, generationConfig }) {
  // Flatten contents into a single user message. Inline images (Gemini's
  // inline_data parts) translated to OpenAI image_url format with data URIs.
  const userParts = []
  for (const c of contents) {
    for (const p of (c.parts || [])) {
      if (p.text) userParts.push({ type: 'text', text: p.text })
      else if (p.inline_data) {
        userParts.push({
          type: 'image_url',
          image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` },
        })
      }
    }
  }
  const wantsJson = generationConfig?.responseMimeType === 'application/json'
  const body = {
    model,
    messages: [{ role: 'user', content: userParts }],
    temperature: generationConfig?.temperature ?? 0.7,
    max_tokens: Math.min(generationConfig?.maxOutputTokens ?? 4096, 16384),
    ...(wantsJson ? { response_format: { type: 'json_object' } } : {}),
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    const err = new Error(data?.error?.message || `OpenAI ${res.status}`)
    err.status = res.status; err.model = model; err.provider = 'openai'
    throw err
  }
  const text = data.choices?.[0]?.message?.content
  if (!text) {
    const err = new Error('OpenAI returned empty response')
    err.status = 502; err.model = model; err.provider = 'openai'
    throw err
  }
  return text
}

// Provider router — picks adapter based on level.provider.
async function callProvider(level, keys, contents, generationConfig) {
  const { provider, model } = level
  if (provider === 'google') {
    if (!keys.google) {
      const e = new Error('GEMINI_KEY belum di-set di Vercel env vars'); e.status = 500; throw e
    }
    return await callGoogle({ model, apiKey: keys.google, contents, generationConfig })
  }
  if (provider === 'openai') {
    if (!keys.openai) {
      const e = new Error('OpenAI key belum di-set di Settings → LLM. Fallback level ini di-skip.')
      e.status = 503; throw e
    }
    return await callOpenAI({ model, apiKey: keys.openai, contents, generationConfig })
  }
  const e = new Error(`Unknown provider: ${provider}`); e.status = 400; throw e
}

// Single model with retries (transient only).
async function tryLevel(level, keys, contents, generationConfig) {
  let lastErr
  for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
    try {
      return await callProvider(level, keys, contents, generationConfig)
    } catch (e) {
      lastErr = e
      if (!isTransientError(e)) throw e
      if (attempt < ATTEMPTS_PER_MODEL - 1) await sleep(BACKOFF_MS[attempt] || 3000)
    }
  }
  throw lastErr
}

// Map of retired / removed model IDs → modern replacement. Applied at load
// time so workspaces with stale llm_config (saved when those models were
// alive) keep working without a DB migration. Google's "no longer available
// to new users" 404 is the canonical case — they retire fast.
const RETIRED_MODELS = {
  'gemini-2.0-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash-exp': 'gemini-2.5-flash',
  'gemini-1.5-pro': 'gemini-2.5-pro',
}
function rewriteModel(entry) {
  if (!entry?.model) return entry
  const replacement = RETIRED_MODELS[entry.model]
  return replacement ? { ...entry, model: replacement } : entry
}
function sanitizeConfig(cfg) {
  if (!cfg) return cfg
  return {
    default: rewriteModel(cfg.default),
    fallback: (cfg.fallback || []).map(rewriteModel),
  }
}

// Fetch workspace's LLM config + provider keys. Falls back to DEFAULT_CONFIG
// when workspace has nothing saved. Uses admin client (server-side trust).
async function loadConfig(workspaceId) {
  const keys = {
    google: process.env.GEMINI_KEY,
    // openai key comes from workspace, NOT env (per-workspace customization).
  }
  let config = DEFAULT_CONFIG
  if (workspaceId) {
    try {
      const admin = createAdminClient()
      const { data } = await admin.from('workspaces')
        .select('llm_config, openai_key').eq('id', workspaceId).maybeSingle()
      if (data?.llm_config?.default?.model) config = data.llm_config
      if (data?.openai_key) keys.openai = data.openai_key
    } catch { /* fall through to defaults */ }
  }
  return { config: sanitizeConfig(config), keys }
}

// Main entry. Cascades default → fallback[0] → ... until one succeeds.
// opts: { workspaceId, contents, generationConfig, modelOverride }
export async function callLLM({ workspaceId, contents, generationConfig = {}, modelOverride } = {}) {
  if (!contents) throw new Error('contents required')
  const { config, keys } = await loadConfig(workspaceId)
  const chain = modelOverride
    ? [modelOverride]
    : [config.default, ...(config.fallback || [])].filter(Boolean)

  let lastErr
  const tried = []
  for (const level of chain) {
    try {
      const result = await tryLevel(level, keys, contents, generationConfig)
      if (tried.length > 0) {
        console.warn(`[llm] fallback succeeded on ${level.provider}/${level.model} after: ${tried.map((t) => `${t.provider}/${t.model}`).join(', ')}`)
      }
      return { text: result, model: level }
    } catch (e) {
      lastErr = e
      tried.push(level)
      if (!isTransientError(e)) throw e
    }
  }

  const friendly = new Error(
    `Semua model gagal — udah coba ${tried.length} level: ${tried.map((t) => `${t.provider}/${t.model}`).join(' → ')}. Last error: ${String(lastErr?.message || lastErr).slice(0, 200)}`
  )
  friendly.transient = true; friendly.status = 503; friendly.cause = lastErr; friendly.tried = tried
  throw friendly
}

// JSON convenience wrapper.
export async function callLLMJSON({ workspaceId, contents, temperature = 0.7, maxOutputTokens = 4096, modelOverride } = {}) {
  const { text, model } = await callLLM({
    workspaceId, contents, modelOverride,
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
  })
  let clean = text.replace(/```json|```/g, '').trim()
  const first = clean.indexOf('{')
  const last = clean.lastIndexOf('}')
  if (first >= 0 && last > first) clean = clean.slice(first, last + 1)
  try {
    return { parsed: JSON.parse(clean), model }
  } catch (e) {
    const err = new Error(`${model.provider}/${model.model} balik bukan JSON valid: ${clean.slice(0, 200)}`)
    err.status = 502; throw err
  }
}

// Discover available models per provider — used by Settings UI to show options.
export const PROVIDER_CATALOG = {
  google: {
    label: 'Google (Gemini)',
    models: [
      { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      cost: '$0.075/1M in · cheap, fast' },
      { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        cost: '$1.25/1M in · smartest, low traffic' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', cost: '$0.04/1M in · cheapest' },
      { id: 'gemini-1.5-flash',      label: 'Gemini 1.5 Flash',      cost: '$0.075/1M in · legacy, very stable' },
    ],
  },
  openai: {
    label: 'OpenAI (GPT)',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', cost: '$0.15/1M in · cheap, fast' },
      { id: 'gpt-4o',      label: 'GPT-4o',      cost: '$2.50/1M in · smart, multimodal' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', cost: '$0.40/1M in · balanced' },
      { id: 'gpt-4.1',     label: 'GPT-4.1',     cost: '$2.00/1M in · smart' },
    ],
  },
}
