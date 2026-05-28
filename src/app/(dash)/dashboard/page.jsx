import { createClient } from '@/lib/supabase/server'
import { fmtCost } from '@/lib/cost-table'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const wsId = ms?.[0]?.workspace_id

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()

  const [
    { count: nPersonas },
    { count: nRefs },
    { count: nResults },
    { count: nApproved },
    { count: nScheduled },
    { data: usageMonth },
    { data: activity },
    { data: errors },
    { data: budgetRow },
  ] = await Promise.all([
    supabase.from('personas').select('*', { count: 'exact', head: true }),
    supabase.from('refs').select('*', { count: 'exact', head: true }),
    supabase.from('results').select('*', { count: 'exact', head: true }),
    supabase.from('results').select('*', { count: 'exact', head: true }).eq('qc_status', 'approved'),
    supabase.from('scheduled_posts').select('*', { count: 'exact', head: true }).eq('status', 'scheduled'),
    wsId ? supabase.from('usage_log').select('kind, cost_usd, created_at').eq('workspace_id', wsId).gte('created_at', monthStart).limit(2000) : Promise.resolve({ data: [] }),
    wsId ? supabase.from('activity_log').select('*').eq('workspace_id', wsId).order('created_at', { ascending: false }).limit(15) : Promise.resolve({ data: [] }),
    wsId ? supabase.from('error_log').select('*').or(`workspace_id.eq.${wsId},workspace_id.is.null`).order('created_at', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
    wsId ? supabase.from('budget_settings').select('*').eq('workspace_id', wsId).maybeSingle() : Promise.resolve({ data: null }),
  ])

  const todayCost = (usageMonth || []).filter((u) => u.created_at >= dayStart).reduce((s, u) => s + parseFloat(u.cost_usd || 0), 0)
  const monthCost = (usageMonth || []).reduce((s, u) => s + parseFloat(u.cost_usd || 0), 0)

  // Spend forecast: extrapolate linearly to end of month
  const daysIn = Math.max(1, Math.ceil((now - new Date(monthStart)) / (24 * 60 * 60 * 1000)))
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const forecastEom = (monthCost / daysIn) * daysInMonth

  // Cost by persona (from result.meta.persona_id if present; otherwise unattributed)
  // For now use aggregate by kind as a simpler breakdown
  const byKind = (usageMonth || []).reduce((acc, u) => {
    acc[u.kind] = (acc[u.kind] || 0) + parseFloat(u.cost_usd || 0)
    return acc
  }, {})

  const monthlyLimit = parseFloat(budgetRow?.monthly_limit_usd ?? 500)
  const dailyLimit = parseFloat(budgetRow?.daily_limit_usd ?? 50)
  const alertPct = parseFloat(budgetRow?.alert_at_pct ?? 80)
  const monthlyPct = monthlyLimit > 0 ? (monthCost / monthlyLimit) * 100 : 0
  const forecastPct = monthlyLimit > 0 ? (forecastEom / monthlyLimit) * 100 : 0
  const overBudget = monthlyLimit > 0 && monthCost >= monthlyLimit
  const forecastOver = monthlyLimit > 0 && forecastEom > monthlyLimit
  const nearAlert = monthlyLimit > 0 && monthlyPct >= alertPct

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">📊 Dashboard</h1>
      <p className="text-sm text-[var(--muted)] mb-6">Halo, {user?.email}</p>

      {/* Budget banner — fires on over-budget OR forecast-over-limit. */}
      {(overBudget || forecastOver || nearAlert) && (
        <div className={`mb-5 p-4 rounded-lg border ${
          overBudget ? 'bg-red-900/30 border-red-700 text-red-200'
          : forecastOver ? 'bg-orange-900/30 border-orange-700 text-orange-200'
          : 'bg-yellow-900/20 border-yellow-700/60 text-yellow-200'
        }`}>
          <div className="font-bold text-sm mb-1">
            {overBudget ? '🛑 Monthly budget habis — API gen di-block'
              : forecastOver ? `📈 Pace lu bakal lewat limit — forecast EOM ${fmtCost(forecastEom)} vs limit ${fmtCost(monthlyLimit)}`
              : `⚠ ${monthlyPct.toFixed(0)}% monthly budget kepakai (alert threshold ${alertPct}%)`}
          </div>
          <div className="text-xs">
            Spend bulan ini <b>{fmtCost(monthCost)}</b> dari limit <b>{fmtCost(monthlyLimit)}</b>
            {' · '}forecast EOM <b>{fmtCost(forecastEom)}</b> ({forecastPct.toFixed(0)}%)
            {' · '}<a href="/settings" className="underline">naikkin limit di Settings</a>
          </div>
        </div>
      )}

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card title="Personas" count={nPersonas ?? 0} icon="🎭" />
        <Card title="References" count={nRefs ?? 0} icon="🖼" />
        <Card title="Results total" count={nResults ?? 0} icon="🎬" sub={`${nApproved ?? 0} approved`} />
        <Card title="Scheduled" count={nScheduled ?? 0} icon="📅" />
      </div>

      {/* Cost overview */}
      <section className="mb-6">
        <h2 className="text-sm font-bold mb-2">💸 Cost</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card title="Today" count={fmtCost(todayCost)} icon="📆" color="text-green-400" />
          <Card title="This month" count={fmtCost(monthCost)} icon="📊" color="text-blue-400" sub={`${daysIn} days in`} />
          <Card title="Forecast EOM" count={fmtCost(forecastEom)} icon="📈" color="text-orange-400" sub={`At current rate × ${daysInMonth} days`} />
        </div>
        {Object.keys(byKind).length > 0 && (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 mt-3">
            <div className="text-[10px] uppercase font-bold text-[var(--muted)] tracking-wider mb-2">Breakdown by kind (this month)</div>
            <div className="space-y-1">
              {Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([kind, cost]) => (
                <div key={kind} className="flex justify-between text-xs">
                  <span className="text-[var(--muted)]">{kind.replace(/_/g, ' ')}</span>
                  <span className="font-mono">{fmtCost(cost)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Activity log */}
      <section className="mb-6">
        <h2 className="text-sm font-bold mb-2">📋 Recent activity</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 max-h-80 overflow-y-auto">
          {(activity || []).length === 0 ? (
            <div className="text-xs text-[var(--muted)]">Belum ada activity ke-log. Action akan auto-log nanti.</div>
          ) : (
            <div className="space-y-1.5">
              {activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="text-[10px] font-mono text-[var(--muted2)]">{new Date(a.created_at).toLocaleString()}</span>
                  <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-[var(--surface2)] text-[var(--muted)]">{a.action}</span>
                  <span className="text-[var(--muted)] flex-1 truncate">{a.summary || a.entity_type || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Errors */}
      <section className="mb-6">
        <h2 className="text-sm font-bold mb-2">🚨 Recent errors {errors?.length ? `(${errors.length})` : ''}</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 max-h-60 overflow-y-auto">
          {(errors || []).length === 0 ? (
            <div className="text-xs text-green-400">✓ Gak ada error ke-log. Smooth.</div>
          ) : (
            <div className="space-y-1.5">
              {errors.map((e) => (
                <div key={e.id} className="text-xs border-l-2 border-red-500/50 pl-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-[var(--muted2)]">{new Date(e.created_at).toLocaleString()}</span>
                    <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${e.level === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>{e.level}</span>
                    <span className="text-[10px] text-[var(--muted)]">{e.source}</span>
                  </div>
                  <div className="text-red-300 mt-0.5 break-all">{e.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function Card({ title, count, icon, sub, color }) {
  return (
    <div className="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
      <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold flex items-center gap-1">
        {icon && <span>{icon}</span>} {title}
      </div>
      <div className={`text-2xl font-bold mt-1 ${color || ''}`}>{count}</div>
      {sub && <div className="text-[10px] text-[var(--muted2)] mt-0.5">{sub}</div>}
    </div>
  )
}
