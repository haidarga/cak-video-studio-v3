-- Activity log: audit trail of who did what when. Visible in sidebar widget.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  summary text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists activity_log_workspace_idx on public.activity_log (workspace_id, created_at desc);

alter table public.activity_log enable row level security;

drop policy if exists "Activity: members can view" on public.activity_log;
create policy "Activity: members can view"
  on public.activity_log for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Activity: server can insert" on public.activity_log;
create policy "Activity: server can insert"
  on public.activity_log for insert
  with check (true);
