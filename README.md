# CAK Video Studio v3

Multi-user, real-time AI video production platform for creator teams.
**Frontend on Vercel** (this repo) + **worker on HF Space** (legacy v2 repo, render/ffmpeg).

## Status
Foundation only. Auth + DB schema + dashboard shell.
Feature migration from v2 happens in follow-up commits.

## Stack
- Next.js 14 (App Router, JavaScript) + Tailwind
- Supabase (Postgres + Auth + Realtime + RLS)
- Heavy compute (Remotion render, ffmpeg) → kept on HF Space worker

## Setup

### 1. Apply DB schema
1. Open your Supabase project → **SQL Editor** → New query
2. Paste **`supabase/migrations/0001_init.sql`** → Run
3. Verify: Table Editor should show `workspaces`, `personas`, `refs`, `brands`, `results`, `jobs`, `scheduled_posts`, etc.

### 2. Local dev
```bash
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
npm install
npm run dev
```
Open <http://localhost:3000> → sign up → dashboard.

### 3. Deploy to Vercel
1. **Import** this repo on vercel.com
2. **Environment Variables** (Production + Preview):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` *(server-only, NEVER expose)*
   - `POSTIZ_API_URL`, `POSTIZ_API_KEY`
   - `FAL_KEY`, `GEMINI_KEY`
   - `WORKER_URL` (HF Space URL)
3. Deploy.

## Roadmap
1. ✅ Foundation: Auth, schema, dashboard shell
2. Brands CRUD (next)
3. Refs + per-product knowledge
4. Personas (channel + voice + refs binding)
5. Generate pipeline → push job to worker (HF Space)
6. Realtime QC kanban + Postiz post-now / schedule
