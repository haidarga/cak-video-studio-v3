-- External API Keys — authenticate cross-platform API calls.
--
-- Caketing (or other internal tools) store a key generated here.
-- The key itself is hashed; only the prefix is stored for display.
-- Each key is workspace-scoped with granular permissions.

create table if not exists public.external_api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  key_hash      text not null,               -- bcrypt hash of the full key
  key_prefix    text not null,               -- first 8 chars for display: "cak_abc1..."
  label         text not null default 'default',
  permissions   text[] not null default '{ingest}',
  -- Possible permissions: 'ingest' (push naskah), 'status' (read job status)
  is_active     boolean not null default true,
  last_used_at  timestamptz,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz default now()
);

create index if not exists external_api_keys_ws_idx
  on public.external_api_keys(workspace_id);

-- RLS: only workspace owner/admins can manage keys
alter table public.external_api_keys enable row level security;

create policy "ExternalApiKeys: members view"
  on public.external_api_keys for select
  using (is_member(workspace_id));

-- Insert/update/delete restricted to workspace owner
create policy "ExternalApiKeys: owner manage"
  on public.external_api_keys for insert
  with check (
    exists(select 1 from public.workspaces w
           where w.id = workspace_id and w.owner_id = auth.uid())
  );

create policy "ExternalApiKeys: owner update"
  on public.external_api_keys for update
  using (
    exists(select 1 from public.workspaces w
           where w.id = workspace_id and w.owner_id = auth.uid())
  );

create policy "ExternalApiKeys: owner delete"
  on public.external_api_keys for delete
  using (
    exists(select 1 from public.workspaces w
           where w.id = workspace_id and w.owner_id = auth.uid())
  );
