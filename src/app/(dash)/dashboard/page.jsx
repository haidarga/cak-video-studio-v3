import { createClient } from '@/lib/supabase/server'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Counts (RLS scopes to the user's workspaces automatically)
  const [{ count: nPersonas }, { count: nRefs }, { count: nResults }] = await Promise.all([
    supabase.from('personas').select('*', { count: 'exact', head: true }),
    supabase.from('refs').select('*', { count: 'exact', head: true }),
    supabase.from('results').select('*', { count: 'exact', head: true }),
  ])

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
      <p className="text-sm text-[var(--muted)] mb-6">Halo, {user?.email}</p>
      <div className="grid grid-cols-3 gap-4 max-w-3xl">
        <Card title="Personas" count={nPersonas ?? 0} hint="Belum ada persona" />
        <Card title="Refs" count={nRefs ?? 0} hint="Upload reference image" />
        <Card title="Results" count={nResults ?? 0} hint="Belum ada hasil" />
      </div>
      <div className="mt-10 text-sm text-[var(--muted)] max-w-3xl">
        <p className="font-semibold text-[var(--text)] mb-2">Status: Foundation ready ✓</p>
        <p>Auth + DB jalan. Fitur lain di-migrate dari v2 bertahap:</p>
        <ol className="list-decimal list-inside mt-2 space-y-1 text-xs">
          <li>Brands CRUD (next push)</li>
          <li>Refs + per-product knowledge</li>
          <li>Personas (channel + voice + refs)</li>
          <li>Generate pipeline → kirim job ke worker HF Space</li>
          <li>QC kanban + Postiz scheduling (real-time)</li>
        </ol>
      </div>
    </div>
  )
}

function Card({ title, count, hint }) {
  return (
    <div className="p-5 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
      <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">{title}</div>
      <div className="text-3xl font-bold mt-1">{count}</div>
      <div className="text-xs text-[var(--muted)] mt-1">{hint}</div>
    </div>
  )
}
