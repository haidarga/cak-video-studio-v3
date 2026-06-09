-- TikTok: send as draft (UPLOAD mode) so user can pick music + finalize
-- in the TikTok app, instead of DIRECT_POST which publishes immediately
-- with no music control.
--
-- autoAddMusic for video posts is unreliable on TikTok's side (Postiz docs
-- explicitly call it "especially popular for image and photo carousel
-- posts"). UPLOAD mode = video lands in TikTok's draft inbox; user opens
-- the app, picks any trending sound, then publishes. This is the most
-- reliable way to get music on a scheduled video.
--
-- Default false = keep current DIRECT_POST behavior (no breaking change).

alter table public.workspaces
  add column if not exists tiktok_send_as_draft boolean not null default false;
