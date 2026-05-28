-- LLM provider config per workspace.
--
-- Multi-provider support (Google + OpenAI for now). User picks the default
-- model + configurable fallback chain via /settings UI. Replaces hard-coded
-- cascade in lib/gemini-server.js.
--
-- llm_config shape:
-- {
--   "default":  { "provider": "google", "model": "gemini-2.5-flash" },
--   "fallback": [
--     { "provider": "google", "model": "gemini-2.0-flash" },
--     { "provider": "google", "model": "gemini-2.5-pro" },
--     { "provider": "openai", "model": "gpt-4o-mini" },
--     { "provider": "openai", "model": "gpt-4o" }
--   ]
-- }
-- Empty fallback array = no cascade (just default model). Provider 'openai'
-- requires openai_key set in workspaces.

alter table public.workspaces
  add column if not exists llm_config jsonb default '{
    "default": {"provider":"google","model":"gemini-2.5-flash"},
    "fallback": [
      {"provider":"google","model":"gemini-2.0-flash"},
      {"provider":"google","model":"gemini-2.5-pro"},
      {"provider":"google","model":"gemini-1.5-flash"}
    ]
  }'::jsonb;

alter table public.workspaces
  add column if not exists openai_key text;
