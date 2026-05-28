-- Voice cloning via ElevenLabs.
--
-- v3 uses ElevenLabs Speech-to-Speech (NOT TTS) to swap the AI-generated video's
-- native audio with a persona's cloned voice. Timing & lip-sync are preserved
-- because S2S converts existing audio — same phonemes, same emotion, different
-- timbre. No separate lip-sync model needed.
--
-- Storage layout:
--   workspaces.elevenlabs_key — workspace-level API key (server-side proxy only)
--   personas.voice_id / voice_name / voice_source — the cloned voice attached
--   results.meta.cloned_audio_url — set post-gen by /api/voice/convert
--
-- Voice can be created three ways (all hit ElevenLabs):
--   'clone'    — Instant Voice Clone from uploaded audio (≥10s)
--   'design'   — text-to-voice from a prompt description
--   'library'  — picked from an existing voice in the workspace's ElevenLabs library

alter table public.workspaces add column if not exists elevenlabs_key text;
-- TODO: move workspace API keys to Supabase Vault (pgsodium) before public launch.

alter table public.personas add column if not exists voice_id text;
alter table public.personas add column if not exists voice_name text;
alter table public.personas add column if not exists voice_source text; -- 'clone' | 'design' | 'library'

create index if not exists personas_voice_idx on public.personas(workspace_id) where voice_id is not null;
