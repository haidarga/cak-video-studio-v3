-- Error log + multi-user invite codes.

-- A. Error log: catch + persist server-side errors untuk inspect di dashboard
create table if not exists public.error_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id),
  source text not null,                    -- e.g. '/api/fal/result', '/api/postiz/post'
  level text default 'error',              -- 'error' | 'warn' | 'info'
  message text not null,
  stack text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists error_log_workspace_idx on public.error_log (workspace_id, created_at desc);
create index if not exists error_log_level_idx on public.error_log (level, created_at desc);

alter table public.error_log enable row level security;

drop policy if exists "Errors: members can view" on public.error_log;
create policy "Errors: members can view"
  on public.error_log for select
  using (workspace_id is null or workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Errors: server can insert" on public.error_log;
create policy "Errors: server can insert"
  on public.error_log for insert with check (true);

-- B. Workspace invite codes (no email needed, share code manually)
create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code text not null unique,
  role text not null default 'editor',     -- 'owner' | 'editor' | 'viewer'
  created_by uuid not null references auth.users(id),
  used_by uuid references auth.users(id),
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists workspace_invites_code_idx on public.workspace_invites (code);
create index if not exists workspace_invites_ws_idx on public.workspace_invites (workspace_id, created_at desc);

alter table public.workspace_invites enable row level security;

drop policy if exists "Invites: members can view own ws" on public.workspace_invites;
create policy "Invites: members can view own ws"
  on public.workspace_invites for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Invites: members can create for own ws" on public.workspace_invites;
create policy "Invites: members can create for own ws"
  on public.workspace_invites for insert
  with check (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Invites: members can delete own ws" on public.workspace_invites;
create policy "Invites: members can delete own ws"
  on public.workspace_invites for delete
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
