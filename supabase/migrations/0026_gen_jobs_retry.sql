-- Variant Forge / mass-gen retry support.
--
-- WHY: gen_jobs rows currently don't store the input payload that was sent
-- to fal.ai. When a gen fails (content checker, network, fal.ai 5xx, etc),
-- there's no way to programmatically retry without the original input.
-- This migration adds:
--   - input jsonb column to store the submit payload for retry
--   - retry_count int to track how many times a job has been retried
--     (prevents infinite loops on persistently-broken inputs)
--   - parent_request_id text to link retry chain back to the original

alter table public.gen_jobs add column if not exists input jsonb;
alter table public.gen_jobs add column if not exists retry_count int default 0;
alter table public.gen_jobs add column if not exists parent_request_id text;

-- Index for "list recent failures in this workspace" queries (the retry UI
-- needs this). Partial index keeps it small — most jobs end up status='done'.
create index if not exists gen_jobs_failed_recent_idx
  on public.gen_jobs (workspace_id, created_at desc)
  where status = 'error';

-- Index for retry-chain lookups: "show me all attempts for this original".
create index if not exists gen_jobs_parent_idx
  on public.gen_jobs (parent_request_id)
  where parent_request_id is not null;
