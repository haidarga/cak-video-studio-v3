// Generic loading skeleton — Next.js shows this while a route segment's
// server component is being fetched. Eliminates the blank-page flash that
// makes navigation feel "patah-patah" — user sees structure immediately
// even before data arrives.
//
// Per-route loading.jsx files (qc/, editor/, etc.) can override this with
// route-specific skeletons; this is the dashboard-wide fallback.

export default function DashLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-48 bg-[var(--surface2)] rounded mb-2" />
      <div className="h-4 w-32 bg-[var(--surface2)] rounded mb-6 opacity-60" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        ))}
      </div>
      <div className="space-y-3">
        <div className="h-40 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        <div className="h-40 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
      </div>
    </div>
  )
}
