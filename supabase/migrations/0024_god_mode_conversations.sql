-- GOD MODE chat history. Each row = one conversation thread per user, holds
-- the full message array as JSONB so the chat UI can resume mid-conversation
-- across reloads + show history list.
--
-- Why JSONB instead of separate messages table:
--   - Reads are always "load entire conversation" (no message-level queries)
--   - Append-on-write is rare-spread (one user, few writes per minute)
--   - Avoids a join per chat load — single SELECT delivers entire thread
--   - Backup/export is trivial (one row = one full thread)
--
-- title is auto-derived from first user message (truncated). Updated by the
-- /api/god-mode/conversations endpoint when the thread is first saved.

create table if not exists public.god_mode_conversations (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  title text not null default 'New conversation',
  -- [{role: 'user'|'assistant', content: string, tool?: string,
  --   toolResult?: jsonb, attachments?: [{type, url, name}], at: number}]
  messages jsonb not null default '[]'::jsonb,
  message_count int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_god_mode_conversations_workspace
  on public.god_mode_conversations(workspace_id, updated_at desc);
create index if not exists idx_god_mode_conversations_user
  on public.god_mode_conversations(user_id, updated_at desc);

-- Auto-update updated_at on row modification.
create or replace function public.god_mode_conversations_touch()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tg_god_mode_conversations_touch on public.god_mode_conversations;
create trigger tg_god_mode_conversations_touch
  before update on public.god_mode_conversations
  for each row execute function public.god_mode_conversations_touch();

-- RLS — user can only access their own conversations within their workspace.
alter table public.god_mode_conversations enable row level security;

drop policy if exists "user owns conversations" on public.god_mode_conversations;
create policy "user owns conversations"
  on public.god_mode_conversations
  for all
  using (
    user_id = auth.uid()
    and workspace_id in (
      select workspace_id from public.workspace_members where user_id = auth.uid()
    )
  )
  with check (
    user_id = auth.uid()
    and workspace_id in (
      select workspace_id from public.workspace_members where user_id = auth.uid()
    )
  );
