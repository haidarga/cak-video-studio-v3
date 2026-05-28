-- Perf indexes for hot query paths.
--
-- Before this migration the platform was running sequential scans for the
-- workspace-scoped lists shown in QC, Editor, Personas, Results, Scheduled.
-- Index naming convention: `<table>_<col1>_<col2>_idx`. All include workspace_id
-- as the leftmost column so Postgres can use them for the common
-- WHERE workspace_id = ... ORDER BY created_at DESC pattern.

-- Results: QC + Editor + /results page all filter by workspace and sort by created.
create index if not exists results_workspace_created_idx
  on public.results (workspace_id, created_at desc);

-- Results QC filter: index on (workspace_id, qc_status) for QC page where
-- qc_status is not null, grouped by status.
create index if not exists results_qc_status_idx
  on public.results (workspace_id, qc_status, created_at desc)
  where qc_status is not null;

-- Personas: listed by workspace + sorted by name (editor) or created_at (qc).
create index if not exists personas_workspace_name_idx
  on public.personas (workspace_id, name);

-- Refs: filter by kind (character / product / brand_logo) per workspace.
create index if not exists refs_workspace_kind_created_idx
  on public.refs (workspace_id, kind, created_at desc);

-- Scheduled posts: filter by status + sorted by scheduled_for.
create index if not exists scheduled_posts_workspace_status_idx
  on public.scheduled_posts (workspace_id, status, scheduled_for desc);

-- Editor projects: list sort by updated_at.
create index if not exists editor_projects_workspace_updated_idx
  on public.editor_projects (workspace_id, updated_at desc);

-- Activity log: dashboard pulls last N for a workspace.
create index if not exists activity_log_workspace_created_idx
  on public.activity_log (workspace_id, created_at desc);

-- Brands: listed by workspace.
create index if not exists brands_workspace_idx
  on public.brands (workspace_id, created_at desc);
