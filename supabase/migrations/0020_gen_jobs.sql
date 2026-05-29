-- Gen jobs — webhook-driven async generation tracking.
--
-- Replaces browser-side polling of /api/fal/status, which hit rate limits hard
-- once a single user fanned out 6+ parallel personas (let alone 200 contents in
-- one batch). Architecture now:
--   1. /api/fal/submit inserts a row here (status=pending) + passes webhookUrl
--      to fal so fal will POST us when the job finishes.
--   2. /api/fal/webhook receives that callback, fetches the result data, and
--      UPDATEs the row to status='done' (with url) or status='error'.
--   3. Browser subscribes to gen_jobs via Supabase realtime — when the row
--      flips to done/error, the UI reacts. Zero polling.
--
-- Job identity = fal's request_id (unique per submit). We don't generate our
-- own ids because webhook handler needs to match by what fal sends back.

create table if not exists public.gen_jobs (
  request_id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,                         -- 'image' | 'video' | 'other'
  model text not null,                        -- fal model id
  status text not null default 'pending',     -- 'pending' | 'done' | 'error'
  payload_url text,                           -- the resulting image/video URL when done
  payload jsonb,                              -- full fal result (in case caller wants other fields)
  error text,                                 -- error message when status='error'
  duration_seconds numeric,                   -- for video cost logging
  meta jsonb default '{}',                    -- caller-supplied context (shot_idx, persona_id, etc)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists gen_jobs_workspace_idx
  on public.gen_jobs(workspace_id, created_at desc);

create index if not exists gen_jobs_status_idx
  on public.gen_jobs(workspace_id, status, created_at desc);

alter table public.gen_jobs enable row level security;

drop policy if exists "GenJobs: members can view" on public.gen_jobs;
create policy "GenJobs: members can view"
  on public.gen_jobs for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "GenJobs: members can manage" on public.gen_jobs;
create policy "GenJobs: members can manage"
  on public.gen_jobs for all
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

-- Realtime needed — browser subscribes per request_id and reacts when the row
-- flips. Without this the channel.on('postgres_changes') won't fire.
alter publication supabase_realtime add table public.gen_jobs;
