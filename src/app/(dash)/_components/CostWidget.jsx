'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtCost } from '@/lib/cost-table'

// Sidebar widget: today / month spend. Realtime update via Supabase channel.
// Click expands to detail breakdown by kind.
export default function CostWidget({ workspaceId }) {
  const supabase = createClient()
  const [today, setToday] = useState(0)
  const [month, setMonth] = useState(0)
  const [budget, setBudget] = useState({ daily_limit_usd: 50, monthly_limit_usd: 500, alert_at_pct: 80 })
  const [expanded, setExpanded] = useState(false)
  const [byKind, setByKind] = useState({})

  async function loadAggregates() {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: monthRows } = await supabase
      .from('usage_log')
      .select('kind, cost_usd, created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', startOfMonth)
      .limit(5000)
    const m = (monthRows || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0)
    const t = (monthRows || [])
      .filter((r) => r.created_at >= startOfDay)
      .reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0)
    const byK = (monthRows || []).reduce((acc, r) => {
      acc[r.kind] = (acc[r.kind] || 0) + parseFloat(r.cost_usd || 0)
      return acc
    }, {})
    setToday(t); setMonth(m); setByKind(byK)
    const { data: b } = await supabase.from('budget_settings').select('*').eq('workspace_id', workspaceId).maybeSingle()
    if (b) setBudget(b)
  }

  useEffect(() => {
    if (!workspaceId) return
    loadAggregates()
    const ch = supabase.channel('cost-' + workspaceId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'usage_log', filter: `workspace_id=eq.${workspaceId}` }, () => {
        loadAggregates()
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const dailyPct = budget.daily_limit_usd > 0 ? (today / budget.daily_limit_usd) * 100 : 0
  const monthlyPct = budget.monthly_limit_usd > 0 ? (month / budget.monthly_limit_usd) * 100 : 0
  const alarmDaily = dailyPct >= budget.alert_at_pct
  const alarmMonthly = monthlyPct >= budget.alert_at_pct

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded p-2 text-xs">
      <button onClick={() => setExpanded((s) => !s)} className="w-full text-left">
        <div className="text-[9px] uppercase font-semibold text-[var(--muted)] flex items-center justify-between">
          💸 Usage <span className="text-[var(--muted2)]">{expanded ? '▲' : '▼'}</span>
        </div>
        <div className="mt-1.5 space-y-1">
          <div className={`flex items-center justify-between ${alarmDaily ? 'text-orange-400' : 'text-[var(--text)]'}`}>
            <span className="text-[10px]">Today</span>
            <span className="font-bold">{fmtCost(today)}</span>
          </div>
          <div className="h-1 bg-[var(--surface2)] rounded overflow-hidden">
            <div className={`h-full ${alarmDaily ? 'bg-orange-400' : 'bg-green-500'}`} style={{ width: `${Math.min(100, dailyPct)}%` }} />
          </div>
          <div className={`flex items-center justify-between ${alarmMonthly ? 'text-orange-400' : 'text-[var(--text)]'}`}>
            <span className="text-[10px]">Month</span>
            <span className="font-bold">{fmtCost(month)}</span>
          </div>
          <div className="h-1 bg-[var(--surface2)] rounded overflow-hidden">
            <div className={`h-full ${alarmMonthly ? 'bg-orange-400' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, monthlyPct)}%` }} />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1">
          <div className="text-[9px] text-[var(--muted)] uppercase font-semibold">Breakdown bulan ini</div>
          {Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([kind, cost]) => (
            <div key={kind} className="flex justify-between text-[10px]">
              <span className="text-[var(--muted)]">{kind.replace(/_/g, ' ')}</span>
              <span className="font-mono">{fmtCost(cost)}</span>
            </div>
          ))}
          <div className="text-[9px] text-[var(--muted2)] mt-2">
            Budget: {fmtCost(budget.daily_limit_usd)}/day · {fmtCost(budget.monthly_limit_usd)}/mo
          </div>
          <a href="/dashboard" className="block text-[10px] text-[var(--accent)] hover:underline mt-1">View full dashboard →</a>
        </div>
      )}

      {(alarmDaily || alarmMonthly) && !expanded && (
        <div className="text-[9px] text-orange-400 mt-1">⚠ {alarmDaily ? 'Daily' : 'Monthly'} budget {(alarmDaily ? dailyPct : monthlyPct).toFixed(0)}%</div>
      )}
    </div>
  )
}
