-- Track every paid API call (fal.ai gen + Gemini calls) ke usage_log
-- supaya user bisa monitor cost realtime, set budget alert, dll.

create table if not exists public.usage_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  kind text not null,                    -- 'image_gen' | 'video_gen' | 'transcribe' | 'caption_draft' | 'parse'
  model text,                            -- 'fal-ai/nano-banana-2/edit' | 'gemini-2.5-flash' | dll
  cost_usd numeric(10,4) default 0,
  meta jsonb default '{}'::jsonb,        -- { result_id, persona_id, duration_s, ... }
  created_at timestamptz default now()
);

create index if not exists usage_log_workspace_idx on public.usage_log (workspace_id, created_at desc);
create index if not exists usage_log_kind_idx on public.usage_log (workspace_id, kind, created_at desc);

alter table public.usage_log enable row level security;

drop policy if exists "Usage: members can view" on public.usage_log;
create policy "Usage: members can view"
  on public.usage_log for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Usage: server can insert" on public.usage_log;
create policy "Usage: server can insert"
  on public.usage_log for insert
  with check (true);

-- Optional: budget_settings per workspace
create table if not exists public.budget_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  daily_limit_usd numeric(10,2) default 50,
  monthly_limit_usd numeric(10,2) default 500,
  alert_at_pct integer default 80,       -- warn pas 80% limit
  updated_at timestamptz default now()
);

alter table public.budget_settings enable row level security;

drop policy if exists "Budget: members can view" on public.budget_settings;
create policy "Budget: members can view"
  on public.budget_settings for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Budget: members can manage" on public.budget_settings;
create policy "Budget: members can manage"
  on public.budget_settings for all
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
