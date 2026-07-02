-- Add gen_jobs to the supabase_realtime publication.
--
-- ROOT CAUSE of "video gen stuck ~60s then turns out it was already done":
-- falRunOnce() in src/lib/fal-client.js subscribes to postgres_changes on
-- public.gen_jobs to learn the moment a job flips to status='done'. But gen_jobs
-- was NEVER added to the supabase_realtime publication (0001/0002/0018 added
-- jobs, results, personas, persona_channels, ... but not gen_jobs). So the
-- realtime UPDATE event never fired — completion was only ever caught by the 20s
-- fallback poll, making the UI feel stuck for up to a poll interval and tempting
-- the user to re-gen (which then produced a duplicate).
--
-- Safe re-run: catches the 'relation already in publication' duplicate error.

do $$
begin
  begin
    alter publication supabase_realtime add table public.gen_jobs;
  exception when duplicate_object then null;
  end;
end $$;
