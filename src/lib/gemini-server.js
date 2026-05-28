// Compat shim — delegates to lib/llm-server.js so existing callers don't break.
//
// Original Gemini-only cascade is replaced by configurable per-workspace
// multi-provider chain in llm-server.js. This file keeps the same API surface
// (callGemini / callGeminiJSON) so we don't have to touch 4 route handlers.

import { callLLM, callLLMJSON } from '@/lib/llm-server'

export async function callGemini({ workspaceId, contents, generationConfig = {} } = {}) {
  const { text } = await callLLM({ workspaceId, contents, generationConfig })
  return text
}

export async function callGeminiJSON({ workspaceId, contents, temperature, maxOutputTokens } = {}) {
  const { parsed } = await callLLMJSON({ workspaceId, contents, temperature, maxOutputTokens })
  return parsed
}
