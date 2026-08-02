-- Fix: posts landing on the WRONG persona's channel + posts that silently never publish.
--
-- 1) `target_channel_label` was written by the UI (ScheduledClient) and read by
--    /api/postiz/post, but NO migration ever created it. Depending on whether
--    the column was hand-patched in this environment, that produced either:
--      - insert error → the scheduled_posts row is never created → "gak mau ngepost"
--      - column present but NULL → channelLabel is null → the wrong-account guard
--        in resolveChannelBinding is skipped → Ben's post publishes on Rio.
--
-- 2) `updated_at` did not exist, so a stuck row could not be aged safely. The
--    reconcile sweeper needs it to tell "in-flight right now" from "dead 20
--    minutes ago" — without it, hitting Retry on an old row would get that row
--    immediately swept as stale (created_at is old even on a fresh attempt).

alter table public.scheduled_posts add column if not exists target_channel_label text;
alter table public.scheduled_posts add column if not exists updated_at timestamptz not null default now();

-- set_updated_at() is defined in 0001_init.sql
drop trigger if exists scheduled_posts_updated_at on public.scheduled_posts;
create trigger scheduled_posts_updated_at before update on public.scheduled_posts
  for each row execute function set_updated_at();

-- Backfill labels for existing mirror rows from the persona↔channel links.
--
-- MUST be scoped by persona_id, not channel_id alone. persona_channels is
-- unique on (persona_id, channel_id) — NOT globally on channel_id — so after a
-- drift incident two personas can legitimately hold the same channel_id with
-- DIFFERENT labels ("Ben Official" vs "Rio ..."). An UPDATE ... FROM with
-- multiple matching source rows picks an arbitrary one, which would stamp the
-- wrong persona's label onto the row. resolveChannelBinding would then read that
-- wrong label, see a "wrong account", and heal the post ONTO the other persona's
-- channel — reintroducing the exact bug this migration exists to fix.
-- Joining on persona_id too makes the match unique by construction.
update public.scheduled_posts sp
set target_channel_label = pc.channel_label
from public.persona_channels pc
where sp.target_channel_label is null
  and sp.target_channel_id is not null
  and pc.persona_id = sp.persona_id
  and pc.channel_id = sp.target_channel_id
  and pc.channel_label is not null;

-- Sweeper scans by (status, updated_at); keep it off a seq scan.
create index if not exists scheduled_posts_status_updated_idx
  on public.scheduled_posts (status, updated_at);
