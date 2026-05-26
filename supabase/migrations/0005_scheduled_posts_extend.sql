-- Extend scheduled_posts so we can track Postiz API responses.
alter table public.scheduled_posts add column if not exists error text;
alter table public.scheduled_posts add column if not exists external_id text;
alter table public.scheduled_posts add column if not exists external_response jsonb;
alter table public.scheduled_posts add column if not exists posted_at timestamptz;
