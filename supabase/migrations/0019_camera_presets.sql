-- Camera presets — user-customizable per workspace.
--
-- Built-in presets live in src/lib/camera-presets.js (hardcoded constants).
-- This table stores WORKSPACE CUSTOM presets — user can add, edit, delete
-- their own without touching code.
--
-- Schema mirrors the in-code preset shape: tokens[], negatives[],
-- conflicts_with[], dominance int. Prompt compiler reads from both sources
-- (built-in + workspace custom) when assembling prompts.

create table if not exists public.camera_presets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  preset_key text not null,           -- short id used in globalConfig (e.g. 'acekid_brand_ugc')
  label text not null,
  category text not null default 'custom',  -- 'phone' | 'cinema' | 'social' | 'animation' | 'custom'
  use_case text default '',
  tokens jsonb not null default '[]',       -- array of strings
  negatives jsonb not null default '[]',    -- array of strings
  conflicts_with jsonb not null default '[]',
  dominance integer not null default 5,
  is_favorite boolean default false,
  created_at timestamptz default now(),
  unique (workspace_id, preset_key)
);

create index if not exists camera_presets_workspace_idx
  on public.camera_presets(workspace_id, created_at desc);

alter table public.camera_presets enable row level security;

drop policy if exists "CameraPresets: members can view" on public.camera_presets;
create policy "CameraPresets: members can view"
  on public.camera_presets for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "CameraPresets: members can manage" on public.camera_presets;
create policy "CameraPresets: members can manage"
  on public.camera_presets for all
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
