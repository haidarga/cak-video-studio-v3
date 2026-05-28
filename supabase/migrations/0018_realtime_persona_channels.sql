-- Add persona_channels + postiz_accounts to the supabase_realtime publication
-- so Supabase realtime fires INSERT/UPDATE/DELETE events. Without these, the
-- PostingClient realtime sub never receives change notifications and the UI
-- only updates via optimistic patching (which works, but cross-tab sync fails).
--
-- Safe re-run: catches the 'relation already in publication' duplicate error.

do $$
begin
  begin
    alter publication supabase_realtime add table public.persona_channels;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.postiz_accounts;
  exception when duplicate_object then null;
  end;
end $$;
