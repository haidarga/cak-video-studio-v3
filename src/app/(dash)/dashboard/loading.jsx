export default function DashboardLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-48 bg-[var(--surface2)] rounded mb-2" />
      <div className="h-4 w-32 bg-[var(--surface2)] rounded mb-6 opacity-60" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        ))}
      </div>
      <div className="mb-6">
        <div className="h-5 w-20 bg-[var(--surface2)] rounded mb-2" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
          ))}
        </div>
      </div>
      <div className="h-80 bg-[var(--surface)] border border-[var(--border)] rounded-lg mb-4" />
      <div className="h-60 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
    </div>
  )
}
