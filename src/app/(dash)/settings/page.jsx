import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import SettingsClient from './_components/SettingsClient'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, fal_key, gemini_key, postiz_url, postiz_key, elevenlabs_key)')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true }).limit(1)
  const ws = ms?.[0]?.workspaces
  if (!ws) redirect('/dashboard')

  const { data: budget } = await supabase
    .from('budget_settings').select('daily_limit_usd, monthly_limit_usd, alert_at_pct')
    .eq('workspace_id', ws.id).maybeSingle()

  // Never send raw keys to the client — only booleans for which keys are set.
  const status = {
    has_fal: !!ws.fal_key,
    has_gemini: !!ws.gemini_key,
    has_postiz: !!(ws.postiz_url && ws.postiz_key),
    has_elevenlabs: !!ws.elevenlabs_key,
    postiz_url: ws.postiz_url || '',
    workspace_name: ws.name,
  }
  const initialBudget = {
    daily_limit_usd: budget?.daily_limit_usd ?? 50,
    monthly_limit_usd: budget?.monthly_limit_usd ?? 500,
    alert_at_pct: budget?.alert_at_pct ?? 80,
  }
  return <SettingsClient initialStatus={status} initialBudget={initialBudget} />
}
