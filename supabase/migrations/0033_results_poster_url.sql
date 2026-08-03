-- Give video results a cheap poster image so grids stop mounting <video> elements.
--
-- THE PROBLEM: /qc renders up to 300 cards, and every video card mounts a real
-- <video>. Chrome caps how many media elements can be active at once (~75), so
-- past that limit videos silently never load — which reads to the user as
-- "preview lama banget" or a black card that never fills in. Even below the cap,
-- LazyVideo escalates to preload="auto" within 200px of the viewport, so a
-- 5-across grid buffers ~15 full videos at a time just from scrolling.
--
-- The fix is to render an <img> by default and only mount a <video> on
-- interaction. That needs a poster URL the grid query can afford to select.
--
-- The data already exists — generate stores the source image in
-- meta.image_url — but /qc deliberately does NOT select `meta` (it's a fat jsonb
-- carrying clip arrays and cloned-audio URLs, 300 rows of it). A narrow text
-- column is cheap to select alongside the rest.

alter table public.results add column if not exists poster_url text;

-- Backfill: for i2v generations the source image IS frame 0, so it is a
-- perfect poster. Rows without one (t2v, uploads, editor exports) stay null and
-- fall back to preload="none" — still better than the old preload="auto".
update public.results
set poster_url = meta->>'image_url'
where poster_url is null
  and type = 'video'
  and meta->>'image_url' is not null;

comment on column public.results.poster_url is
  'Preview image for a video result, so grids can render <img> instead of mounting a <video>. Usually the source image the video was generated from (= frame 0). Null is fine — the UI falls back to a non-preloading video element.';
