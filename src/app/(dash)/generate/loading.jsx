export default function GenerateLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-40 bg-[var(--surface2)] rounded mb-4" />
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <div className="h-5 w-32 bg-[var(--surface2)] rounded mb-3" />
        <div className="h-24 bg-[var(--surface2)] rounded mb-2" />
        <div className="h-10 w-32 bg-[var(--surface2)] rounded" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[9/16] bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        ))}
      </div>
    </div>
  )
}
