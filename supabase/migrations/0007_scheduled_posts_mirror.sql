-- Mirror upload: 1 result bisa di-post ke banyak channel sekaligus.
-- Tiap channel = scheduled_posts row terpisah dengan target_channel_id +
-- target_platform yang override persona's default channel.

alter table public.scheduled_posts add column if not exists target_channel_id text;
alter table public.scheduled_posts add column if not exists target_platform text;

create index if not exists scheduled_posts_target_channel_idx
  on public.scheduled_posts (target_channel_id);
