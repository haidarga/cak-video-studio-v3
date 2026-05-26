-- CAK Video Studio v3 — initial schema
-- Multi-tenant (workspace-scoped) with RLS. Run this once in Supabase SQL Editor.

create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
create type workspace_role as enum ('owner', 'admin', 'creator', 'qc');
create type ref_kind       as enum ('character', 'product');
create type result_type    as enum ('image', 'video');
create type qc_status      as enum ('pending', 'approved', 'revise', 'rejected');
create type job_kind       as enum ('quick', 'pipeline', 'bulk', 'render', 'stitch');
create type job_status     as enum ('queued', 'running', 'done', 'error', 'cancelled');
create type post_status    as enum ('scheduled', 'posting', 'posted', 'failed', 'cancelled');

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- 1:1 with auth.users — public profile
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

-- Workspace = tenant. API keys (Postiz/fal/Gemini) live here, encrypted via Vault later.
create table public.workspaces (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  postiz_url  text,
  postiz_key  text, -- TODO: move to Supabase Vault (pgsodium) before production
  fal_key     text,
  gemini_key  text,
  created_at  timestamptz not null default now()
);
create index on public.workspaces(owner_id);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         workspace_role not null default 'creator',
  added_at     timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members(user_id);

-- Reference images (characters AND products). Products can carry per-product knowledge.
create table public.refs (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label        text not null default '',
  fal_url      text not null,
  knowledge    text,
  kind         ref_kind not null default 'character',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on public.refs(workspace_id);

create table public.brands (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  notes        text default '',
  config       jsonb default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.brands(workspace_id);

create table public.templates (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  analysis     jsonb not null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on public.templates(workspace_id);

-- A persona = one creator account (with channel + style). Drives per-account generation.
create table public.personas (
  id                    uuid primary key default uuid_generate_v4(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  name                  text not null,
  role_label            text,
  voice_style           text,
  postiz_channel_id     text,
  postiz_channel_label  text,
  postiz_platform       text, -- 'tiktok' | 'instagram' | ...
  brand_id              uuid references public.brands(id) on delete set null,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);
create index on public.personas(workspace_id);

-- Persona ↔ Refs (M:N) — which refs belong to which persona.
create table public.persona_refs (
  persona_id uuid not null references public.personas(id) on delete cascade,
  ref_id     uuid not null references public.refs(id)     on delete cascade,
  primary key (persona_id, ref_id)
);

-- Generated outputs (images + videos). qc_status drives the QC kanban.
create table public.results (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  persona_id   uuid references public.personas(id) on delete set null,
  type         result_type not null,
  url          text not null,
  label        text,
  ar           text,
  group_label  text,
  qc_status    qc_status,
  qc_notes     text,
  meta         jsonb default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on public.results(workspace_id);
create index on public.results(persona_id);
create index on public.results(qc_status);

-- Background jobs. Worker (HF Space) picks up via claimed_by_worker.
create table public.jobs (
  id                uuid primary key default uuid_generate_v4(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  kind              job_kind not null,
  status            job_status not null default 'queued',
  progress          int not null default 0,
  config            jsonb not null,
  output            jsonb,
  error             text,
  created_by        uuid references auth.users(id) on delete set null,
  claimed_by_worker text,
  claimed_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on public.jobs(workspace_id);
create index on public.jobs(status);
create index on public.jobs(claimed_by_worker);

-- Postiz scheduling. scheduled_for = null means "post now".
create table public.scheduled_posts (
  id              uuid primary key default uuid_generate_v4(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  result_id       uuid not null references public.results(id) on delete cascade,
  persona_id      uuid not null references public.personas(id) on delete cascade,
  scheduled_for   timestamptz,
  status          post_status not null default 'scheduled',
  postiz_post_id  text,
  caption         text,
  error           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.scheduled_posts(workspace_id);
create index on public.scheduled_posts(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger brands_updated_at before update on public.brands
  for each row execute function set_updated_at();
create trigger jobs_updated_at before update on public.jobs
  for each row execute function set_updated_at();

-- On signup, create the profile row.
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- When a workspace is created, auto-add owner as an 'owner' member.
create or replace function add_owner_as_member()
returns trigger language plpgsql security definer as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end $$;

create trigger workspace_owner_member
  after insert on public.workspaces
  for each row execute function add_owner_as_member();

-- Helper used by RLS: is the current user a member of this workspace?
create or replace function is_member(ws_id uuid)
returns boolean language sql security definer stable as $$
  select exists(
    select 1 from public.workspace_members
    where workspace_id = ws_id and user_id = auth.uid()
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.refs              enable row level security;
alter table public.brands            enable row level security;
alter table public.templates         enable row level security;
alter table public.personas          enable row level security;
alter table public.persona_refs      enable row level security;
alter table public.results           enable row level security;
alter table public.jobs              enable row level security;
alter table public.scheduled_posts   enable row level security;

-- Profiles
create policy "profiles self" on public.profiles for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- Workspaces
create policy "workspaces select" on public.workspaces for select to authenticated
  using (is_member(id));
create policy "workspaces insert" on public.workspaces for insert to authenticated
  with check (auth.uid() = owner_id);
create policy "workspaces update" on public.workspaces for update to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "workspaces delete" on public.workspaces for delete to authenticated
  using (auth.uid() = owner_id);

-- Workspace members
create policy "members select" on public.workspace_members for select to authenticated
  using (is_member(workspace_id));
create policy "members insert (owner only)" on public.workspace_members for insert to authenticated
  with check (exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid()));
create policy "members delete (owner or self)" on public.workspace_members for delete to authenticated
  using (
    user_id = auth.uid()
    or exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );

-- Workspace-scoped tables: any member can CRUD (roles can be tightened later).
create policy "refs ws"            on public.refs            for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy "brands ws"          on public.brands          for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy "templates ws"       on public.templates       for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy "personas ws"        on public.personas        for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy "results ws"         on public.results         for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy "jobs ws"            on public.jobs            for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy "scheduled_posts ws" on public.scheduled_posts for all to authenticated using (is_member(workspace_id)) with check (is_member(workspace_id));

-- persona_refs derives workspace from the persona row
create policy "persona_refs ws" on public.persona_refs for all to authenticated
  using (exists(select 1 from public.personas p where p.id = persona_id and is_member(p.workspace_id)))
  with check (exists(select 1 from public.personas p where p.id = persona_id and is_member(p.workspace_id)));

-- ─────────────────────────────────────────────────────────────────────────────
-- REALTIME — subscribe to live updates from the client
-- ─────────────────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.results;
alter publication supabase_realtime add table public.scheduled_posts;
