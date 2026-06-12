-- F CREATOR — autopilot factory run state.
--
-- The factory runs CLIENT-side (browser renders the final assembly via
-- ffmpeg.wasm — Vercel has no ffmpeg). This table persists per-run state
-- after every pipeline stage so a refresh/crash resumes from the last
-- completed stage instead of re-paying for gens that already finished.
-- Generated artifacts (images/videos) live in R2/fal + results rows;
-- this row only stores the orchestration state (stage pointers + urls).

create table if not exists public.factory_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'running',   -- 'running' | 'paused' | 'done' | 'error'
  config jsonb not null default '{}',       -- mode/models/toggles snapshot
  items jsonb not null default '[]',        -- [{id, naskah, label, stage, shots:[...], final_url, result_id, error}]
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists factory_runs_ws_idx
  on public.factory_runs(workspace_id, created_at desc);

alter table public.factory_runs enable row level security;

drop policy if exists "FactoryRuns: members manage" on public.factory_runs;
create policy "FactoryRuns: members manage"
  on public.factory_runs for all
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
