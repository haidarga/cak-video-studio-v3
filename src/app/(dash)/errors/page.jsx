import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ErrorsClient from './_components/ErrorsClient'

export const dynamic = 'force-dynamic'

export default async function ErrorsPage({ searchParams }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: ms } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1)
  const wsId = ms?.[0]?.workspace_id
  if (!wsId) redirect('/dashboard')

  const level = searchParams?.level || 'all'
  const source = searchParams?.source || ''
  let q = supabase.from('error_log').select('*')
    .or(`workspace_id.eq.${wsId},workspace_id.is.null`)
    .order('created_at', { ascending: false })
    .limit(200)
  if (level !== 'all') q = q.eq('level', level)
  if (source) q = q.ilike('source', `%${source}%`)
  const { data: errors } = await q

  return <ErrorsClient initial={errors || []} initialFilters={{ level, source }} />
}
