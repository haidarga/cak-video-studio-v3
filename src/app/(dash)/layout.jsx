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
import NavLink from './_components/NavLink'

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
      {/* Brand header — gradient text + subtle workspace label */}
      <div className="mb-3 pb-3 border-b border-[var(--border)]">
        <div className="text-base font-extrabold tracking-tight gradient-text-strong">CAK Video</div>
        <div className="text-[10px] text-[var(--muted)] truncate uppercase font-semibold tracking-wider mt-0.5">
          {activeWs?.name}
        </div>
      </div>
      <div className="mb-3">
        <ActiveBrandWidget workspaceId={activeWs.id} activeBrandId={activeWs.active_brand_id} brands={brands || []} />
      </div>
      <div className="mb-3"><CostWidget workspaceId={activeWs.id} /></div>
      <div className="mb-4"><OnboardingChecklist /></div>
      <NavLink href="/generate" label="⚡ Generate" />
      <NavLink href="/god-mode" label="🔥 God Mode" highlight />
      <NavLink href="/qc" label="🧪 QC" />
      <NavLink href="/editor" label="✂️ Editor" />
      <NavLink href="/scheduled" label="📅 Scheduled" />
      <NavLink href="/posting" label="📮 Posting" />
      <NavLink href="/dashboard" label="📊 Dashboard" />
      <NavLink href="/errors" label="🚨 Errors" />
      <NavLink href="/team" label="👥 Team" />
      <div className="text-[9px] uppercase text-[var(--muted2)] font-bold tracking-[0.18em] mt-5 mb-2 px-3 flex items-center gap-1.5">
        <span className="block w-1 h-3 bg-gradient-to-b from-[var(--purple)] to-[var(--magenta)] rounded-sm shadow-[0_0_6px_var(--accent-glow)]"></span>Library</div>
      <NavLink href="/brands" label="🏷 Brands" />
      <NavLink href="/personas" label="🎭 Personas" />
      <NavLink href="/refs" label="🖼 References" />
      <div className="text-[9px] uppercase text-[var(--muted2)] font-bold tracking-[0.18em] mt-5 mb-2 px-3 flex items-center gap-1.5">
        <span className="block w-1 h-3 bg-gradient-to-b from-[var(--purple)] to-[var(--magenta)] rounded-sm shadow-[0_0_6px_var(--accent-glow)]"></span>Legacy</div>
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
      {/* Sidebar: frosted glass over the cosmic background + neon inner edge
          on the content side — reads as a floating HUD panel (web3 refs). */}
      <aside className="hidden md:flex w-56 glass p-4 flex-col gap-1 border-r-0"
        style={{ boxShadow: 'inset -1px 0 0 rgba(168,85,247,0.22), 8px 0 32px rgba(0,0,0,0.35)' }}>
        {sidebarContent}
      </aside>
      {/* Main: dome-glow = luminous purple horizon rising behind every page
          header (Fintech ref); cyber-grid = faint masked perspective grid.
          Both static pseudo-layers — zero per-frame cost. */}
      <main className="flex-1 p-4 md:p-8 overflow-y-auto pt-16 md:pt-8 dome-glow cyber-grid">{children}</main>
      <GlobalSearch workspaceId={activeWs.id} />
      <HelpModal />
    </div>
  )
}

// NavLink moved to ./_components/NavLink.jsx (client component with
// usePathname for auto-active-state detection).
