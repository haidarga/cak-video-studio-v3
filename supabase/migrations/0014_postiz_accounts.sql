-- Multi-Postiz accounts: support N Postiz instances per workspace.
--
-- Why: user has 2 Postiz Cloud subscriptions (one per IG-set personas, one per
-- TikTok-set personas). Sebelumnya cuma 1 endpoint per workspace, jadi channels
-- dari Postiz #2 gak ke-detect.
--
-- After this migration: each Postiz endpoint = 1 row di postiz_accounts.
-- Personas link to (account_id, channel_id) pair. scheduled_posts juga catat
-- account_id supaya post route tau creds mana yang dipakai per row.
--
-- Backfill: workspaces yang udah punya postiz_url/postiz_key di-migrate jadi
-- 1 row 'Default' di postiz_accounts. Personas existing di-link ke account itu.

create table if not exists public.postiz_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null default 'Postiz',
  url text not null,
  api_key text not null,
  created_at timestamptz default now()
);

create index if not exists postiz_accounts_workspace_idx on public.postiz_accounts(workspace_id);

alter table public.postiz_accounts enable row level security;

drop policy if exists "PostizAcc: members can view" on public.postiz_accounts;
create policy "PostizAcc: members can view"
  on public.postiz_accounts for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "PostizAcc: members can manage" on public.postiz_accounts;
create policy "PostizAcc: members can manage"
  on public.postiz_accounts for all
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

-- Personas: link to a specific Postiz account (which determines creds when posting).
alter table public.personas
  add column if not exists postiz_account_id uuid references public.postiz_accounts(id) on delete set null;

-- Scheduled posts: per-row override (mirror upload to channels from different accounts).
alter table public.scheduled_posts
  add column if not exists target_postiz_account_id uuid references public.postiz_accounts(id) on delete set null;

-- Backfill #1: convert existing workspace.postiz_url + postiz_key into a single
-- 'Default' postiz_accounts row. Only if not already migrated (no rows yet).
insert into public.postiz_accounts (workspace_id, label, url, api_key)
select w.id, 'Default', w.postiz_url, w.postiz_key
from public.workspaces w
where w.postiz_url is not null
  and w.postiz_key is not null
  and w.postiz_url <> ''
  and w.postiz_key <> ''
  and not exists (select 1 from public.postiz_accounts pa where pa.workspace_id = w.id);

-- Backfill #2: existing personas with postiz_channel_id link to the workspace's
-- default account (the one we just inserted).
update public.personas p
set postiz_account_id = (
  select pa.id from public.postiz_accounts pa
  where pa.workspace_id = p.workspace_id
  order by pa.created_at asc
  limit 1
)
where p.postiz_channel_id is not null
  and p.postiz_account_id is null;
