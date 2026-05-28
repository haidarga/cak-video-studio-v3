import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import SignOutButton from './_components/SignOutButton'
import ActiveBrandWidget from './_components/ActiveBrandWidget'
import CostWidget from './_components/CostWidget'
import OnboardingChecklist from './_components/OnboardingChecklist'
import MobileNav from './_components/MobileNav'
import ThemeToggle from './_components/ThemeToggle'
import GlobalSearch from './_components/GlobalSearch'
import HelpModal from './_components/HelpModal'

export default async function DashLayout({ children }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get user's workspaces (joined via workspace_members)
  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name, active_brand_id)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })

  let activeWs = memberships?.[0]?.workspaces

  // Bootstrap: if user has no workspace yet, auto-create one using the admin
  // client. The RLS-checked client sometimes loses JWT context during Server
  // Component renders, which would make this insert fail with an RLS violation
  // even though the user is signed in. Service-role bypasses RLS; we still set
  // owner_id from the server-verified user.id. The DB trigger
  // `workspace_owner_member` adds them as 'owner' member automatically.
  if (!activeWs) {
    try {
      const admin = createAdminClient()
      const { data: ws, error } = await admin
        .from('workspaces')
        .insert({ name: 'My Workspace', owner_id: user.id })
        .select('id, name')
        .single()
      if (error) throw error
      activeWs = ws
    } catch (e) {
      return (
        <div className="p-8 max-w-xl">
          <h1 className="text-xl font-bold mb-2">Setup belum kelar</h1>
          <p className="text-sm text-[var(--muted)]">
            Gak bisa bikin workspace pertama. Kemungkinan: (1) DB schema belum di-apply
            (paste <code>supabase/migrations/0001_init.sql</code> ke Supabase SQL Editor),
            atau (2) <code>SUPABASE_SERVICE_ROLE_KEY</code> di Vercel env belum di-set / salah.
          </p>
          <pre className="mt-4 text-xs text-red-400 whitespace-pre-wrap">{String(e?.message || e)}</pre>
        </div>
      )
    }
  }

  // Fetch brands for the active workspace (for sidebar widget)
  const { data: brands } = await supabase
    .from('brands').select('id, name').eq('workspace_id', activeWs.id).order('created_at', { ascending: false })

  const sidebarContent = (
    <>
      <div className="mb-3">
        <div className="text-sm font-bold">CAK Video</div>
        <div className="text-xs text-[var(--muted)] truncate">{activeWs?.name}</div>
      </div>
      <div className="mb-3">
        <ActiveBrandWidget workspaceId={activeWs.id} activeBrandId={activeWs.active_brand_id} brands={brands || []} />
      </div>
      <div className="mb-3"><CostWidget workspaceId={activeWs.id} /></div>
      <div className="mb-4"><OnboardingChecklist /></div>
      <NavLink href="/generate" label="⚡ Generate" />
      <NavLink href="/qc" label="🧪 QC" />
      <NavLink href="/editor" label="✂️ Editor" />
      <NavLink href="/scheduled" label="📅 Scheduled" />
      <NavLink href="/posting" label="📮 Posting" />
      <NavLink href="/dashboard" label="📊 Dashboard" />
      <NavLink href="/team" label="👥 Team" />
      <div className="text-[9px] uppercase text-[var(--muted2)] font-bold tracking-wider mt-4 mb-1 px-3">Library</div>
      <NavLink href="/brands" label="🏷 Brands" />
      <NavLink href="/personas" label="🎭 Personas" />
      <NavLink href="/refs" label="🖼 References" />
      <div className="text-[9px] uppercase text-[var(--muted2)] font-bold tracking-wider mt-4 mb-1 px-3">Legacy</div>
      <NavLink href="/studio" label="🎬 Studio v2 (single-mode)" />
      <NavLink href="/results" label="📁 Results (browse all)" />
      <div className="mt-auto pt-4 border-t border-[var(--border)] text-xs text-[var(--muted)]">
        <NavLink href="/settings" label="⚙️ Settings & Keys" />
        <div className="mb-2 mt-2"><ThemeToggle /></div>
        <div className="mb-2 truncate">{user.email}</div>
        <SignOutButton />
      </div>
    </>
  )

  return (
    <div className="min-h-screen flex">
      <MobileNav>{sidebarContent}</MobileNav>
      <aside className="hidden md:flex w-56 border-r border-[var(--border)] bg-[var(--surface)] p-4 flex-col gap-1">
        {sidebarContent}
      </aside>
      <main className="flex-1 p-4 md:p-8 overflow-y-auto pt-16 md:pt-8">{children}</main>
      <GlobalSearch workspaceId={activeWs.id} />
      <HelpModal />
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
