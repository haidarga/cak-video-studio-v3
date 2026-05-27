-- Video editor projects: each project edits ONE source video (trim + text
-- overlays + later: multi-track). config jsonb stores the full project state.

create table if not exists public.editor_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Untitled project',
  source_result_id uuid references public.results(id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists editor_projects_workspace_idx on public.editor_projects (workspace_id, updated_at desc);

alter table public.editor_projects enable row level security;

drop policy if exists "Editor projects: members can view" on public.editor_projects;
create policy "Editor projects: members can view"
  on public.editor_projects for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Editor projects: members can manage" on public.editor_projects;
create policy "Editor projects: members can manage"
  on public.editor_projects for all
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
