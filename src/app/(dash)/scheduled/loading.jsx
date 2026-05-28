export default function ScheduledLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-40 bg-[var(--surface2)] rounded mb-4" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        ))}
      </div>
    </div>
  )
}
