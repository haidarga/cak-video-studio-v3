-- Raise upload file size limit on the 'refs' bucket so users can upload
-- externally-edited videos via QC's "+ Upload External Video".
-- Default Supabase limit is ~50MB which is too small for ad videos.

update storage.buckets
set file_size_limit = 200 * 1024 * 1024,  -- 200MB
    allowed_mime_types = null              -- accept all (image/* and video/*)
where id = 'refs';
