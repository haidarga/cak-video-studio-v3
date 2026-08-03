-- Attribute existing studio_jobs to a brand.
--
-- THE BUG: the Studio Inbox only ever filtered by workspace_id, so a batch
-- pushed from Caketing for brand "Acekid" appeared in the Inbox while the active
-- brand was "Golden Rama". Executing it there opened /generate under the wrong
-- brand, whose persona list is filtered by active_brand_id — so the naskah got
-- generated against the wrong brand's personas.
--
-- studio_jobs already HAS brand_id (migration 0029) and the ingest route already
-- tried to populate it by matching the brand_name Caketing sends. That match
-- fails whenever the Caketing batch has no client attached (brand_name comes
-- through as '') or the client name isn't spelled exactly like the Studio brand.
-- Those rows kept brand_id NULL, which is why they leaked across brands.
--
-- Backfill from the persona instead: a persona belongs to exactly one brand, so
-- a naskah mapped to "Fajar Sondang" is unambiguously that persona's brand no
-- matter what the batch's client was called. The ingest route now applies the
-- same fallback for new pushes.

update public.studio_jobs sj
set brand_id = p.brand_id
from public.personas p
where sj.brand_id is null
  and p.id = (sj.persona_mapping->>'studio_persona_id')::uuid
  and p.brand_id is not null
  and p.workspace_id = sj.workspace_id;

-- Second pass for rows whose persona never got mapped: fall back to matching
-- brand_name against the brands table (case/whitespace-insensitive), which the
-- ingest route does exactly.
update public.studio_jobs sj
set brand_id = b.id
from public.brands b
where sj.brand_id is null
  and sj.brand_name is not null
  and b.workspace_id = sj.workspace_id
  and lower(btrim(b.name)) = lower(btrim(sj.brand_name));

-- The Inbox now filters on (workspace_id, brand_id).
create index if not exists studio_jobs_workspace_brand_idx
  on public.studio_jobs (workspace_id, brand_id, created_at desc);
