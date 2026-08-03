-- Kill duplicate `results` rows at the database level.
--
-- THE BUG: a user re-generates a shot because the first gen appears stuck (it
-- had actually finished on fal — see the webhook dead-end in 0033). Both jobs
-- eventually land, each running its own unguarded .insert(), and the user ends
-- up with two assets ("current + last"). There are EIGHT separate insert sites
-- across the app and `results` had no unique constraint, no upsert, and no way
-- to correlate a row back to the fal job that produced it.
--
-- Stamping the fal request_id makes ingestion idempotent: re-ingesting the same
-- job now violates the index instead of silently creating a twin.
--
-- The index is PARTIAL (where request_id is not null) on purpose. Plenty of
-- legitimate rows have no fal job behind them — QC voice-swap re-uploads, editor
-- exports, manual uploads. Those keep request_id NULL and are unaffected.
-- (Postgres treats NULLs as distinct anyway, but the partial index also keeps
-- it small and makes the intent explicit.)

alter table public.results add column if not exists request_id text;

-- Scoped to workspace: request_ids come from fal and are globally unique in
-- practice, but scoping keeps the constraint meaningful under multi-tenancy and
-- matches how every other index on this table is built.
create unique index if not exists results_workspace_request_uidx
  on public.results (workspace_id, request_id)
  where request_id is not null;

comment on column public.results.request_id is
  'fal.ai request_id that produced this asset. NULL for rows with no fal job behind them (QC voice-swap, editor export, manual upload). Unique per workspace when set — this is what makes result ingestion idempotent.';
