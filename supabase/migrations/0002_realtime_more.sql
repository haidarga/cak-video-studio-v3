-- Enable realtime for the rest of the workspace-scoped tables so the client
-- can subscribe to inserts/updates/deletes (Brands CRUD page, etc).
alter publication supabase_realtime add table public.brands;
alter publication supabase_realtime add table public.refs;
alter publication supabase_realtime add table public.personas;
alter publication supabase_realtime add table public.persona_refs;
alter publication supabase_realtime add table public.templates;
