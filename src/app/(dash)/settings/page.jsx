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

  // Never send raw keys to the client — only booleans for which keys are set.
  const status = {
    has_fal: !!ws.fal_key,
    has_gemini: !!ws.gemini_key,
    has_postiz: !!(ws.postiz_url && ws.postiz_key),
    has_elevenlabs: !!ws.elevenlabs_key,
    postiz_url: ws.postiz_url || '',
    workspace_name: ws.name,
  }
  return <SettingsClient initialStatus={status} />
}
