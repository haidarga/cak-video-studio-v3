// QC grid skeleton — matches the actual layout so the transition from
// skeleton → real cards has zero layout shift.

export default function QCLoading() {
  return (
    <div className="animate-pulse">
      <div className="flex justify-between mb-4">
        <div>
          <div className="h-7 w-24 bg-[var(--surface2)] rounded mb-1" />
          <div className="h-4 w-80 bg-[var(--surface2)] rounded opacity-60" />
        </div>
      </div>
      <div className="flex gap-2 mb-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 w-20 bg-[var(--surface2)] rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i} className="aspect-[9/16] bg-[var(--surface)] border border-[var(--border)] rounded" />
        ))}
      </div>
    </div>
  )
}
