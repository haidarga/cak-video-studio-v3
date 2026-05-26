import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import SignOutButton from './_components/SignOutButton'

export default async function DashLayout({ children }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get user's workspaces (joined via workspace_members)
  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })

  let activeWs = memberships?.[0]?.workspaces

  // Bootstrap: if user has no workspace yet, auto-create one.
  // The DB trigger `workspace_owner_member` adds them as owner-member automatically.
  if (!activeWs) {
    const { data: ws, error } = await supabase
      .from('workspaces')
      .insert({ name: 'My Workspace', owner_id: user.id })
      .select('id, name')
      .single()
    if (error) {
      // Surface schema-not-yet-applied state gracefully
      return (
        <div className="p-8">
          <h1 className="text-xl font-bold mb-2">Setup belum kelar</h1>
          <p className="text-sm text-[var(--muted)]">
            DB schema belum di-apply. Paste <code>supabase/migrations/0001_init.sql</code> ke
            Supabase SQL Editor lalu refresh.
          </p>
          <pre className="mt-4 text-xs text-red-400 whitespace-pre-wrap">{error.message}</pre>
        </div>
      )
    }
    activeWs = ws
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-1">
        <div className="mb-4">
          <div className="text-sm font-bold">CAK Video</div>
          <div className="text-xs text-[var(--muted)] truncate">{activeWs?.name}</div>
        </div>
        <NavLink href="/dashboard" label="📊 Dashboard" />
        <NavLink href="/personas" label="🎭 Personas" />
        <NavLink href="/brands" label="🏷 Brands" />
        <NavLink href="/refs" label="🖼 References" />
        <NavLink href="/generate" label="⚡ Generate" />
        <NavLink href="/qc" label="🧪 QC" />
        <NavLink href="/results" label="📁 Results" />
        <NavLink href="/scheduled" label="📅 Scheduled" />
        <div className="mt-auto pt-4 border-t border-[var(--border)] text-xs text-[var(--muted)]">
          <div className="mb-2 truncate">{user.email}</div>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto">{children}</main>
    </div>
  )
}

function NavLink({ href, label }) {
  return (
    <Link href={href} className="block px-3 py-2 rounded text-sm hover:bg-[var(--surface2)]">
      {label}
    </Link>
  )
}
