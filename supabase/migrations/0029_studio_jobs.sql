-- Studio Jobs — naskah pushed from external sources (Caketing, ecosystem).
--
-- Each row = one naskah that becomes a production job in the Studio Inbox.
-- The job arrives pre-parsed (Caketing already has shot-by-shot blocks) and
-- pre-mapped to a Studio persona. User opens it in the Generate page, picks
-- camera preset + models, and generates — no manual copy-paste of scripts.
--
-- Lifecycle: pending → in_progress → generating → done | error | cancelled

create table if not exists public.studio_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,

  -- Source tracking (who pushed this and from where)
  source           text not null default 'caketing'
                   check (source in ('caketing', 'ecosystem', 'manual')),
  source_ref       jsonb not null default '{}',
  -- { naskah_id, batch_id, persona_id, brief_id, source_url }

  -- Content
  title            text not null,
  naskah_text      text not null,            -- raw naskah text (source of truth stays in Caketing)
  parsed_shots     jsonb,                    -- pre-parsed shot breakdown from Caketing blocks
  -- [{ shot, duration, scene_type, image_prompt, video_motion, dialogue, chars_in_shot }]

  -- Context from source
  persona_mapping  jsonb not null default '{}',
  -- { source_persona_id, source_persona_name, studio_persona_id, match_type: 'auto'|'manual'|'unmapped' }
  brand_id         uuid references public.brands(id) on delete set null,
  brand_name       text,                     -- stored for display even if brand record not found
  brief_context    jsonb default '{}',       -- brief fields snapshot from Caketing
  format_meta      jsonb default '{}',       -- { platform, target_duration_s, aspect_ratio }

  -- Job state
  status           text not null default 'pending'
                   check (status in ('pending','in_progress','parsed','generating',
                                     'done','error','cancelled')),

  -- Generation config (set by user when they open the job in Generate)
  gen_config       jsonb default '{}',
  -- { mode, image_model, video_model, camera_preset_id, constraints }

  -- Result tracking
  result_ids       uuid[] default '{}',      -- generated results linked back
  error            text,

  -- Timestamps
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Performance indexes
create index if not exists studio_jobs_ws_status_idx
  on public.studio_jobs(workspace_id, status, created_at desc);
create index if not exists studio_jobs_ws_created_idx
  on public.studio_jobs(workspace_id, created_at desc);

-- Trigger: auto-update updated_at
create trigger studio_jobs_updated_at before update on public.studio_jobs
  for each row execute function set_updated_at();

-- RLS: workspace members can CRUD
alter table public.studio_jobs enable row level security;

create policy "StudioJobs: members manage"
  on public.studio_jobs for all
  using (is_member(workspace_id))
  with check (is_member(workspace_id));

-- Realtime: Inbox UI subscribes for live status updates
alter publication supabase_realtime add table public.studio_jobs;
