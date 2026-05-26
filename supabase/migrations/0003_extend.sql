-- Extend personas with the fields needed by the rich Persona Editor.
alter table public.personas add column if not exists username text;
alter table public.personas add column if not exists age int;
alter table public.personas add column if not exists emotional_angle text;
alter table public.personas add column if not exists character_prompt text;
alter table public.personas add column if not exists avatar_url text;

-- Mark a single brand as "active" per workspace (drives generate defaults).
alter table public.workspaces add column if not exists active_brand_id uuid
  references public.brands(id) on delete set null;

-- Storage bucket for uploaded reference / avatar images.
insert into storage.buckets (id, name, public)
values ('refs', 'refs', true)
on conflict (id) do nothing;

-- Open RLS for the bucket (any authenticated user can upload/read/delete).
-- Tighten with workspace-path scoping later.
drop policy if exists "refs upload" on storage.objects;
drop policy if exists "refs read"   on storage.objects;
drop policy if exists "refs delete" on storage.objects;
create policy "refs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'refs');
create policy "refs read"   on storage.objects for select to authenticated
  using (bucket_id = 'refs');
create policy "refs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'refs');
