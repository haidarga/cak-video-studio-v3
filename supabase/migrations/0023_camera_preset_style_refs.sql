-- Camera presets: attach style reference images per preset.
--
-- Why: previously style references were only a global, ad-hoc upload section
-- in the Generate UI. Users wanted style refs to be a property of a preset
-- itself — so picking "Pixar-style 3D (AceKid)" automatically pulls in the
-- mood-board images saved on that preset, without having to re-upload every
-- session.
--
-- Storage: image URLs (public Supabase Storage) inside a jsonb array. We
-- don't store binary in the DB; uploads go to the `refs` bucket under
-- `${workspaceId}/preset-style-{preset_key}-{ts}.{ext}` and only the public
-- URL is persisted here.

alter table public.camera_presets
  add column if not exists style_ref_urls jsonb not null default '[]';
