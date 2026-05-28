-- Persona ↔ Channels (1-to-many).
--
-- User has 2 Postiz instances (IG + TikTok) → 1 persona harusnya bisa link
-- ke channel di kedua-nya (Emma IG + Emma TikTok). Sebelumnya cuma 1 link
-- via personas.postiz_channel_id.
--
-- Backfill: existing single-link di-migrate jadi 1 row di persona_channels
-- dengan is_default=true. Kolom singular di personas tetep ada (legacy fallback
-- + backward compat), tapi UI baru pakai persona_channels.

create table if not exists public.persona_channels (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  postiz_account_id uuid references public.postiz_accounts(id) on delete cascade,
  channel_id text not null,
  channel_label text,
  platform text,
  username text,
  is_default boolean default false,
  created_at timestamptz default now(),
  unique (persona_id, channel_id)
);

create index if not exists persona_channels_persona_idx on public.persona_channels(persona_id);
create index if not exists persona_channels_account_idx on public.persona_channels(postiz_account_id);

alter table public.persona_channels enable row level security;

drop policy if exists "PersonaCh: members can view" on public.persona_channels;
create policy "PersonaCh: members can view"
  on public.persona_channels for select
  using (persona_id in (
    select id from public.personas
    where workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  ));

drop policy if exists "PersonaCh: members can manage" on public.persona_channels;
create policy "PersonaCh: members can manage"
  on public.persona_channels for all
  using (persona_id in (
    select id from public.personas
    where workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  ));

-- Backfill existing single-link → first row, is_default=true
insert into public.persona_channels (persona_id, postiz_account_id, channel_id, channel_label, platform, is_default)
select p.id, p.postiz_account_id, p.postiz_channel_id, p.postiz_channel_label, p.postiz_platform, true
from public.personas p
where p.postiz_channel_id is not null
  and not exists (
    select 1 from public.persona_channels pc
    where pc.persona_id = p.id and pc.channel_id = p.postiz_channel_id
  );
