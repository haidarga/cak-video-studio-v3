-- Workspace-level toggle for TikTok's "auto-add music" feature.
--
-- Postiz forwards a boolean-ish autoAddMusic field to TikTok's Direct
-- Post API. When 'yes', TikTok auto-suggests a trending sound to attach
-- to the post once it lands on the platform (improves discoverability
-- via trending sound boost). Default 'no' = post stays silent / uses
-- whatever audio is baked into the video.
--
-- Stored per workspace so the owner sets it once and every scheduled
-- TikTok post inherits the choice. Per-post override could come later
-- if anyone actually needs it.

alter table public.workspaces
  add column if not exists tiktok_auto_add_music boolean not null default false;
