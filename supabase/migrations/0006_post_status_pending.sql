-- Add 'pending' to post_status enum so /scheduled flow can insert pending rows
-- before pushing to Postiz API. Without this, INSERT scheduled_posts dengan
-- status='pending' bakal error: invalid input value for enum post_status.
--
-- Note: ALTER TYPE ADD VALUE jalan di transaction sendiri di Supabase SQL Editor.

alter type post_status add value if not exists 'pending' before 'scheduled';
