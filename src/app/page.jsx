import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// Belt-and-suspenders: middleware also handles this, but if env vars are missing
// or middleware silently fails the user would just see a blank screen — render
// a clear diagnostic here instead.
export default async function Home() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    return (
      <ErrorView
        title="Env vars Supabase belum di-set"
        body={
          <>
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> dan <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{' '}
            di Vercel project → <strong>Settings → Environment Variables</strong>, terus{' '}
            <strong>redeploy</strong>.
          </>
        }
      />
    )
  }

  let user = null
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch (e) {
    return (
      <ErrorView
        title="Supabase connection error"
        body={
          <>
            <code className="text-red-400 break-all">{String(e?.message || e)}</code>
            <div className="mt-2 text-xs">
              Cek env vars (URL + anon key) di Vercel — pastiin gak ke-typo.
            </div>
          </>
        }
      />
    )
  }

  redirect(user ? '/dashboard' : '/login')
}

function ErrorView({ title, body }) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3 bg-[var(--surface)] p-7 rounded-xl border border-[var(--border)]">
        <div className="text-3xl">⚠️</div>
        <h1 className="text-lg font-bold">{title}</h1>
        <div className="text-sm text-[var(--muted)] space-y-2 text-left">{body}</div>
      </div>
    </main>
  )
}
