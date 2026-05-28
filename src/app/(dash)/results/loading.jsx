export default function ResultsLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-32 bg-[var(--surface2)] rounded mb-4" />
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="aspect-[9/16] bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        ))}
      </div>
    </div>
  )
}
